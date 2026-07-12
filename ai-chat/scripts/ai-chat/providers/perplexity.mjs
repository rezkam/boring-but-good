import { randomUUID } from 'node:crypto';
import { Blob } from 'node:buffer';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, urlHasAllowedHostname } from './shared.mjs';

const API_BASE_URL = 'https://www.perplexity.ai';
const PERPLEXITY_HOSTNAMES = ['perplexity.ai', 'www.perplexity.ai'];
const ENDPOINT_ASK = '/rest/sse/perplexity_ask';
const ENDPOINT_SEARCH_INIT = '/search/new';
const ENDPOINT_UPLOAD = '/rest/uploads/batch_create_upload_urls';
const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
const API_VERSION = '2.18';
const MAX_PERPLEXITY_FILES = 30;
const MAX_PERPLEXITY_FILE_SIZE = 50 * 1024 * 1024;
const DEFAULT_PERPLEXITY_UPLOAD_TIMEOUT_MS = 300 * 1000;
const SPACE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PERPLEXITY_MODEL = 'perplexity/best';
export const DEFAULT_PERPLEXITY_DEEP_RESEARCH_TIMEOUT_SECONDS = 3600;
const RAW_MODELS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'perplexity-models.json'), 'utf-8'));
const MODELS = RAW_MODELS.filter(model => model.min_tier !== 'max');
const AUTH_SOURCE_BROWSER_TOOLS = 'Browser Tools Chrome profile';
export const PERPLEXITY_SESSION_LOOKUP_ORDER = [
  { url: API_BASE_URL, source: AUTH_SOURCE_BROWSER_TOOLS, label: 'www.perplexity.ai cookie' },
  { url: 'https://perplexity.ai', source: AUTH_SOURCE_BROWSER_TOOLS, label: 'perplexity.ai cookie' },
];
function isPerplexityUrl(url) {
  return urlHasAllowedHostname(url, PERPLEXITY_HOSTNAMES);
}

const TASK_MODEL_ALIASES = new Map(Object.entries({
  best: 'perplexity/best',
  default: 'perplexity/best',
  quick: 'perplexity/best',
  quick_web: 'perplexity/best',
  deep_research: 'perplexity/deep-research',
  deep: 'perplexity/deep-research',
  sonar: 'perplexity/sonar-2',
  reasoning: 'openai/gpt-5.4-thinking',
  coding: 'anthropic/claude-sonnet-4.6',
}));
function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function perModelAliases(model) {
  const toolName = typeof model.tool_name === 'string' ? model.tool_name : '';
  const toolWithoutPrefix = toolName.replace(/^pplx_/, '');
  const toolHyphenAlias = toolWithoutPrefix.replace(/_/g, '-');
  return uniqueStrings([
    model.name,
    model.identifier,
    model.id,
    toolName,
    toolWithoutPrefix,
    toolHyphenAlias,
  ]);
}

const MODEL_BY_ID = new Map(MODELS.map(model => [model.id, model]));
const MODEL_BY_LABEL = new Map(MODELS.flatMap(model => perModelAliases(model).map(alias => [alias.toLowerCase(), model])));

const SOURCE_MAP = { web: 'web', academic: 'scholar', social: 'social', finance: 'edgar', all: 'web' };
const SEARCH_MAP = { web: 'internet', writing: 'writing' };
const TIME_MAP = { all: '', day: 'DAY', week: 'WEEK', month: 'MONTH', year: 'YEAR' };
const CITATION_MODES = new Set(['clean', 'markdown', 'default']);
const MIME_BY_EXTENSION = new Map(Object.entries({
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
}));

function choiceList(choices) {
  return [...choices].join(', ');
}

function normalizeChoice({ value, defaultValue, choices, flagName }) {
  const normalized = String(value || defaultValue).trim().toLowerCase();
  if (!choices.has(normalized)) {
    throw new Error(`[perplexity] Invalid ${flagName}: ${value}. Expected one of: ${choiceList(choices)}.`);
  }
  return normalized;
}

export function normalizePerplexitySourceFocus(value = 'web') {
  const rawValues = Array.isArray(value) ? value : [value || 'web'];
  const normalized = rawValues
    .flatMap(item => String(item || '').split(','))
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
  const sourceFocus = normalized.length ? normalized : ['web'];
  for (const source of sourceFocus) {
    if (!Object.prototype.hasOwnProperty.call(SOURCE_MAP, source)) {
      throw new Error(`[perplexity] Invalid --source-focus: ${source}. Expected one of: ${Object.keys(SOURCE_MAP).join(', ')}.`);
    }
  }
  return sourceFocus;
}

export function normalizePerplexityCitationMode(value = 'clean') {
  return normalizeChoice({ value, defaultValue: 'clean', choices: CITATION_MODES, flagName: '--citation-mode' });
}

export function normalizePerplexitySpaceUuid(value = null) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim();
  if (!SPACE_UUID_PATTERN.test(normalized)) {
    throw new Error(`[perplexity] Invalid --space-uuid: ${value}. Expected a UUID such as 123e4567-e89b-12d3-a456-426614174000.`);
  }
  return normalized.toLowerCase();
}

function guessMimeType(path) {
  return MIME_BY_EXTENSION.get(extname(path).toLowerCase()) || 'application/octet-stream';
}

function fileInputsFromOptions(options = {}) {
  const files = options.files || options.file || options.attachments || [];
  if (files === null || files === undefined || files === '') return [];
  return Array.isArray(files) ? files : [files];
}

