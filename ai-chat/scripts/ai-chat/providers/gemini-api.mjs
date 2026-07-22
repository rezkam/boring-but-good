import { chmodSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const GEMINI_APP_URL = 'https://gemini.google.com/app';
const GEMINI_BATCH_PATH = '/_/BardChatUi/data/batchexecute';
const GEMINI_STREAM_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const GEMINI_USER_STATUS_RPC = 'otAQ7b';
const DEFAULT_METADATA = ['', '', '', null, null, null, null, null, null, ''];

export const GEMINI_MODELS = [
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', model_id: 'fbb127bbb056c959', capacity_tail: 1, capacity_field: 12, min_tier: 'basic', family: 'gemini-3', thinking: false, aliases: ['flash', 'basic-flash', 'quick'], known: true },
  { id: 'gemini-3-flash-thinking', name: 'Gemini 3 Flash Thinking', model_id: '5bf011840784117a', capacity_tail: 1, capacity_field: 12, min_tier: 'basic', family: 'gemini-3', thinking: true, aliases: ['thinking', 'think', 'reasoning', 'basic-thinking'], known: true },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', model_id: '9d8ca3786ebdfbea', capacity_tail: 1, capacity_field: 12, min_tier: 'basic', family: 'gemini-3', thinking: false, aliases: ['pro', 'basic-pro'], known: true },
  { id: 'gemini-3-flash-plus', name: 'Gemini 3 Flash Plus', model_id: '56fdd199312815e2', capacity_tail: 4, capacity_field: 12, min_tier: 'plus', family: 'gemini-3', thinking: false, aliases: ['plus-flash'], known: true },
  { id: 'gemini-3-flash-thinking-plus', name: 'Gemini 3 Flash Thinking Plus', model_id: 'e051ce1aa80aa576', capacity_tail: 4, capacity_field: 12, min_tier: 'plus', family: 'gemini-3', thinking: true, aliases: ['plus-thinking'], known: true },
  { id: 'gemini-3-pro-plus', name: 'Gemini 3 Pro Plus', model_id: '9d8ca3786ebdfbea', capacity_tail: 4, capacity_field: 12, min_tier: 'plus', family: 'gemini-3', thinking: false, aliases: ['plus-pro'], known: true },
  { id: 'gemini-3-flash-advanced', name: 'Gemini 3 Flash Advanced', model_id: '56fdd199312815e2', capacity_tail: 2, capacity_field: 12, min_tier: 'advanced', family: 'gemini-3', thinking: false, aliases: ['advanced-flash'], known: true },
  { id: 'gemini-3-flash-thinking-advanced', name: 'Gemini 3 Flash Thinking Advanced', model_id: 'e051ce1aa80aa576', capacity_tail: 2, capacity_field: 12, min_tier: 'advanced', family: 'gemini-3', thinking: true, aliases: ['advanced-thinking'], known: true },
  { id: 'gemini-3-pro-advanced', name: 'Gemini 3 Pro Advanced', model_id: '9d8ca3786ebdfbea', capacity_tail: 2, capacity_field: 12, min_tier: 'advanced', family: 'gemini-3', thinking: false, aliases: ['advanced-pro'], known: true },
];

const GEMINI_MODEL_BY_SELECTOR = new Map(GEMINI_MODELS.flatMap(model => [
  [model.id.toLowerCase(), model],
  [model.name.toLowerCase(), model],
  ...(model.aliases || []).map(alias => [alias.toLowerCase(), model]),
]));

const GEMINI_MODELS_BY_TRANSPORT_ID = new Map();
for (const model of GEMINI_MODELS) {
  const key = model.model_id.toLowerCase();
  const matches = GEMINI_MODELS_BY_TRANSPORT_ID.get(key) || [];
  matches.push(model);
  GEMINI_MODELS_BY_TRANSPORT_ID.set(key, matches);
}

export function resolveGeminiModel(modelName = 'flash') {
  const normalized = String(modelName || 'flash').toLowerCase();
  const selector = normalized === 'default' ? 'flash' : normalized;
  const transportMatches = GEMINI_MODELS_BY_TRANSPORT_ID.get(selector);
  // Account tiers can share the same transport ID. It does not identify the
  // intended capacity header, so require the explicit public tier selector.
  if (transportMatches) return transportMatches.length === 1 ? transportMatches[0] : null;
  return GEMINI_MODEL_BY_SELECTOR.get(selector) || null;
}

function nested(value, path) {
  let current = value;
  for (const part of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}

function batchParts(rawText) {
  let body = rawText || '';
  if (body.startsWith(")]}'")) body = body.slice(4);
  const parts = [];
  for (const line of body.split('\n')) {
    try {
      const parsed = JSON.parse(line.trim());
      if (!Array.isArray(parsed)) continue;
      for (const part of parsed) if (Array.isArray(part)) parts.push(part);
    } catch {}
  }
  return parts;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function capacity(tierFlags = [], capabilityFlags = []) {
  if (tierFlags.includes(21)) return { capacity: 1, capacity_field: 13 };
  if (tierFlags.includes(22)) return { capacity: 2, capacity_field: 13 };
  if (capabilityFlags.includes(115)) return { capacity: 4, capacity_field: 12 };
  if (tierFlags.includes(16) || capabilityFlags.includes(106)) return { capacity: 3, capacity_field: 12 };
  if (tierFlags.includes(8) || (!capabilityFlags.includes(106) && capabilityFlags.includes(19))) return { capacity: 2, capacity_field: 12 };
  return { capacity: 1, capacity_field: 12 };
}

export function parseGeminiAccountModelsResponse(rawText) {
  const models = [];
  let accountStatusCode = null;
  let tierFlags = [];
  let capabilityFlags = [];

  for (const part of batchParts(rawText)) {
    try {
      const body = JSON.parse(nested(part, [2]));
      const modelList = nested(body, [15]);
      if (!Array.isArray(modelList)) continue;
      accountStatusCode = nested(body, [14]) ?? accountStatusCode;
      tierFlags = Array.isArray(nested(body, [16])) ? nested(body, [16]) : [];
      capabilityFlags = Array.isArray(nested(body, [17])) ? nested(body, [17]) : [];

      for (const modelData of modelList) {
        const modelId = nested(modelData, [0]);
        const displayName = nested(modelData, [1]);
        if (!modelId || !displayName) continue;
        const staticModel = GEMINI_MODELS.find(model => model.model_id === modelId);
        const caps = capacity(tierFlags, capabilityFlags);
        const id = staticModel?.id || `gemini/${String(displayName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'}`;
        models.push({
          ...(staticModel || {}),
          id,
          name: staticModel?.name || displayName,
          display_name: displayName,
          description: nested(modelData, [2]) || '',
          model_id: modelId,
          ...caps,
          capacity_tail: caps.capacity_field === 12 ? caps.capacity : null,
          account_specific: true,
          available: accountStatusCode == null || accountStatusCode === 1000,
          account_status_code: accountStatusCode,
          tier_flags: tierFlags,
          capability_flags: capabilityFlags,
          source: 'gemini-account-rpc',
          thinking: /think|thinking/i.test(`${id} ${displayName}`),
          aliases: uniqueStrings([...(staticModel?.aliases || []), displayName, modelId]),
        });
      }
    } catch {}
  }

  return { models, account_status_code: accountStatusCode, tier_flags: tierFlags, capability_flags: capabilityFlags };
}

export function parseGeminiStreamResponse(rawText) {
  let bestText = '';
  let errorCode;
  let conversationId;
  let responseId;
  let choiceId;
  let metadata;

  for (const part of batchParts(rawText)) {
    const code = nested(part, [5, 2, 0, 1, 0]);
    if (typeof code === 'number' && code >= 0 && !errorCode) errorCode = code;
    try {
      const parsed = JSON.parse(nested(part, [2]));
      const ids = nested(parsed, [1]);
      if (Array.isArray(ids)) {
        metadata = ids;
        conversationId = typeof ids[0] === 'string' ? ids[0] : undefined;
        responseId = typeof ids[1] === 'string' ? ids[1] : undefined;
      }
      for (const candidate of nested(parsed, [4]) || []) {
        if (typeof candidate?.[0] === 'string') choiceId = candidate[0];
        let text = String(nested(candidate, [1, 0]) || '');
        if (/^http:\/\/googleusercontent\.com\/card_content\/\d+/.test(text)) text = nested(candidate, [22, 0]) || text;
        text = String(text).replace(/http:\/\/googleusercontent\.com\/\w+\/\d+\n*/g, '');
        if (text.length > bestText.length) bestText = text;
      }
    } catch {}
  }

  if (Array.isArray(metadata)) {
    const merged = DEFAULT_METADATA.slice();
    metadata.forEach((value, index) => {
      if (index < merged.length && value != null) merged[index] = value;
    });
    if (choiceId) merged[2] = choiceId;
    metadata = merged;
  }
  return { text: bestText, errorCode, conversationId, responseId, choiceId, metadata };
}

export function buildGeminiInnerRequest({ prompt, conversationState = {}, temporary = false, requestUuid = crypto.randomUUID().toUpperCase() }) {
  const list = new Array(69).fill(null);
  list[0] = [prompt, 0, null, null, null, null, 0];
  list[1] = ['en'];
  list[2] = Array.isArray(conversationState.metadata) ? conversationState.metadata : DEFAULT_METADATA;
  list[6] = [1];
  list[7] = 1;
  list[10] = 1;
  list[11] = 0;
  list[17] = [[0]];
  list[18] = 0;
  list[27] = 1;
  list[30] = [4];
  list[41] = [1];
  if (temporary) list[45] = 1;
  list[53] = 0;
  list[59] = requestUuid;
  list[61] = [];
  list[68] = 2;
  return { innerReqList: list, requestUuid, fReq: JSON.stringify([null, JSON.stringify(list)]) };
}

async function pageRequest(page, operation, input, timeoutMs) {
  if (!page) throw new Error('[gemini] Managed browser is required. Start Browser Tools with its standard task profile and sign in at gemini.google.com.');

  const result = await page.evaluate(async ({ operation, input, timeoutMs, appUrl, batchPath, streamPath, rpc }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const safeError = (reason, status = null) => ({ ok: false, reason, status });

    try {
      if (location.hostname !== 'gemini.google.com') return safeError('not_on_gemini_app');

      // Auth cookies and page-scoped request material remain inside this page.
      const app = await fetch(appUrl, { credentials: 'include', signal: controller.signal });
      const html = await app.text();
      const value = key => html.match(new RegExp(`"${key}":"(.*?)"`))?.[1] || '';
      const token = value('SNlM0e') || value('thykhd');
      const bl = value('cfb2h');
      const sid = value('FdrFJe');
      if (!app.ok || !token) return safeError('authentication_required', app.status);

      const params = new URLSearchParams({
        hl: 'en',
        _reqid: String(Math.floor(Math.random() * 90000) + 10000),
        rt: 'c',
      });
      if (bl) params.set('bl', bl);
      if (sid) params.set('f.sid', sid);

      let path;
      let body;
      let headers;
      if (operation === 'models') {
        path = batchPath;
        body = new URLSearchParams({
          at: token,
          'f.req': JSON.stringify([[[rpc, '[]', null, 'generic']]]),
        });
        headers = {
          'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
          'x-same-domain': '1',
          'x-goog-ext-525001261-jspb': '[1,null,null,null,null,null,null,null,[4]]',
          'x-goog-ext-73010989-jspb': '[0]',
        };
      } else {
        path = streamPath;
        body = new URLSearchParams({ at: token, 'f.req': input.fReq });
        const model = input.model;
        const tail = model.capacity_field === 13
          ? `null,${model.capacity ?? 1}`
          : String(model.capacity_tail ?? model.capacity ?? 1);
        const modelHeader = `[1,null,null,null,"${model.model_id}",null,null,0,[4],null,null,${tail}]`;
        headers = {
          'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
          'x-same-domain': '1',
          'x-goog-ext-525001261-jspb': modelHeader,
          'x-goog-ext-73010989-jspb': '[0]',
          'x-goog-ext-73010990-jspb': '[0]',
          'x-goog-ext-525005358-jspb': `["${input.requestUuid}",1]`,
        };
      }

      const response = await fetch(`${path}?${params}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      // Do not return request credentials or response headers across the page boundary.
      return response.ok
        ? { ok: true, status: response.status, body: text }
        : safeError('provider_request_failed', response.status);
    } catch (error) {
      return safeError(error?.name === 'AbortError' ? 'request_timed_out' : 'request_failed');
    } finally {
      clearTimeout(timer);
    }
  }, { operation, input, timeoutMs, appUrl: GEMINI_APP_URL, batchPath: GEMINI_BATCH_PATH, streamPath: GEMINI_STREAM_PATH, rpc: GEMINI_USER_STATUS_RPC });

  if (!result?.ok) {
    const status = result?.status ? ` (status ${result.status})` : '';
    throw new Error(`[gemini] ${result?.reason || 'managed_browser_request_failed'}${status}. Sign in to gemini.google.com in the managed browser and retry.`);
  }
  return result.body;
}

export async function fetchGeminiAccountModels(page, options = {}) {
  const rawText = await pageRequest(page, 'models', {}, options.timeoutMs || 60000);
  return { ...parseGeminiAccountModelsResponse(rawText), rawText };
}

function lstatOrNull(path) {
  try { return lstatSync(path); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function writeRawOutput(rawText) {
  if (!process.env.AI_CHAT_GEMINI_RAW_OUT) return;
  const rawOut = process.env.AI_CHAT_GEMINI_RAW_OUT;
  const rawDir = dirname(rawOut);
  try {
    const directory = lstatOrNull(rawDir);
    if (directory) {
      if (directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o777) !== 0o700) throw new Error('existing parent directory must already have mode 0700 and be a real directory');
    } else {
      mkdirSync(rawDir, { recursive: true, mode: 0o700 });
      const created = lstatOrNull(rawDir);
      if (!created || created.isSymbolicLink() || !created.isDirectory()) throw new Error('new parent directory is not a real directory');
      chmodSync(rawDir, 0o700);
    }
    const existing = lstatOrNull(rawOut);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('refusing to write a symlink or non-file output');
      chmodSync(rawOut, 0o600);
    }
    // lstat above establishes absence or a regular non-symlink before writing.
    writeFileSync(rawOut, rawText, { encoding: 'utf-8', mode: 0o600 });
    const written = lstatOrNull(rawOut);
    if (!written || written.isSymbolicLink() || !written.isFile() || (written.mode & 0o777) !== 0o600) throw new Error('file mode did not persist');
  } catch (error) {
    throw new Error(`Gemini raw output could not be stored with private permissions: ${error.message}`);
  }
}

export async function queryGeminiWeb(page, prompt, options = {}) {
  const modelConfig = options.modelConfig || resolveGeminiModel(options.model || 'flash') || resolveGeminiModel('flash');
  const request = buildGeminiInnerRequest({
    prompt,
    conversationState: options.conversationState || {},
    temporary: options.temporary !== false,
  });
  const rawText = await pageRequest(page, 'prompt', { ...request, model: modelConfig }, options.timeoutMs || 120000);
  writeRawOutput(rawText);
  const result = parseGeminiStreamResponse(rawText);

  if (result.errorCode === 1052 && options.allowModelFallback !== false && modelConfig.id !== 'gemini-3-flash') {
    const fallback = await queryGeminiWeb(page, prompt, { ...options, model: 'gemini-3-flash', modelConfig: null });
    return { ...fallback, modelFallbackFrom: modelConfig.id, modelFallbackReason: 'error_1052' };
  }
  if (!result.text) {
    const error = new Error(result.errorCode ? `Gemini Web returned error ${result.errorCode}` : 'Gemini Web returned empty response');
    error.errorCode = result.errorCode || null;
    error.model = modelConfig.id;
    throw error;
  }
  return {
    text: result.text,
    rawText,
    modelUsed: modelConfig.id,
    errorCode: result.errorCode,
    conversationState: {
      conversation_id: result.conversationId || null,
      response_id: result.responseId || null,
      choice_id: result.choiceId || null,
      metadata: result.metadata || null,
    },
  };
}

export async function checkGeminiUiReady(page, timeoutMs = 30000) {
  if (!page) return { ready: false, reason: 'browser_not_available' };
  try {
    await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return await page.evaluate(() => {
      const promptInput = !!document.querySelector('rich-textarea .ql-editor[contenteditable="true"], div[aria-label="Enter a prompt for Gemini"][contenteditable="true"], div[role="textbox"][contenteditable="true"], textarea[aria-label*="Gemini" i]');
      const signIn = location.hostname === 'accounts.google.com';
      const consent = location.hostname === 'consent.google.com';
      return {
        ready: location.hostname === 'gemini.google.com' && promptInput && !signIn && !consent,
        reason: consent ? 'google_consent_required' : signIn ? 'google_sign_in_required' : promptInput ? 'gemini_app_ready' : 'prompt_input_not_visible',
      };
    });
  } catch {
    return { ready: false, reason: 'ui_check_failed' };
  }
}
