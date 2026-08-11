import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  browserWSEndpoint,
  buildAiChatRequest,
  readAiChatBrowserState,
  resolveAiChatBrowserStateFile,
  resolveTaskProfile,
  runAiChat,
  stopChrome,
} from '../../skills/ai-chat/scripts/ai-chat/module.mjs';

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

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    return url.href;
  } catch {
    return null;
  }
}

function hasSourceUrl(text, query) {
  const queryUrls = new Set(
    (String(query).match(/https?:\/\/[^\s)\]}>,]+/gi) || []).map(canonicalUrl).filter(Boolean),
  );
  const citations = [...String(text).matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)\]}>,]+)\)/gi)]
    .map(match => canonicalUrl(match[1]))
    .filter(Boolean);
  return citations.some(url => !queryUrls.has(url));
}

function publicResultPath(path) {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

function withTimeout(createOperation, timeoutSeconds, onTimeout, { startImmediately = true } = {}) {
  let timer;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const startTimeout = () => {
    if (timer) return;
    timer = setTimeout(() => {
      rejectTimeout(new Error('Gemini search timed out.'));
      onTimeout?.();
    }, timeoutSeconds * 1000);
  };
  const operation = createOperation(startTimeout);
  if (startImmediately) startTimeout();
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
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
  if (/source URLs/i.test(message)) return 'Gemini search returned no source URLs.';
  if (/cancel/i.test(message)) return 'The Gemini search was cancelled.';
  return 'Gemini search failed.';
}

const BROWSER_START_CHILD_PATH = fileURLToPath(new URL('./browser-start-child.mjs', import.meta.url));
const DEFAULT_BROWSER_START_TIMEOUT_MS = 120000;

export function startChromeWithoutTerminalOutput(options, {
  moduleUrl = import.meta.resolve('@rezkam/browser-tools'),
  signal,
  timeoutMs = DEFAULT_BROWSER_START_TIMEOUT_MS,
  cleanupDeadlineMs = 30000,
} = {}) {
  if (signal?.aborted) {
    const error = new Error('Browser Tools startup was cancelled.');
    error.name = 'AbortError';
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BROWSER_START_CHILD_PATH], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!child.killed) child.kill('SIGTERM');
      child.unref();
      child.channel?.unref();
      reject(error);
    };
    const onAbort = () => {
      const error = new Error('Browser Tools startup was cancelled.');
      error.name = 'AbortError';
      fail(error);
    };
    const timer = setTimeout(() => {
      fail(new Error('Browser Tools startup timed out.'));
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', fail);
    child.once('exit', code => {
      if (!settled) fail(new Error(`Browser Tools startup process exited before returning a result (code ${code ?? 'unknown'}).`));
    });
    child.once('message', message => {
      if (settled) return;
      settled = true;
      cleanup();
      if (message?.ok) {
        resolve(message.result);
        return;
      }
      const error = new Error(message?.error?.message || 'Browser Tools failed to start Chrome.');
      error.name = message?.error?.name || 'Error';
      if (message?.error?.code) error.code = message.error.code;
      reject(error);
    });
    child.send({ moduleUrl, options, cleanupDeadlineMs });
  });
}

let aiChatSearchQueue = Promise.resolve();
let geminiSearchProviderRunsInFlight = 0;

export function hasGeminiSearchProviderRunInFlight() {
  return geminiSearchProviderRunsInFlight > 0;
}

function runtimeAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export async function queryGeminiWithAiChat(prompt, {
  timeoutSeconds = DEFAULT_GEMINI_SEARCH_TIMEOUT_SECONDS,
  run = runAiChat,
  signal,
  onStarted,
} = {}) {
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

  if (signal?.aborted) throw runtimeAbortError('Gemini search was cancelled.');
  const start = async () => {
    if (signal?.aborted) throw runtimeAbortError('Gemini search was cancelled.');
    onStarted?.();
    geminiSearchProviderRunsInFlight += 1;
    try {
      return await run(request, {
        io: {
          stdout() {},
          writeFile() {},
        },
        // AI Chat and Browser Tools progress belongs to this private tool invocation, not pi's terminal renderer.
        logger: { error() {} },
        startChrome: options => startChromeWithoutTerminalOutput(options, { signal }),
      });
    } finally {
      geminiSearchProviderRunsInFlight -= 1;
    }
  };
  const running = aiChatSearchQueue.then(start, start);
  aiChatSearchQueue = running.catch(() => undefined);

  let outcome;
  if (!signal) {
    outcome = await running;
  } else {
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(runtimeAbortError('Gemini search was cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      outcome = await Promise.race([running, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
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
export async function stopOwnedAiChatBrowser({
  browserStateFile,
  readBrowserState = readAiChatBrowserState,
  browserTools = { browserWSEndpoint, stopChrome },
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const stateFile = resolveAiChatBrowserStateFile({}, browserStateFile ? { browserStateFile } : {});
  // Browser Tools starts detached. Give AI Chat a short bounded window to record the owner token.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = readBrowserState(stateFile);
    const port = state?.port;
    const ownerToken = state?.ownerToken;
    if (port && ownerToken && state.status !== 'stopped') {
      const result = browserTools.stopChrome({ port, ownerToken, clean: false });
      if (result?.status === 'stopped' || result?.status === 'already-gone') return true;
      return !(await browserTools.browserWSEndpoint(port));
    }
    if (attempt < 4) await wait(100);
  }
  return false;
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
      const timeoutController = new AbortController();
      const querySignal = params.signal
        ? AbortSignal.any([params.signal, timeoutController.signal])
        : timeoutController.signal;
      const response = await withTimeout(
        startTimeout => queryGemini(buildGeminiSearchPrompt(query), {
          timeoutSeconds,
          signal: querySignal,
          onStarted: startTimeout,
        }),
        timeoutSeconds,
        () => timeoutController.abort(),
        { startImmediately: queryGemini !== queryGeminiWithAiChat },
      );
      if (response.model !== GEMINI_SEARCH_MODEL || response.modelUiVerified !== true || response.temporary !== true) {
        throw new Error('Gemini search result did not satisfy the required UI mode and temporary-mode contract.');
      }
      if (!hasSourceUrl(response.text, query)) {
        throw new Error('Gemini search result did not include source URLs.');
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
      if (/timed out/i.test(message)) {
        for (let skippedIndex = index + 1; skippedIndex < queries.length; skippedIndex += 1) {
          const skippedQuery = queries[skippedIndex];
          const skippedError = 'Skipped after a previous Gemini search timed out.';
          failures.push({ query: skippedQuery, error: skippedError });
          onProgress({
            phase: 'failed',
            index: skippedIndex,
            total: queries.length,
            query: skippedQuery,
            error: skippedError,
          });
        }
        break;
      }
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