export function normalizePerplexityFileAttachments(files = []) {
  const inputs = Array.isArray(files) ? files : [files];
  const filtered = inputs.filter(value => value !== null && value !== undefined && String(value).trim());
  if (filtered.length > MAX_PERPLEXITY_FILES) {
    throw new Error(`[perplexity] Too many files: ${filtered.length}. Maximum allowed is ${MAX_PERPLEXITY_FILES}.`);
  }

  const seen = new Set();
  const result = [];
  for (const input of filtered) {
    const path = resolve(String(input));
    if (seen.has(path)) continue;
    seen.add(path);

    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`[perplexity] File not found: ${path}`);
      throw new Error(`[perplexity] Cannot access file: ${path}. ${error.message}`);
    }

    if (!stat.isFile()) throw new Error(`[perplexity] Path is not a file: ${path}`);
    if (stat.size === 0) throw new Error(`[perplexity] File is empty: ${path}`);
    if (stat.size > MAX_PERPLEXITY_FILE_SIZE) {
      throw new Error(`[perplexity] File exceeds 50 MB limit: ${path} (${(stat.size / (1024 * 1024)).toFixed(1)} MB)`);
    }

    const mimeType = guessMimeType(path);
    result.push({
      path,
      filename: basename(path),
      mimeType,
      sizeBytes: stat.size,
      isImage: mimeType.startsWith('image/'),
      source: 'local-file',
    });
  }
  return result;
}

export function safePerplexityAttachmentMetadata(attachment = {}, status = attachment.status || 'uploaded') {
  const metadata = attachment.metadata || attachment;
  return {
    filename: metadata.filename || attachment.filename || null,
    mime_type: metadata.mime_type || metadata.mimeType || attachment.mimeType || 'application/octet-stream',
    size_bytes: metadata.size_bytes ?? metadata.sizeBytes ?? attachment.sizeBytes ?? null,
    is_image: !!(metadata.is_image ?? metadata.isImage ?? attachment.isImage),
    source: metadata.source || attachment.source || 'local-file',
    status,
    url_present: !!(metadata.url_present ?? attachment.url),
  };
}

function normalizeUploadedPerplexityAttachments(values = []) {
  const items = Array.isArray(values) ? values : [];
  return items
    .filter(item => item?.url)
    .map(item => ({
      ...item,
      metadata: safePerplexityAttachmentMetadata(item),
    }));
}

function normalizePerplexityOptions(options = {}) {
  return {
    sourceFocus: normalizePerplexitySourceFocus(options.sourceFocus || 'web'),
    searchFocus: normalizeChoice({ value: options.searchFocus, defaultValue: 'web', choices: new Set(Object.keys(SEARCH_MAP)), flagName: '--search-focus' }),
    timeRange: normalizeChoice({ value: options.timeRange, defaultValue: 'all', choices: new Set(Object.keys(TIME_MAP)), flagName: '--time-range' }),
    citationMode: normalizePerplexityCitationMode(options.citationMode || 'clean'),
    language: String(options.language || 'en-US').trim() || 'en-US',
    timezone: options.timezone ? String(options.timezone).trim() : null,
    saveToLibrary: !!options.saveToLibrary,
    spaceUuid: normalizePerplexitySpaceUuid(options.spaceUuid || options.space || null),
  };
}

export function resolvePerplexityModel(modelName = DEFAULT_PERPLEXITY_MODEL) {
  const normalized = String(modelName || DEFAULT_PERPLEXITY_MODEL).toLowerCase();
  const alias = TASK_MODEL_ALIASES.get(normalized);
  return MODEL_BY_ID.get(modelName) || MODEL_BY_LABEL.get(normalized) || (alias ? MODEL_BY_ID.get(alias) : null) || null;
}

function selectedPerplexityModelName({ request = {}, selectedModel = 'default' } = {}) {
  if (selectedModel && selectedModel !== 'default') return selectedModel;
  if (request.modelName && request.modelName !== 'default') return request.modelName;
  return DEFAULT_PERPLEXITY_MODEL;
}

