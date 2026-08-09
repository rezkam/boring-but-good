import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { browserWSEndpoint, stopChrome } from '@rezkam/browser-tools';
import { resolveTaskProfile } from '@rezkam/browser-tools';
import { buildAiChatRequest, readAiChatBrowserState, runAiChat } from '../../scripts/ai-chat/module.mjs';

export const GEMINI_SEARCH_MODEL = 'gemini-3.6-flash-extended-thinking';
export const DEFAULT_GEMINI_SEARCH_TIMEOUT_SECONDS = 300;
export const DEFAULT_GEMINI_SEARCH_RESULT_DIR = join(homedir(), '.agents', 'tmp', 'gemini-search');

export function buildGeminiSearchPrompt(query) {
  return [
    'Search the web before answering the query below.',
    'Use current, verifiable sources and cite factual claims with Markdown links to direct source URLs.',
    'Distinguish confirmed facts from uncertainty. Do not omit the source links.',
    '',
    'Query:',
    query,
  ].join('\n');
}

export function normalizeGeminiSearchQueries({ query, queries } = {}) {
  const values = Array.isArray(queries) && queries.length > 0 ? queries : [query];
  const normalized = [];
  const seen = new Set();

  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  if (normalized.length === 0) throw new Error('Provide query or queries with at least one non-empty search query.');
  if (normalized.length > 5) throw new Error('Gemini search accepts at most 5 queries per call.');
  return normalized;
}

async function ensurePrivateResultDirectory(path) {
  let created = false;
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    created = true;
    stats = await lstat(path);
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Gemini search result directory must be a real directory.');
  }
  if ((stats.mode & 0o777) !== 0o700) {
    const action = created ? 'could not be secured' : 'must already use mode 0700';
    throw new Error(`Gemini search result directory ${action}.`);
  }
}

function resultDocument({ query, answer, capturedAt }) {
  return [
    '# Gemini search result',
    '',
    `Captured: ${capturedAt}`,
    `Model mode: ${GEMINI_SEARCH_MODEL} (UI verified)`,
    'History mode: temporary (verified)',
    '',
    '## Query',
    '',
    query,
    '',
    '## Result',
    '',
    answer,
    '',
  ].join('\n');
}

async function writePrivateResult({ resultDir, query, answer, capturedAt }) {
  const path = join(resultDir, `${capturedAt.replaceAll(':', '-')}-${randomUUID()}.md`);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(resultDocument({ query, answer, capturedAt }), 'utf8');
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
    throw new Error('Gemini search result file permission verification failed.');
  }
  return path;
}