function extractPerplexityBackendUuidFromUrl(value) {
  try {
    const parsed = new URL(value);
    const explicit = parsed.searchParams.get('backend_uuid') || parsed.searchParams.get('uuid') || parsed.searchParams.get('conversation');
    if (explicit) return explicit;
    const pathMatch = parsed.pathname.match(/([0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{20,})\/?$/i);
    return pathMatch?.[1] || null;
  } catch {
    return null;
  }
}

export function resolvePerplexityConversationAttachment({ target }) {
  const value = String(target || '').trim();
  if (!value) throw new Error('[perplexity] Conversation attachment is empty');
  if (/^https?:\/\//i.test(value)) {
    const backendUuid = extractPerplexityBackendUuidFromUrl(value);
    return {
      type: 'url',
      url: value,
      providerId: backendUuid,
      providerState: backendUuid ? { backend_uuid: backendUuid } : null,
    };
  }
  return {
    type: 'provider_id',
    url: null,
    providerId: value,
    providerState: { backend_uuid: value },
  };
}

export function resolvePerplexityRequestModel({ request = {}, selectedModel = 'default' } = {}) {
  const modelName = selectedPerplexityModelName({ request, selectedModel });
  const model = resolvePerplexityModel(modelName);
  if (!model) {
    throw new Error(`[perplexity] Unknown model: ${modelName}. Run scripts/ai-chat.mjs --provider perplexity --list-models --json to inspect selectable model ids and aliases.`);
  }
  return model;
}

export function resolvePerplexityTimeoutSeconds({ model, request = {} } = {}) {
  const requestedTimeout = Number.parseInt(String(request.timeoutSeconds || 300), 10);
  const safeTimeout = Number.isInteger(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 300;
  if (request.timeoutExplicit) return safeTimeout;
  if (model?.id === 'perplexity/deep-research') return Math.max(safeTimeout, DEFAULT_PERPLEXITY_DEEP_RESEARCH_TIMEOUT_SECONDS);
  return safeTimeout;
}

function annotatePerplexityModel(model) {
  const text = `${model.id} ${model.name} ${model.identifier}`;
  const thinking = /thinking/i.test(text);
  const thinkingLevel = /thinking[-_ ]low/i.test(text) ? 'low' : (/thinking[-_ ]high/i.test(text) ? 'high' : (thinking ? 'default' : null));
  const providerFamily = model.id.includes('/') ? model.id.split('/')[0] : 'perplexity';
  return {
    ...model,
    provider_family: providerFamily,
    thinking,
    thinking_level: thinkingLevel,
    account_specific: false,
    account_tier: { required: model.min_tier || null, verified: null },
    source: 'bundled-registry-from-perplexity-webui-scraper',
    selected_by: uniqueStrings(['--model', ...perModelAliases(model)]),
  };
}

export function buildPerplexityPayload({ query, model, options = {}, conversation = null }) {
  const normalizedOptions = normalizePerplexityOptions(options);
  const uploadedAttachments = normalizeUploadedPerplexityAttachments(options.uploadedAttachments || []);
  const attachmentMetadata = uploadedAttachments.map(item => item.metadata);
  const sources = normalizedOptions.sourceFocus.map(source => SOURCE_MAP[source]);
  const providerState = conversation?.record?.provider_state || conversation?.providerState || null;

  const params = {
    attachments: uploadedAttachments.map(item => item.url),
    language: normalizedOptions.language,
    timezone: normalizedOptions.timezone,
    client_coordinates: null,
    sources,
    model_preference: model.identifier,
    mode: model.mode,
    search_focus: SEARCH_MAP[normalizedOptions.searchFocus],
    search_recency_filter: TIME_MAP[normalizedOptions.timeRange] || null,
    is_incognito: !normalizedOptions.saveToLibrary,
    use_schematized_api: false,
    local_search_enabled: false,
    prompt_source: 'user',
    send_back_text_in_streaming_api: true,
    version: API_VERSION,
  };

  if (normalizedOptions.spaceUuid) {
    params.target_collection_uuid = normalizedOptions.spaceUuid;
    params.target_thread_access_level = 1;
    params.query_source = 'collection';
    params.is_incognito = false;
  }

  if (providerState?.backend_uuid) {
    params.last_backend_uuid = providerState.backend_uuid;
    params.query_source = 'followup';
    if (providerState.read_write_token) params.read_write_token = providerState.read_write_token;
  }

  const payload = { params, query_str: query };
  Object.defineProperty(payload, 'requestMetadata', {
    value: {
      attachments: attachmentMetadata,
      attachment_count: attachmentMetadata.length,
      space_uuid: normalizedOptions.spaceUuid,
      space_selected: !!normalizedOptions.spaceUuid,
      continuation: providerState?.backend_uuid ? { backend_uuid: providerState.backend_uuid, has_read_write_token: !!providerState.read_write_token } : null,
    },
    enumerable: false,
    configurable: true,
  });
  return payload;
}

export function parseSseLine(line) {
  const text = Buffer.isBuffer(line) ? line.toString('utf-8') : String(line || '');
  if (!text.startsWith('data: ')) return null;
  return JSON.parse(text.slice(6));
}

export function extractPerplexityState(data, state = { chunks: [], searchResults: [], rawData: {} }, citationMode = 'clean') {
  if (data.backend_uuid) state.backendUuid = data.backend_uuid;
  if (data.read_write_token) state.readWriteToken = data.read_write_token;
  if (data.status === 'FAILED') throw new Error(`Perplexity query failed: ${data.text || 'unknown error'}`);
  if (!data.text && !data.blocks) return state;

  let payload;
  try {
    payload = JSON.parse(data.text);
  } catch {
    payload = { answer: data.text };
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item?.step_type === 'RESEARCH_CLARIFYING_QUESTIONS') {
        const content = item.content || {};
        const questions = content.questions || content.clarifying_questions || [];
        throw new Error(`Perplexity requested clarification: ${questions.join(' | ')}`);
      }
      if (item?.step_type === 'FINAL') {
        payload = item.content || {};
        if (typeof payload.answer === 'string' && payload.answer.trim().startsWith('{')) {
          try { payload = JSON.parse(payload.answer); } catch {}
        }
        break;
      }
    }
  }

  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.web_results) && payload.web_results.length > 0) {
      state.searchResults = payload.web_results.map(result => ({
        title: result.name || null,
        url: result.url || null,
        snippet: result.snippet || null,
      }));
    }
    if (Array.isArray(payload.chunks)) state.chunks = payload.chunks.filter(Boolean).map(String);
    if (typeof payload.answer === 'string') state.answer = formatCitations(payload.answer, citationMode, state.searchResults);
    state.rawData = payload;
  }
  if (data.final) state.done = true;
  return state;
}

export function formatCitations(text, citationMode = 'clean', searchResults = []) {
  const mode = normalizePerplexityCitationMode(citationMode);
  if (!text || mode === 'default') return text;
  if (mode === 'clean') {
    return text
      .replace(/\s*\[(\d+)\]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([.,;:!?])/g, '$1')
      .trim();
  }
  return text.replace(/\[(\d+)\]/g, (match, number) => {
    const result = searchResults[Number(number) - 1];
    if (result?.url) return `[${number}](${result.url})`;
    return match;
  });
}

export function buildPerplexityProviderStates({ backendUuid = null, readWriteToken = null, previousBackendUuid = null, previousReadWriteToken = null, isIncognito = true, attachments = [], spaceUuid = null, streamState = null } = {}) {
  const backend_uuid = backendUuid || previousBackendUuid || null;
  const privateReadWriteToken = readWriteToken || previousReadWriteToken || null;
  const hasReadWriteToken = !!privateReadWriteToken;
  const safeAttachments = (Array.isArray(attachments) ? attachments : []).map(item => safePerplexityAttachmentMetadata(item));
  const baseState = {
    backend_uuid,
    is_incognito: !!isIncognito,
    saved_to_library: !isIncognito,
    ...(safeAttachments.length ? { attachment_count: safeAttachments.length, attachments: safeAttachments } : {}),
    ...(spaceUuid ? { space_uuid: spaceUuid, space_selected: true } : {}),
    ...(streamState ? { stream_state: streamState } : {}),
  };
  return {
    providerState: {
      ...baseState,
      has_read_write_token: hasReadWriteToken,
    },
    privateProviderState: {
      ...baseState,
      read_write_token: privateReadWriteToken,
    },
  };
}

function previousPerplexityContinuationState(conversation = null) {
  const state = conversation?.record?.provider_state || conversation?.providerState || conversation?.provider_state || null;
  return {
    backendUuid: typeof state?.backend_uuid === 'string' && state.backend_uuid.trim() ? state.backend_uuid.trim() : null,
    readWriteToken: typeof state?.read_write_token === 'string' && state.read_write_token ? state.read_write_token : null,
  };
}

function attachPrivateProviderState(result, privateProviderState) {
  Object.defineProperty(result, 'privateProviderState', {
    value: privateProviderState,
    enumerable: false,
    configurable: true,
  });
  return result;
}

export function redactPerplexitySecrets(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (!secret || typeof secret !== 'string') continue;
    text = text.split(secret).join('[redacted]');
  }
  text = text.replace(new RegExp(`${SESSION_COOKIE_NAME}=[^;\\s]+`, 'g'), `${SESSION_COOKIE_NAME}=[redacted]`);
  text = text.replace(/(["']?(?:read_write_token|session_token|token)["']?\s*[:=]\s*["'])([^"']+)(["'])/gi, '$1[redacted]$3');
  return text;
}

export function perplexityAuthFailureMessage({ source = AUTH_SOURCE_BROWSER_TOOLS, chromeError = null, detail = null, secrets = [] } = {}) {
  const sourceName = source || 'configured token';
  const hints = [
    `Perplexity authentication failed for ${sourceName}; session token invalid or expired.`,
    'Log in to perplexity.ai in the selected Chrome profile, then retry. For standalone Perplexity token checks, PPLX_BROWSER_TOOLS_SYNC=1 forces a fresh profile sync. For AI Chat, restart the managed Browser Tools profile with --sync.',
    'AI Chat uses the managed Browser Tools Chrome session and does not read PERPLEXITY_SESSION_TOKEN or PPLX_SESSION_TOKEN. If managed Chrome is using a stale copied profile, stop it with --clean, restart with --sync, and retry.',
  ];
  if (chromeError) hints.push(`Browser Tools detail: ${redactPerplexitySecrets(chromeError, secrets)}.`);
  if (detail) hints.push(`Detail: ${redactPerplexitySecrets(detail, secrets)}.`);
  return hints.join(' ');
}

function perplexityAuthError({ source = AUTH_SOURCE_BROWSER_TOOLS, chromeError = null, detail = null, secrets = [] } = {}) {
  const error = new Error(perplexityAuthFailureMessage({ source, chromeError, detail, secrets }));
  error.name = 'PerplexityAuthenticationError';
  error.code = 'PERPLEXITY_AUTH_REQUIRED';
  return error;
}

function isAuthenticationStatus(status) {
  return status === 401 || status === 403;
}

function buildPerplexityHeaders(token, extra = {}) {
  return {
    Accept: 'text/event-stream, application/json',
    'Content-Type': 'application/json',
    Referer: `${API_BASE_URL}/`,
    Origin: API_BASE_URL,
    Cookie: `${SESSION_COOKIE_NAME}=${token}`,
    ...extra,
  };
}

function safePerplexityBrowserFetchHeaders(headers = {}) {
  const forbidden = new Set([
    'accept-encoding',
    'connection',
    'content-length',
    'cookie',
    'host',
    'origin',
    'referer',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'user-agent',
  ]);
  const entries = headers instanceof Headers
    ? Array.from(headers.entries())
    : (Array.isArray(headers) ? headers : Object.entries(headers || {}));
  return Object.fromEntries(entries
    .filter(([key, value]) => value !== undefined && value !== null && !forbidden.has(String(key).toLowerCase()))
    .map(([key, value]) => [key, String(value)]));
}

function samePerplexityOrigin(url) {
  try {
    return new URL(String(url), API_BASE_URL).origin === API_BASE_URL;
  } catch {
    return false;
  }
}

function makeBrowserFetchCallbackName() {
  return `__aiChatPerplexityFetch_${randomUUID().replace(/-/g, '')}`;
}

function responseFromBrowserStream({ page, callbackName, url, options, signal }) {
  const encoder = new TextEncoder();
  let streamController = null;
  let settled = false;
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  });

  let removeAbortListener = () => {};
  const responsePromise = new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) {
        streamController?.error(error);
        return;
      }
      settled = true;
      reject(error);
    };

    if (signal) {
      const abort = () => fail(new Error('[perplexity] Browser fetch aborted'));
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', abort);
      }
    }

    page.exposeFunction(callbackName, (event = {}) => {
      if (event.type === 'response') {
        settled = true;
        resolve(new Response(body, {
          status: event.status,
          statusText: event.statusText || '',
          headers: event.headers || [],
        }));
      } else if (event.type === 'chunk') {
        streamController?.enqueue(encoder.encode(String(event.chunk || '')));
      } else if (event.type === 'done') {
        streamController?.close();
        removeAbortListener();
      } else if (event.type === 'error') {
        fail(new Error(event.message || '[perplexity] Browser fetch failed'));
        removeAbortListener();
      }
    }).then(() => {
      page.evaluate(async ({ callbackName: exposedName, url: fetchUrl, options: fetchOptions }) => {
        const send = async event => window[exposedName](event);
        try {
          const response = await fetch(fetchUrl, {
            method: fetchOptions.method,
            headers: fetchOptions.headers,
            body: fetchOptions.body,
            credentials: 'include',
          });
          await send({
            type: 'response',
            status: response.status,
            statusText: response.statusText,
            headers: Array.from(response.headers.entries()),
          });

          if (!response.body?.getReader) {
            await send({ type: 'chunk', chunk: await response.text() });
            await send({ type: 'done' });
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (chunk) await send({ type: 'chunk', chunk });
          }
          const trailing = decoder.decode();
          if (trailing) await send({ type: 'chunk', chunk: trailing });
          await send({ type: 'done' });
        } catch (error) {
          await send({ type: 'error', message: error?.message || String(error) });
        }
      }, { callbackName, url, options }).catch(error => fail(error));
    }).catch(error => fail(error));
  });

  return responsePromise;
}