function publicResultPath(path) {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

function sanitizeRuntimeError(error) {
  const message = String(error?.message || error || 'Unknown Gemini search failure');
  if (/profile folder not found|browser profile|google cookies/i.test(message)) {
    return 'The configured Gemini browser profile is unavailable. Update the private Browser Tools gemini task profile and retry.';
  }
  if (/auth|sign.?in|consent|session|selector|ui login/i.test(message)) {
    return 'The Gemini browser session is not ready. Refresh the private Browser Tools gemini profile and retry.';
  }
  if (/timed? out|timeout/i.test(message)) return 'The Gemini search timed out.';
  if (/required .*mode|ui mode|did not use/i.test(message)) return `Gemini did not verify the required ${GEMINI_SEARCH_MODEL} mode.`;
  if (/temporary/i.test(message)) return 'Gemini temporary chat mode could not be verified.';
  if (/cancel/i.test(message)) return 'The Gemini search was cancelled.';
  return 'Gemini search failed. Check the local pi logs for private diagnostics.';
}

let quietDepth = 0;
let quietBuffer = '';

export async function withQuietDiagnostics(operation) {
  const original = process.stderr.write;
  if (quietDepth === 0) {
    quietBuffer = '';
    process.stderr.write = chunk => {
      quietBuffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    };
  }
  quietDepth += 1;
  try {
    const value = await operation();
    return { value, diagnostics: quietBuffer };
  } finally {
    quietDepth -= 1;
    if (quietDepth === 0) process.stderr.write = original;
  }
}

export async function queryGeminiWithAiChat(prompt, { timeoutSeconds = DEFAULT_GEMINI_SEARCH_TIMEOUT_SECONDS } = {}) {
  const browserProfileName = process.env.GEMINI_SEARCH_BROWSER_PROFILE || resolveTaskProfile('gemini') || null;
  const request = buildAiChatRequest({
    providerName: 'gemini',
    modelName: GEMINI_SEARCH_MODEL,
    modelExplicit: true,
    prompt,
    browserHeadless: true,
    browserProfileName,
    includeGoogle: true,
    timeoutSeconds,
    timeoutExplicit: true,
    jsonOutput: true,
    providerOptions: {
      incognito: true,
      temporary: true,
      saveToLibrary: false,
      verifySession: true,
    },
  });

  const { value: outcome } = await withQuietDiagnostics(() => runAiChat(request, {
    io: {
      stdout() {},
      writeFile() {},
    },
  }));
  const text = outcome?.result?.text?.trim();
  const model = outcome?.metadata?.model || outcome?.result?.modelUsed || null;
  const temporary = outcome?.metadata?.provider_state?.is_temporary === true;
  const modelUiVerified = outcome?.metadata?.provider_state?.model_ui_verified === true;

  if (!text) throw new Error('Gemini returned an empty search result.');
  if (model !== GEMINI_SEARCH_MODEL) {
    throw new Error(`Gemini did not use the required ${GEMINI_SEARCH_MODEL} model.`);
  }
  if (!modelUiVerified) throw new Error(`Gemini did not verify the required ${GEMINI_SEARCH_MODEL} UI mode.`);
  if (!temporary) throw new Error('Gemini did not verify temporary chat mode.');

  return { text, model, temporary, modelUiVerified };
}

// ai-chat closes its browser at the end of a run, which cannot happen when the host process
// exits mid-search. The recorded owner token is what makes that leftover browser recoverable.
export async function stopOwnedAiChatBrowser() {
  const state = readAiChatBrowserState();
  const port = state?.port;
  const ownerToken = state?.ownerToken;
  if (!port || !ownerToken || state.status === 'stopped') return false;
  if (!(await browserWSEndpoint(port))) return false;
  const result = stopChrome({ port, ownerToken, clean: false });
  return result?.status === 'stopped' || result?.status === 'already-gone';
}

export async function runGeminiSearchBatch(params = {}, deps = {}) {
  const queries = normalizeGeminiSearchQueries(params);
  const resultDir = params.resultDir || DEFAULT_GEMINI_SEARCH_RESULT_DIR;
  const timeoutSeconds = params.timeoutSeconds || DEFAULT_GEMINI_SEARCH_TIMEOUT_SECONDS;
  const queryGemini = deps.queryGemini || queryGeminiWithAiChat;
  const writeResult = deps.writeResult || writePrivateResult;
  const onProgress = deps.onProgress || (() => {});
  try {
    await ensurePrivateResultDirectory(resultDir);
  } catch (error) {
    if (String(error?.message || '').startsWith('Gemini search result directory ')) throw error;
    throw new Error('Gemini search result directory could not be prepared safely.');
  }
  const files = [];
  const failures = [];
  let cancelled = false;

  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    if (params.signal?.aborted) {
      cancelled = true;
      onProgress({ phase: 'cancelled', index, total: queries.length, query });
      break;
    }
    onProgress({ phase: 'searching', index, total: queries.length, query });
    try {
      const response = await queryGemini(buildGeminiSearchPrompt(query), { timeoutSeconds });
      if (response.model !== GEMINI_SEARCH_MODEL || response.modelUiVerified !== true || response.temporary !== true) {
        throw new Error('Gemini search result did not satisfy the required UI mode and temporary-mode contract.');
      }
      const capturedAt = new Date().toISOString();
      const absolutePath = await writeResult({ resultDir, query, answer: response.text, capturedAt });
      const path = publicResultPath(absolutePath);
      files.push({ query, path });
      onProgress({ phase: 'complete', index, total: queries.length, query, path });
    } catch (error) {
      const message = sanitizeRuntimeError(error);
      failures.push({ query, error: message });
      onProgress({ phase: 'failed', index, total: queries.length, query, error: message });
    }
  }

  if (files.length === 0) {
    if (cancelled) {
      const error = new Error('Gemini search was cancelled before a query completed.');
      error.name = 'AbortError';
      throw error;
    }
    throw new Error(`All Gemini searches failed. ${failures.map(item => item.error).join(' ')}`);
  }

  return {
    queryCount: queries.length,
    successfulQueries: files.length,
    failedQueries: failures.length,
    cancelled,
    files,
    failures,
  };
}