export function createPerplexityBrowserFetch(page, fallbackFetch = globalThis.fetch) {
  return async function perplexityBrowserFetch(url, options = {}) {
    if (!samePerplexityOrigin(url)) return fallbackFetch(url, options);
    if (!page?.evaluate || !page?.exposeFunction) return fallbackFetch(url, options);
    const fetchUrl = String(url).startsWith('http') ? String(url) : new URL(String(url), API_BASE_URL).toString();
    const body = typeof options.body === 'string' ? options.body : (options.body == null ? null : String(options.body));
    const browserOptions = {
      method: options.method || 'GET',
      headers: safePerplexityBrowserFetchHeaders(options.headers),
      body,
    };
    const callbackName = makeBrowserFetchCallbackName();
    return responseFromBrowserStream({ page, callbackName, url: fetchUrl, options: browserOptions, signal: options.signal });
  };
}

async function responseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function responseJson(response, context) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`[perplexity] ${context} did not return JSON: ${error.message}`);
  }
}

function formDataForAttachment(attachment, fields) {
  if (typeof FormData !== 'function') {
    throw new Error('[perplexity] File uploads require a runtime with FormData support. Use Node.js 20 or newer.');
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(fields || {})) form.append(key, String(value));
  form.append('file', new Blob([readFileSync(attachment.path)], { type: attachment.mimeType }), attachment.filename);
  return form;
}

function resolvePerplexityUploadTimeoutMs(timeoutMs) {
  const parsed = Number(timeoutMs);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERPLEXITY_UPLOAD_TIMEOUT_MS;
}

function formatPerplexityUploadTimeout(timeoutMs) {
  if (timeoutMs < 1000) return `${timeoutMs}ms`;
  if (timeoutMs % 1000 === 0) return `${timeoutMs / 1000}s`;
  return `${Number((timeoutMs / 1000).toFixed(1))}s`;
}

function perplexityUploadTimeoutError({ attachment, phase, timeoutMs, cause }) {
  const error = new Error(`[perplexity] File upload timed out for ${attachment.filename} during ${phase} after ${formatPerplexityUploadTimeout(timeoutMs)}. Recovery: retry on a stable network or increase --timeout for large files.`);
  error.name = 'PerplexityUploadTimeoutError';
  error.code = 'PERPLEXITY_UPLOAD_TIMEOUT';
  if (cause) error.cause = cause;
  return error;
}

async function fetchPerplexityUpload({ fetchImpl, url, options, attachment, phase, signal, timeoutMs }) {
  let removeAbortListener = () => {};
  const abortPromise = new Promise((_, reject) => {
    if (!signal) return;
    const rejectTimeout = () => reject(perplexityUploadTimeoutError({ attachment, phase, timeoutMs }));
    if (signal.aborted) {
      rejectTimeout();
      return;
    }
    signal.addEventListener('abort', rejectTimeout, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', rejectTimeout);
  });

  try {
    return await Promise.race([
      fetchImpl(url, { ...options, signal }),
      abortPromise,
    ]);
  } catch (error) {
    if (error?.code === 'PERPLEXITY_UPLOAD_TIMEOUT') throw error;
    if (signal?.aborted || error?.name === 'AbortError') {
      throw perplexityUploadTimeoutError({ attachment, phase, timeoutMs, cause: error });
    }
    throw error;
  } finally {
    removeAbortListener();
  }
}

async function uploadSinglePerplexityAttachment({ token, attachment, fetchImpl, signal, timeoutMs }) {
  const fileUuid = randomUUID();
  const requestBody = {
    files: {
      [fileUuid]: {
        filename: attachment.filename,
        content_type: attachment.mimeType,
        source: 'default',
        file_size: attachment.sizeBytes,
        force_image: attachment.isImage,
      },
    },
  };

  const initResponse = await fetchPerplexityUpload({
    fetchImpl,
    url: `${API_BASE_URL}${ENDPOINT_UPLOAD}`,
    attachment,
    phase: 'upload initialization',
    signal,
    timeoutMs,
    options: {
      method: 'POST',
      headers: buildPerplexityHeaders(token, { Accept: 'application/json' }),
      body: JSON.stringify(requestBody),
    },
  });
  if (!initResponse.ok) {
    const detail = `upload URL HTTP ${initResponse.status}: ${await responseText(initResponse)}`;
    if (isAuthenticationStatus(initResponse.status)) throw perplexityAuthError({ detail, secrets: [token] });
    throw new Error(`[perplexity] File upload initialization failed for ${attachment.filename}: ${redactPerplexitySecrets(detail, [token])}`);
  }

  const data = await responseJson(initResponse, 'file upload initialization');
  const result = data?.results?.[fileUuid] || {};
  const s3BucketUrl = result.s3_bucket_url;
  const s3ObjectUrl = result.s3_object_url;
  const fields = result.fields || {};
  if (!s3ObjectUrl) throw new Error(`[perplexity] File upload initialization failed for ${attachment.filename}: no uploaded object URL returned`);
  if (!s3BucketUrl || !fields || typeof fields !== 'object') {
    throw new Error(`[perplexity] File upload initialization failed for ${attachment.filename}: missing S3 upload credentials`);
  }

  const uploadResponse = await fetchPerplexityUpload({
    fetchImpl,
    url: s3BucketUrl,
    attachment,
    phase: 'S3 upload',
    signal,
    timeoutMs,
    options: {
      method: 'POST',
      body: formDataForAttachment(attachment, fields),
    },
  });
  if (!uploadResponse.ok) {
    const body = await responseText(uploadResponse);
    throw new Error(`[perplexity] File upload failed for ${attachment.filename}: S3 HTTP ${uploadResponse.status}: ${body}`);
  }

  return {
    ...attachment,
    url: s3ObjectUrl,
    status: 'uploaded',
    metadata: safePerplexityAttachmentMetadata({ ...attachment, url: s3ObjectUrl }, 'uploaded'),
  };
}

export async function uploadPerplexityAttachments({ token, files = [], attachments = null, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PERPLEXITY_UPLOAD_TIMEOUT_MS } = {}) {
  const normalized = attachments || normalizePerplexityFileAttachments(files);
  if (!normalized.length) return [];
  if (!token) throw perplexityAuthError({ detail: 'session token missing' });
  const uploadTimeoutMs = resolvePerplexityUploadTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);
  const uploaded = [];
  try {
    for (const attachment of normalized) {
      uploaded.push(await uploadSinglePerplexityAttachment({ token, attachment, fetchImpl, signal: controller.signal, timeoutMs: uploadTimeoutMs }));
    }
    return uploaded;
  } finally {
    clearTimeout(timeout);
  }
}

function attachNonEnumerableToken(target, token) {
  Object.defineProperty(target, 'token', {
    value: token,
    enumerable: false,
    configurable: true,
  });
  return target;
}

function makeSession({ token, lookup }) {
  return attachNonEnumerableToken({
    source: lookup.source,
    cookie_url: lookup.url,
    lookup_order: PERPLEXITY_SESSION_LOOKUP_ORDER.map(item => item.url),
    token_present: true,
  }, token);
}

export async function validatePerplexitySession({ token, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw perplexityAuthError({ detail: 'session token missing' });
  const response = await fetchImpl(`${API_BASE_URL}/api/auth/session`, {
    headers: buildPerplexityHeaders(token, { Accept: 'application/json' }),
  });
  if (!response.ok) {
    const body = await responseText(response);
    const detail = `auth session check HTTP ${response.status}: ${body}`;
    if (isAuthenticationStatus(response.status)) throw perplexityAuthError({ detail, secrets: [token] });
    throw new Error(`Perplexity auth session check failed: ${redactPerplexitySecrets(detail, [token])}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw perplexityAuthError({ detail: `auth session endpoint did not return JSON: ${error.message}`, secrets: [token] });
  }

  const user = data?.user;
  if (!user || typeof user !== 'object' || !user.id) {
    throw perplexityAuthError({ detail: 'auth session endpoint did not return a logged-in user', secrets: [token] });
  }

  return {
    authenticated: true,
    source: AUTH_SOURCE_BROWSER_TOOLS,
    user_present: true,
    user_id_present: true,
  };
}

export async function readPerplexitySession(page, { validate = false, fetchImpl = globalThis.fetch } = {}) {
  const lookupErrors = [];
  for (const lookup of PERPLEXITY_SESSION_LOOKUP_ORDER) {
    let cookies = [];
    try {
      cookies = await page.cookies(lookup.url);
    } catch (error) {
      lookupErrors.push(`${lookup.label}: ${error.message}`);
      continue;
    }
    const cookie = cookies.find(candidate => candidate.name === SESSION_COOKIE_NAME && candidate.value);
    if (!cookie?.value) continue;
    const session = makeSession({ token: cookie.value, lookup });
    if (validate) session.auth = await validatePerplexitySession({ token: cookie.value, fetchImpl });
    return session;
  }

  const detail = lookupErrors.length ? lookupErrors.join('; ') : 'session cookie not found in managed browser';
  throw perplexityAuthError({ source: AUTH_SOURCE_BROWSER_TOOLS, chromeError: detail });
}

function currentPerplexityText(state) {
  return state.answer || state.chunks.at(-1) || state.chunks.join('') || '';
}

function buildPerplexityStreamState(state = {}, { stream = false } = {}) {
  const text = currentPerplexityText(state);
  const progress = state.streamProgress || {};
  const done = !!state.done;
  return {
    enabled: !!stream,
    status: done ? 'completed' : (text ? 'partial' : 'empty'),
    partial: !done && !!text,
    timeout: !done,
    progress_events: progress.events || 0,
    streamed_chars: progress.streamed_chars || text.length,
    final_chars: text.length,
  };
}

function perplexityProgressCallback(request = {}) {
  if (!request.stream) return null;
  let wrote = false;
  return (event) => {
    if (event.delta) {
      process.stderr.write(event.delta);
      wrote = true;
    }
    if (event.done && wrote) process.stderr.write('\n');
  };
}

function emitPerplexityProgress({ state, previousText, onProgress }) {
  const currentText = currentPerplexityText(state);
  let delta = '';
  if (currentText && currentText !== previousText) {
    delta = currentText.startsWith(previousText) ? currentText.slice(previousText.length) : currentText;
  }
  if (!delta && !state.done) return { currentText, emitted: false };
  const event = {
    type: 'delta',
    delta,
    text: currentText,
    chars: currentText.length,
    done: !!state.done,
    backend_uuid: state.backendUuid || null,
  };
  state.streamProgress.events += 1;
  state.streamProgress.streamed_chars = currentText.length;
  state.streamProgress.last_event_done = !!state.done;
  if (typeof onProgress === 'function') onProgress(event);
  return { currentText, emitted: true };
}

export async function streamPerplexity({ token, payload, timeoutMs, citationMode, fetchImpl = globalThis.fetch, authPrevalidated = false, onProgress = null }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = buildPerplexityHeaders(token);

  try {
    const initResponse = await fetchImpl(`${API_BASE_URL}${ENDPOINT_SEARCH_INIT}?q=${encodeURIComponent(payload.query_str.slice(0, 2000))}`, { headers, signal: controller.signal });
    if (!initResponse.ok && isAuthenticationStatus(initResponse.status)) {
      throw perplexityAuthError({ detail: `search init HTTP ${initResponse.status}: ${await responseText(initResponse)}`, secrets: [token] });
    }
    const response = await fetchImpl(`${API_BASE_URL}${ENDPOINT_ASK}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await responseText(response);
      const detail = `Perplexity HTTP ${response.status}: ${body}`;
      if (response.status === 401 || (response.status === 403 && !authPrevalidated)) throw perplexityAuthError({ detail, secrets: [token] });
      if (response.status === 403) throw new Error(`Perplexity model rejected or unavailable: ${redactPerplexitySecrets(detail, [token])}`);
      throw new Error(redactPerplexitySecrets(detail, [token]));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let progressText = '';
    const state = { chunks: [], searchResults: [], rawData: {}, done: false, streamProgress: { enabled: !!onProgress, events: 0, streamed_chars: 0, last_event_done: false } };

    const processSseLine = (line) => {
      if (!line.startsWith('data: ')) return false;
      const data = parseSseLine(line);
      if (!data) return false;
      extractPerplexityState(data, state, citationMode);
      const progress = emitPerplexityProgress({ state, previousText: progressText, onProgress });
      progressText = progress.currentText;
      return state.done;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (processSseLine(line)) return state;
      }
    }

    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      if (processSseLine(line)) return state;
    }
    return state;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePerplexityProviderRequestOptions(providerOptions = {}) {
  return {
    attachments: normalizePerplexityFileAttachments(fileInputsFromOptions(providerOptions)),
    spaceUuid: normalizePerplexitySpaceUuid(providerOptions.spaceUuid || providerOptions.space || null),
  };
}

async function preparePerplexityProviderRequestOptions({ token, request, normalized, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PERPLEXITY_UPLOAD_TIMEOUT_MS }) {
  const uploadedAttachments = await uploadPerplexityAttachments({ token, attachments: normalized.attachments, fetchImpl, timeoutMs });
  return {
    ...(request.providerOptions || {}),
    spaceUuid: normalized.spaceUuid,
    uploadedAttachments,
  };
}

export async function verifyPerplexityModels({ token, models, timeoutMs, streamFn = streamPerplexity }) {
  const verifiedAt = new Date().toISOString();
  const prompt = 'AI_CHAT_MODEL_CHECK';
  const verified = [];
  for (const model of models) {
    const payload = buildPerplexityPayload({
      query: `Reply exactly: ${prompt}`,
      model,
      options: { saveToLibrary: false, sourceFocus: 'web', searchFocus: 'web' },
    });
    try {
      const state = await streamFn({ token, payload, timeoutMs, citationMode: 'clean', model, authPrevalidated: true });
      const text = state.answer || state.chunks.at(-1) || state.chunks.join('') || '';
      const exactAccepted = text.includes(prompt);
      verified.push({
        ...model,
        account_specific: true,
        account_tier: { required: model.min_tier || null, verified: 'accepted' },
        available: true,
        verified_at: verifiedAt,
        verification: {
          status: exactAccepted ? 'accepted' : 'accepted_response_mismatch',
          accepted: true,
          rejected: false,
          response_chars: text.length,
          backend_uuid: state.backendUuid || null,
        },
      });
    } catch (error) {
      const errorMessage = redactPerplexitySecrets(error.message, [token]);
      const clarification = /requested clarification/i.test(errorMessage);
      verified.push({
        ...model,
        account_specific: true,
        account_tier: { required: model.min_tier || null, verified: clarification ? 'accepted' : 'rejected' },
        available: clarification,
        verified_at: verifiedAt,
        verification: {
          status: clarification ? 'accepted_clarification_required' : 'rejected',
          accepted: clarification,
          rejected: !clarification,
          error: errorMessage,
        },
      });
    }
  }

  const acceptedModelIds = verified.filter(model => model.verification.accepted).map(model => model.id);
  const rejectedModelIds = verified.filter(model => model.verification.rejected).map(model => model.id);
  return {
    verification: {
      enabled: true,
      status: 'completed',
      prompt,
      incognito: true,
      accepted_count: acceptedModelIds.length,
      rejected_count: rejectedModelIds.length,
      accepted_model_ids: acceptedModelIds,
      rejected_model_ids: rejectedModelIds,
    },
    models: verified,
  };
}

export const perplexityProvider = {
  name: 'perplexity',
  url: API_BASE_URL,
  trustedConversationHostnames: PERPLEXITY_HOSTNAMES,
  transport: 'webui-api',

  defaultModel: DEFAULT_PERPLEXITY_MODEL,
  taskModels: {
    default: DEFAULT_PERPLEXITY_MODEL,
    quick_web: DEFAULT_PERPLEXITY_MODEL,
    deep_research: 'perplexity/deep-research',
    sonar: 'perplexity/sonar-2',
    reasoning: 'openai/gpt-5.4-thinking',
    coding: 'anthropic/claude-sonnet-4.6',
  },
  historyPolicy: {
    default: 'incognito',
    saveFlag: '--save-to-library',
    transportField: 'params.is_incognito',
  },
  resolveConversationAttachment: resolvePerplexityConversationAttachment,

  listModelsRequiresBrowser({ request } = {}) {
    return !!request?.verifyModels;
  },

  async listModels({ browser, request } = {}) {
    const baseModels = MODELS.map(annotatePerplexityModel);
    if (!request?.verifyModels) {
      return {
        model_source: 'bundled-registry-from-perplexity-webui-scraper',
        account_specific: false,
        verification: { enabled: false },
        models: baseModels,
      };
    }

    const page = await this.findPage({ browser });
    const fetchImpl = createPerplexityBrowserFetch(page);
    const session = await readPerplexitySession(page, { validate: true, fetchImpl });
    const verifiedModels = await verifyPerplexityModels({
      token: session.token,
      models: baseModels,
      timeoutMs: (request.verifyModelTimeoutSeconds || 90) * 1000,
      streamFn: args => streamPerplexity({ ...args, fetchImpl }),
    });
    return {
      model_source: 'bundled-registry-from-perplexity-webui-scraper',
      account_specific: true,
      auth_session: session.auth || null,
      verification: verifiedModels.verification,
      models: verifiedModels.models,
    };
  },

  async run({ browser, request, selectedModel, conversation }) {
    const model = resolvePerplexityRequestModel({ request, selectedModel });
    const normalizedOptions = normalizePerplexityProviderRequestOptions(request.providerOptions || {});
    const page = await this.findPage({ browser });
    const fetchImpl = createPerplexityBrowserFetch(page);
    const session = await readPerplexitySession(page, { validate: !!request.providerOptions?.verifySession, fetchImpl });
    const requestTimeoutMs = resolvePerplexityTimeoutSeconds({ model, request }) * 1000;
    const effectiveOptions = await preparePerplexityProviderRequestOptions({ token: session.token, request, normalized: normalizedOptions, fetchImpl, timeoutMs: requestTimeoutMs });
    console.error(`[perplexity] Model resolved: ${model.id}`);
    const payload = buildPerplexityPayload({
      query: request.prompt,
      model,
      options: effectiveOptions,
      conversation,
    });
    const state = await streamPerplexity({
      token: session.token,
      payload,
      timeoutMs: requestTimeoutMs,
      citationMode: request.providerOptions?.citationMode || 'clean',
      fetchImpl,
      authPrevalidated: !!session.auth,
      onProgress: perplexityProgressCallback(request),
    });
    const text = currentPerplexityText(state);
    const streamState = buildPerplexityStreamState(state, { stream: request.stream });
    const previousContinuation = previousPerplexityContinuationState(conversation);
    const providerStates = buildPerplexityProviderStates({
      backendUuid: state.backendUuid,
      readWriteToken: state.readWriteToken,
      previousBackendUuid: previousContinuation.backendUuid,
      previousReadWriteToken: previousContinuation.readWriteToken,
      isIncognito: payload.params.is_incognito,
      attachments: effectiveOptions.uploadedAttachments,
      spaceUuid: effectiveOptions.spaceUuid,
      streamState,
    });
    return attachPrivateProviderState({
      text,
      rawText: text,
      done: !!state.done,
      modelUsed: model.id,
      finalUrl: null,
      providerState: providerStates.providerState,
      attachments: payload.requestMetadata.attachments,
      searchResults: state.searchResults || [],
      rawData: state.rawData || {},
    }, providerStates.privateProviderState);
  },

  async findPage({ browser }) {
    const pages = await browser.pages();
    let page = pages.find(candidate => isPerplexityUrl(candidate.url()));
    if (!page) page = await browser.newPage({ background: true });
    if (!isPerplexityUrl(page.url())) await page.goto(API_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1000);
    return page;
  },

  async createAttemptContext({ page, request, selectedModel, conversation }) {
    const model = resolvePerplexityRequestModel({ request, selectedModel });
    const normalizedOptions = normalizePerplexityProviderRequestOptions(request.providerOptions || {});
    const fetchImpl = createPerplexityBrowserFetch(page);
    const session = await readPerplexitySession(page, { validate: !!request.providerOptions?.verifySession, fetchImpl });
    const requestTimeoutMs = resolvePerplexityTimeoutSeconds({ model, request }) * 1000;
    const effectiveOptions = await preparePerplexityProviderRequestOptions({ token: session.token, request, normalized: normalizedOptions, fetchImpl, timeoutMs: requestTimeoutMs });
    return attachNonEnumerableToken({ model, conversation, authSession: session.auth || null, providerOptions: effectiveOptions, fetchImpl }, session.token);
  },

  async setModel({ request, selectedModel }) {
    const model = resolvePerplexityRequestModel({ request, selectedModel });
    console.error(`[perplexity] Model resolved: ${model.id}`);
  },

  async clearInput() {},
  async typePrompt() {},
  async submit() {},

  async waitForResponse({ request, timeoutMs, attemptContext }) {
    const model = attemptContext.model;
    const effectiveOptions = attemptContext.providerOptions || request.providerOptions || {};
    const payload = buildPerplexityPayload({
      query: request.prompt,
      model,
      options: effectiveOptions,
      conversation: attemptContext.conversation,
    });
    const state = await streamPerplexity({
      token: attemptContext.token,
      payload,
      timeoutMs: request.timeoutExplicit ? timeoutMs : resolvePerplexityTimeoutSeconds({ model, request }) * 1000,
      citationMode: request.providerOptions?.citationMode || 'clean',
      fetchImpl: attemptContext.fetchImpl || globalThis.fetch,
      authPrevalidated: !!attemptContext.authSession,
      onProgress: perplexityProgressCallback(request),
    });
    const text = currentPerplexityText(state);
    const streamState = buildPerplexityStreamState(state, { stream: request.stream });
    const previousContinuation = previousPerplexityContinuationState(attemptContext.conversation);
    const providerStates = buildPerplexityProviderStates({
      backendUuid: state.backendUuid,
      readWriteToken: state.readWriteToken,
      previousBackendUuid: previousContinuation.backendUuid,
      previousReadWriteToken: previousContinuation.readWriteToken,
      isIncognito: payload.params.is_incognito,
      attachments: effectiveOptions.uploadedAttachments,
      spaceUuid: effectiveOptions.spaceUuid,
      streamState,
    });
    return attachPrivateProviderState({
      text,
      rawText: text,
      done: !!state.done,
      modelUsed: model.id,
      finalUrl: null,
      providerState: providerStates.providerState,
      attachments: payload.requestMetadata.attachments,
      searchResults: state.searchResults || [],
      rawData: state.rawData || {},
    }, providerStates.privateProviderState);
  },
};
