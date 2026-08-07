import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE_URL = 'https://www.perplexity.ai';
const PERPLEXITY_HOSTNAMES = ['perplexity.ai', 'www.perplexity.ai'];
const ENDPOINT_ASK = '/rest/sse/perplexity_ask';
export const PERPLEXITY_NETWORK_BOOTSTRAP_URL = `${API_BASE_URL}/api/auth/session`;
const ENDPOINT_UPLOAD = '/rest/uploads/batch_create_upload_urls';
const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
const API_VERSION = '2.18';
const MAX_PERPLEXITY_FILES = 30;
const MAX_PERPLEXITY_FILE_SIZE = 50 * 1024 * 1024;
const DEFAULT_PERPLEXITY_UPLOAD_TIMEOUT_MS = 300 * 1000;
const SPACE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Provider backend ids are UUIDs or opaque URL-safe ids used in /search/<id> links.
const BACKEND_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKEND_OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;
const DEFAULT_PERPLEXITY_MODEL = 'perplexity/best';
export const DEFAULT_PERPLEXITY_DEEP_RESEARCH_TIMEOUT_SECONDS = 3600;
const RAW_MODELS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'perplexity-models.json'), 'utf-8'));
const MODELS = RAW_MODELS.filter(model => model.min_tier !== 'max');
const AUTH_SOURCE_BROWSER_TOOLS = 'Browser Tools same-origin network session';
const SUPPORTED_BLOCK_USE_CASES = [
  'answer_modes',
  'media_items',
  'knowledge_cards',
  'inline_entity_cards',
  'place_widgets',
  'finance_widgets',
  'sports_widgets',
  'news_widgets',
  'shopping_widgets',
  'jobs_widgets',
  'search_result_widgets',
  'inline_images',
  'inline_assets',
  'placeholder_cards',
  'diff_blocks',
  'inline_knowledge_cards',
  'entity_group_v2',
  'refinement_filters',
  'canvas_mode',
  'maps_preview',
  'answer_tabs',
  'price_comparison_widgets',
  'preserve_latex',
  'generic_onboarding_widgets',
  'in_context_suggestions',
  'pending_followups',
  'inline_claims',
  'unified_assets',
  'workflow_steps',
  'workflow_widgets',
  'navigation_results',
  'background_agents',
];
const TASK_MODEL_ALIASES = new Map(Object.entries({
  best: 'perplexity/best',
  default: 'perplexity/best',
  quick: 'perplexity/best',
  quick_web: 'perplexity/best',
  deep_research: 'perplexity/deep-research',
  deep: 'perplexity/deep-research',
  sonar: 'perplexity/sonar-2',
  reasoning: 'openai/gpt-5.6-terra-thinking',
  coding: 'openai/gpt-5.6-terra',
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

export function normalizePerplexityOptions(options = {}) {
  const incognitoExplicit = options.incognito === true;
  const saveToLibrary = !!options.saveToLibrary;
  const spaceUuid = normalizePerplexitySpaceUuid(options.spaceUuid || options.space || null);
  if (incognitoExplicit && saveToLibrary) {
    throw new Error('[perplexity] Use either --incognito or --save-to-library, not both. Incognito sessions are not saved to provider history.');
  }
  if (incognitoExplicit && spaceUuid) {
    throw new Error('[perplexity] --incognito cannot be combined with --space-uuid because Space threads are saved to the selected collection.');
  }
  return {
    sourceFocus: normalizePerplexitySourceFocus(options.sourceFocus || 'web'),
    searchFocus: normalizeChoice({ value: options.searchFocus, defaultValue: 'web', choices: new Set(Object.keys(SEARCH_MAP)), flagName: '--search-focus' }),
    timeRange: normalizeChoice({ value: options.timeRange, defaultValue: 'all', choices: new Set(Object.keys(TIME_MAP)), flagName: '--time-range' }),
    citationMode: normalizePerplexityCitationMode(options.citationMode || 'clean'),
    language: String(options.language || 'en-US').trim() || 'en-US',
    timezone: options.timezone ? String(options.timezone).trim() : null,
    incognito: incognitoExplicit,
    incognitoExplicit,
    saveToLibrary,
    spaceUuid,
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

export function normalizePerplexityBackendId(value) {
  const normalized = String(value || '').trim();
  if (!normalized || (!BACKEND_UUID_PATTERN.test(normalized) && !BACKEND_OPAQUE_ID_PATTERN.test(normalized))) {
    throw new Error('[perplexity] Invalid conversation backend id. Expected a UUID or a URL-safe opaque backend id with at least 20 characters.');
  }
  return BACKEND_UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
}

function extractPerplexityBackendUuidFromUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('[perplexity] Invalid conversation URL. Use https://www.perplexity.ai/search/<backend-id>.');
  }
  if (!PERPLEXITY_HOSTNAMES.includes(parsed.hostname.toLowerCase())) {
    throw new Error('[perplexity] Untrusted conversation URL. Use https://www.perplexity.ai/search/<backend-id>.');
  }
  const match = parsed.pathname.match(/^\/search\/([^/]+)\/?$/);
  if (!match) throw new Error('[perplexity] Conversation URL must contain a backend id at /search/<backend-id>.');
  return normalizePerplexityBackendId(decodeURIComponent(match[1]));
}

export function perplexityConversationUrl(backendUuid) {
  if (backendUuid === null || backendUuid === undefined || String(backendUuid).trim() === '') return null;
  const value = normalizePerplexityBackendId(backendUuid);
  return `${API_BASE_URL}/search/${encodeURIComponent(value)}`;
}

export function resolvePerplexityConversationAttachment({ target }) {
  const value = String(target || '').trim();
  if (!value) throw new Error('[perplexity] Conversation attachment is empty');
  const backendUuid = /^https?:\/\//i.test(value)
    ? extractPerplexityBackendUuidFromUrl(value)
    : normalizePerplexityBackendId(value);
  return {
    type: /^https?:\/\//i.test(value) ? 'url' : 'provider_id',
    url: perplexityConversationUrl(backendUuid),
    providerId: backendUuid,
    providerState: { backend_uuid: backendUuid },
  };
}

export function resolvePerplexityRequestModel({ request = {}, selectedModel = 'default' } = {}) {
  const modelName = selectedPerplexityModelName({ request, selectedModel });
  let model = resolvePerplexityModel(modelName);
  if (!model) {
    throw new Error(`[perplexity] Unknown model: ${modelName}. Run scripts/ai-chat.mjs --provider perplexity --list-models --json to inspect selectable model ids and aliases.`);
  }
  if (request.thinking && !model.thinking) {
    const thinkingModel = model.thinking_model_id ? MODEL_BY_ID.get(model.thinking_model_id) : null;
    if (!thinkingModel) {
      throw new Error(`[perplexity] Model ${model.id} has no supported Thinking variant. Select an explicit *-thinking model from --list-models instead.`);
    }
    model = thinkingModel;
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
  const thinking = model.thinking === true || /thinking/i.test(text);
  const thinkingLevel = /thinking[-_ ]low/i.test(text) ? 'low' : (/thinking[-_ ]high/i.test(text) ? 'high' : (thinking ? 'default' : null));
  const providerFamily = model.id.includes('/') ? model.id.split('/')[0] : 'perplexity';
  return {
    ...model,
    provider_family: providerFamily,
    thinking,
    thinking_level: thinkingLevel,
    account_specific: false,
    account_tier: { required: model.min_tier || null, verified: null },
    selected_by: uniqueStrings(['--model', ...perModelAliases(model)]),
  };
}

export function buildPerplexityPayload({ query, model, options = {}, conversation = null }) {
  const normalizedOptions = normalizePerplexityOptions(options);
  const providerState = conversation?.record?.provider_state || conversation?.providerState || null;
  if (normalizedOptions.incognito && providerState?.backend_uuid) {
    throw new Error('[perplexity] --incognito cannot continue or attach an existing conversation. Start a new Incognito query without --conversation or --attach-conversation.');
  }
  const uploadedAttachments = normalizeUploadedPerplexityAttachments(options.uploadedAttachments || []);
  const attachmentMetadata = uploadedAttachments.map(item => item.metadata);
  const sources = normalizedOptions.sourceFocus.map(source => SOURCE_MAP[source]);

  const params = {
    attachments: uploadedAttachments.map(item => item.url),
    language: normalizedOptions.language,
    timezone: normalizedOptions.timezone,
    search_focus: SEARCH_MAP[normalizedOptions.searchFocus],
    sources,
    frontend_uuid: randomUUID(),
    mode: model.mode,
    model_preference: model.identifier,
    is_related_query: false,
    is_sponsored: false,
    frontend_context_uuid: randomUUID(),
    prompt_source: 'user',
    query_source: 'home',
    is_incognito: normalizedOptions.incognito,
    time_from_first_type: 0,
    local_search_enabled: false,
    use_schematized_api: true,
    send_back_text_in_streaming_api: false,
    supported_block_use_cases: [...SUPPORTED_BLOCK_USE_CASES],
    client_coordinates: null,
    mentions: [],
    dsl_query: query,
    skip_search_enabled: true,
    is_nav_suggestions_disabled: false,
    source: 'default',
    always_search_override: false,
    override_no_search: false,
    should_ask_for_mcp_tool_confirmation: true,
    supports_tool_approval_modal: true,
    browser_agent_allow_once_from_toggle: false,
    force_enable_browser_agent: false,
    supported_features: ['browser_agent_permission_banner_v1.1'],
    extended_context: false,
    version: API_VERSION,
    rum_session_id: randomUUID(),
  };

  const recency = TIME_MAP[normalizedOptions.timeRange];
  if (recency) params.search_recency_filter = recency;

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
      incognito_explicit: normalizedOptions.incognitoExplicit,
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

function jsonPointerSegments(path) {
  if (!path) return [];
  return String(path).split('/').slice(1).map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function applyJsonPatch(target, patches = []) {
  let value = target && typeof target === 'object' ? structuredClone(target) : {};
  for (const patch of patches) {
    if (!patch || !['add', 'replace', 'remove'].includes(patch.op)) continue;
    const segments = jsonPointerSegments(patch.path);
    if (segments.length === 0) {
      value = patch.op === 'remove' ? {} : structuredClone(patch.value);
      continue;
    }

    let parent = value;
    for (const segment of segments.slice(0, -1)) {
      if (!parent[segment] || typeof parent[segment] !== 'object') parent[segment] = {};
      parent = parent[segment];
    }
    const key = segments.at(-1);
    if (patch.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number.parseInt(key, 10), 1);
      else delete parent[key];
    } else if (Array.isArray(parent) && key === '-') {
      parent.push(structuredClone(patch.value));
    } else {
      parent[key] = structuredClone(patch.value);
    }
  }
  return value;
}

function markdownText(block = {}) {
  if (typeof block.answer === 'string') return block.answer;
  if (Array.isArray(block.chunks)) return block.chunks.filter(Boolean).map(String).join('');
  return '';
}

function extractPerplexityBlockState(data, state, citationMode) {
  if (!Array.isArray(data.blocks)) return;
  state.blockStates ||= {};
  for (const block of data.blocks) {
    const usage = block?.intended_usage;
    if (!usage) continue;
    if (block.markdown_block && typeof block.markdown_block === 'object') {
      state.blockStates[usage] = structuredClone(block.markdown_block);
    } else if (block.diff_block?.field === 'markdown_block') {
      state.blockStates[usage] = applyJsonPatch(state.blockStates[usage], block.diff_block.patches);
    }
  }

  const preferred = state.blockStates.ask_text || state.blockStates.ask_text_0_markdown;
  const text = markdownText(preferred);
  if (text) {
    state.chunks = Array.isArray(preferred.chunks) ? preferred.chunks.filter(Boolean).map(String) : [text];
    state.streamText = text;
    state.answer = formatCitations(text, citationMode, state.searchResults);
  }
}

function normalizePerplexitySearchResults(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter(result => result && typeof result === 'object' && result.url)
    .map(result => ({
      title: result.name || result.title || null,
      url: result.url,
      snippet: result.snippet || result.description || null,
    }));
}

export function extractPerplexityState(data, state = { chunks: [], searchResults: [], rawData: {} }, citationMode = 'clean') {
  if (data.backend_uuid) state.backendUuid = data.backend_uuid;
  if (data.read_write_token) state.readWriteToken = data.read_write_token;
  if (data.display_model) state.displayModel = data.display_model;
  if (data.user_selected_model) state.userSelectedModel = data.user_selected_model;
  if (data.cursor) state.cursor = data.cursor;
  if (data.privacy_state) state.privacyState = data.privacy_state;
  if (data.expiry_time) state.expiresAt = data.expiry_time;
  if (Object.prototype.hasOwnProperty.call(data, 'reconnectable')) state.reconnectable = !!data.reconnectable;
  if (Object.prototype.hasOwnProperty.call(data, 'thread_access')) state.threadAccess = data.thread_access;
  const topLevelResults = normalizePerplexitySearchResults(data.web_results || data.search_results || data.sources);
  if (topLevelResults.length) state.searchResults = topLevelResults;
  if (data.status === 'FAILED') throw new Error(`Perplexity query failed: ${redactPerplexitySecrets(String(data.text || 'unknown error'))}`);
  extractPerplexityBlockState(data, state, citationMode);
  if (!data.text) {
    if (data.status === 'COMPLETED' || data.final_sse_message === true) state.done = true;
    return state;
  }

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
      state.searchResults = normalizePerplexitySearchResults(payload.web_results);
    }
    if (Array.isArray(payload.chunks)) state.chunks = payload.chunks.filter(Boolean).map(String);
    const streamText = typeof payload.answer === 'string'
      ? payload.answer
      : (Array.isArray(payload.chunks) ? payload.chunks.filter(Boolean).map(String).join('') : '');
    if (streamText) state.streamText = streamText;
    if (typeof payload.answer === 'string') state.answer = formatCitations(payload.answer, citationMode, state.searchResults);
    state.rawData = payload;
  }
  if (data.status === 'COMPLETED' || data.final_sse_message === true) state.done = true;
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

export function buildPerplexityProviderStates({ backendUuid = null, readWriteToken = null, previousBackendUuid = null, previousReadWriteToken = null, requestedModelIdentifier = null, responseModelIdentifier = null, userSelectedModelIdentifier = null, isIncognito = false, incognitoExplicit = false, privacyState = null, expiresAt = null, reconnectable = null, threadAccess = null, attachments = [], spaceUuid = null, streamState = null } = {}) {
  const backend_uuid = backendUuid || previousBackendUuid || null;
  const privateReadWriteToken = readWriteToken || previousReadWriteToken || null;
  const hasReadWriteToken = !!privateReadWriteToken;
  const safeAttachments = (Array.isArray(attachments) ? attachments : []).map(item => safePerplexityAttachmentMetadata(item));
  const observedModelIdentifier = userSelectedModelIdentifier || responseModelIdentifier || null;
  const baseState = {
    transport: 'browser-network-sse',
    network_only: true,
    dom_processing: false,
    ...(requestedModelIdentifier ? { requested_model_identifier: requestedModelIdentifier } : {}),
    ...(responseModelIdentifier ? { response_model_identifier: responseModelIdentifier } : {}),
    ...(userSelectedModelIdentifier ? { user_selected_model_identifier: userSelectedModelIdentifier } : {}),
    ...(requestedModelIdentifier ? { model_selection_verified: observedModelIdentifier ? observedModelIdentifier === requestedModelIdentifier : null } : {}),
    backend_uuid,
    // Server-returned state is not user input. Preserve its provider URL without
    // applying attachment-target validation to an already established thread.
    ...(backend_uuid ? { thread_url: `${API_BASE_URL}/search/${encodeURIComponent(backend_uuid)}` } : {}),
    is_incognito: !!isIncognito,
    incognito_explicit: !!incognitoExplicit,
    privacy_state: privacyState || (isIncognito ? 'INCOGNITO' : 'PERSISTENT'),
    ephemeral: !!isIncognito,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(typeof reconnectable === 'boolean' ? { reconnectable } : {}),
    ...(threadAccess !== null && threadAccess !== undefined ? { thread_access: threadAccess } : {}),
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

const PERPLEXITY_SENSITIVE_KEY = '(?:[a-z0-9_-]*(?:auth(?:orization)?|session|cookie|token|secret|credential|password|signature)[a-z0-9_-]*|(?:[a-z0-9_-]*(?:api|access)[_-]?key[a-z0-9_-]*)|sig|(?:aws|google)[_-]?access[_-]?(?:key[_-]?)?id|x[-_]?(?:amz|goog)[-_]?(?:credential|security[-_]?token|signature))';

export function redactPerplexitySecrets(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (!secret || typeof secret !== 'string') continue;
    text = text.split(secret).join('[redacted]');
  }
  const structured = new RegExp(`((?:["']${PERPLEXITY_SENSITIVE_KEY}["'])\\s*:\\s*["'])([^"']*)(["'])`, 'gi');
  const assignment = new RegExp(`((?:${PERPLEXITY_SENSITIVE_KEY})\\s*[=:]\\s*)([^\\s,;?&#}\\]]+)`, 'gi');
  const query = new RegExp(`([?&]${PERPLEXITY_SENSITIVE_KEY}=)[^&#\\s"']+`, 'gi');
  return text
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(structured, '$1[redacted]$3')
    .replace(assignment, '$1[redacted]')
    .replace(query, '$1[redacted]');
}

export function perplexityAuthFailureMessage({ source = AUTH_SOURCE_BROWSER_TOOLS, chromeError = null, detail = null, secrets = [] } = {}) {
  const sourceName = source || AUTH_SOURCE_BROWSER_TOOLS;
  const hints = [
    `Perplexity authentication failed for ${sourceName}.`,
    'Log in to perplexity.ai in the selected Chrome profile, then retry.',
    'AI Chat sends requests inside the managed Browser Tools browser and never extracts Perplexity cookies or reads PERPLEXITY_SESSION_TOKEN or PPLX_SESSION_TOKEN. If managed Chrome is using a stale copied profile, stop it with --clean, restart with --sync, and retry.',
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

function buildPerplexityHeaders(extra = {}) {
  return {
    Accept: 'text/event-stream, application/json',
    'Content-Type': 'application/json',
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
    'authorization',
    'proxy-authorization',
    'www-authenticate',
    'proxy-authenticate',
  ]);
  const credentialHeader = /(?:^|[-_])(?:api|access)[-_]?key(?:$|[-_])|(?:^|[-_])(?:auth(?:orization)?|token|secret|credential|signature|sig|password)(?:$|[-_])|^(?:x[-_])?(?:amz|goog)[-_].*(?:credential|token|signature|key)/i;
  const entries = headers instanceof Headers
    ? Array.from(headers.entries())
    : (Array.isArray(headers) ? headers : Object.entries(headers || {}));
  return Object.fromEntries(entries
    .filter(([key, value]) => value !== undefined && value !== null && !forbidden.has(String(key).toLowerCase()) && !credentialHeader.test(String(key)))
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
  let finished = false;
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  });

  let removeAbortListener = () => {};
  const abortName = `${callbackName}Abort`;
  const cleanup = () => {
    removeAbortListener();
    if (typeof page.removeExposedFunction === 'function') {
      const cleanupTimer = setTimeout(() => page.removeExposedFunction(callbackName).catch(() => {}), 100);
      cleanupTimer.unref?.();
    }
  };
  const responsePromise = new Promise((resolve, reject) => {
    const fail = (error) => {
      if (finished) return;
      finished = true;
      if (settled) {
        streamController?.error(error);
        cleanup();
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    if (signal) {
      const abort = () => {
        page.evaluate((name) => globalThis[name]?.(), abortName).catch(() => {});
        const error = new Error('[perplexity] Browser fetch aborted');
        error.name = 'AbortError';
        fail(error);
      };
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
        // Provider response headers stay in the browser context and never cross into Node.
        resolve(new Response(body, {
          status: event.status,
          statusText: event.statusText || '',
        }));
      } else if (event.type === 'chunk') {
        if (!finished) streamController?.enqueue(encoder.encode(String(event.chunk || '')));
      } else if (event.type === 'done') {
        if (finished) return;
        finished = true;
        streamController?.close();
        cleanup();
      } else if (event.type === 'error') {
        fail(new Error(event.message || '[perplexity] Browser fetch failed'));
      }
    }).then(() => {
      if (finished) return;
      page.evaluate(async ({ callbackName: exposedName, abortName: browserAbortName, url: fetchUrl, options: fetchOptions }) => {
        const send = async event => globalThis[exposedName](event);
        const controller = new AbortController();
        globalThis[browserAbortName] = () => controller.abort();
        try {
          const response = await fetch(fetchUrl, {
            method: fetchOptions.method,
            headers: fetchOptions.headers,
            body: fetchOptions.body,
            credentials: 'include',
            signal: controller.signal,
          });
          await send({
            type: 'response',
            status: response.status,
            statusText: response.statusText,
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
        } finally {
          delete globalThis[browserAbortName];
        }
      }, { callbackName, abortName, url, options }).catch(error => fail(error));
    }).catch(error => fail(error));
  });

  return responsePromise;
}

export function createPerplexityBrowserFetch(page, fallbackFetch = globalThis.fetch) {
  return async function perplexityBrowserFetch(url, options = {}) {
    if (!samePerplexityOrigin(url)) return fallbackFetch(url, options);
    if (!page?.evaluate || !page?.exposeFunction) {
      throw new Error('[perplexity] Same-origin network requests require the managed Browser Tools page context. DOM and Node-fetch fallbacks are disabled.');
    }
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

const PERPLEXITY_UPLOAD_CHUNK_BYTES = 256 * 1024;

async function uploadPerplexityAttachmentInBrowser({ page, attachment, timeoutMs }) {
  if (!page?.evaluate || !page?.exposeFunction) throw new Error('[perplexity] File uploads require the managed browser page context.');
  const callbackName = `__aiChatPerplexityUploadChunk_${randomUUID().replace(/-/g, '')}`;
  const fd = openSync(attachment.path, 'r');
  try {
    await page.exposeFunction(callbackName, (offset, requestedBytes) => {
      const start = Number(offset); const length = Number(requestedBytes);
      if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || start >= attachment.sizeBytes || length < 1 || length > PERPLEXITY_UPLOAD_CHUNK_BYTES) throw new Error('invalid private upload chunk request');
      const bytes = Math.min(length, attachment.sizeBytes - start);
      const buffer = Buffer.allocUnsafe(bytes);
      const read = readSync(fd, buffer, 0, bytes, start);
      return buffer.subarray(0, read).toString('base64');
    });
    const browserUpload = page.evaluate(async ({ callbackName, attachment, endpoint, apiBase, chunkBytes, timeoutMs }) => {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
      let phase = 'upload initialization';
      try {
      const init = await fetch(`${apiBase}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'include', signal: controller.signal, body: JSON.stringify({ files: { [crypto.randomUUID()]: { filename: attachment.filename, content_type: attachment.mimeType, source: 'default', file_size: attachment.sizeBytes, force_image: attachment.isImage } } }) });
      if (!init.ok) throw new Error(`initialization HTTP ${init.status}`);
      const initData = await init.json(); const result = Object.values(initData?.results || {})[0] || {};
      if (!result.s3_bucket_url || !result.s3_object_url || !result.fields || typeof result.fields !== 'object') throw new Error('initialization returned incomplete upload data');
      const form = new FormData(); for (const [key, value] of Object.entries(result.fields)) form.append(key, String(value));
      const chunks = []; for (let offset = 0; offset < attachment.sizeBytes; offset += chunkBytes) { const encoded = await globalThis[callbackName](offset, Math.min(chunkBytes, attachment.sizeBytes - offset)); const binary = atob(encoded); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); chunks.push(bytes); }
      form.append('file', new Blob(chunks, { type: attachment.mimeType }), attachment.filename);
      phase = 'S3 upload';
      const uploaded = await fetch(result.s3_bucket_url, { method: 'POST', body: form, signal: controller.signal });
      if (!uploaded.ok) throw new Error(`upload HTTP ${uploaded.status}`);
      // Do not return signed fields, bucket URL, response headers, or credentials.
      return { objectUrl: result.s3_object_url };
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`__AI_CHAT_UPLOAD_TIMEOUT__:${phase}`);
        throw error;
      } finally { clearTimeout(abortTimer); }
    }, { callbackName, attachment: { filename: attachment.filename, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, isImage: attachment.isImage }, endpoint: ENDPOINT_UPLOAD, apiBase: API_BASE_URL, chunkBytes: PERPLEXITY_UPLOAD_CHUNK_BYTES, timeoutMs });
    const safe = await browserUpload;
    if (!safe?.objectUrl || typeof safe.objectUrl !== 'string') throw new Error('[perplexity] File upload failed: browser did not return uploaded object metadata.');
    return { ...attachment, url: safe.objectUrl, status: 'uploaded', metadata: safePerplexityAttachmentMetadata({ ...attachment, url: safe.objectUrl }, 'uploaded') };
  } catch (error) {
    if (error?.code === 'PERPLEXITY_UPLOAD_TIMEOUT') throw error;
    const phase = String(error?.message || '').match(/__AI_CHAT_UPLOAD_TIMEOUT__:(upload initialization|S3 upload)/)?.[1];
    if (phase) throw perplexityUploadTimeoutError({ attachment, phase, timeoutMs, cause: error });
    throw new Error(`[perplexity] File upload failed for ${attachment.filename}: ${redactPerplexitySecrets(error.message)}`);
  } finally {
    closeSync(fd);
    if (typeof page.removeExposedFunction === 'function') await page.removeExposedFunction(callbackName).catch(() => {});
  }
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

export async function uploadPerplexityAttachments({ files = [], attachments = null, page, timeoutMs = DEFAULT_PERPLEXITY_UPLOAD_TIMEOUT_MS } = {}) {
  const normalized = attachments || normalizePerplexityFileAttachments(files);
  if (!normalized.length) return [];
  if (!page?.evaluate || !page?.exposeFunction) throw new Error('[perplexity] File uploads require the managed browser page context.');
  const uploadTimeoutMs = resolvePerplexityUploadTimeoutMs(timeoutMs);
  const uploaded = [];
  for (const attachment of normalized) uploaded.push(await uploadPerplexityAttachmentInBrowser({ page, attachment, timeoutMs: uploadTimeoutMs }));
  return uploaded;
}

export async function validatePerplexitySession({ fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('[perplexity] Session validation requires the managed browser network transport.');
  const response = await fetchImpl(`${API_BASE_URL}/api/auth/session`, {
    headers: buildPerplexityHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    const body = await responseText(response);
    const detail = `auth session check HTTP ${response.status}: ${body}`;
    if (isAuthenticationStatus(response.status)) throw perplexityAuthError({ detail });
    throw new Error(`Perplexity auth session check failed: ${redactPerplexitySecrets(detail)}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw perplexityAuthError({ detail: `auth session endpoint did not return JSON: ${error.message}` });
  }

  const user = data?.user;
  if (!user || typeof user !== 'object' || !user.id) {
    throw perplexityAuthError({ detail: 'auth session endpoint did not return a logged-in user' });
  }

  return {
    authenticated: true,
    source: AUTH_SOURCE_BROWSER_TOOLS,
    user_present: true,
    user_id_present: true,
  };
}

function currentPerplexityText(state) {
  return state.answer || state.chunks.at(-1) || state.chunks.join('') || '';
}

function currentPerplexityStreamText(state) {
  return state.streamText || state.chunks.at(-1) || state.chunks.join('') || currentPerplexityText(state);
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
  const currentText = currentPerplexityStreamText(state);
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

export async function streamPerplexity({ payload, timeoutMs, citationMode, fetchImpl, authPrevalidated = false, onProgress = null }) {
  if (typeof fetchImpl !== 'function') throw new Error('[perplexity] Streaming requires the managed browser network transport.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = buildPerplexityHeaders();

  try {
    const response = await fetchImpl(`${API_BASE_URL}${ENDPOINT_ASK}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await responseText(response);
      const detail = `Perplexity HTTP ${response.status}: ${body}`;
      if (response.status === 401 || (response.status === 403 && !authPrevalidated)) throw perplexityAuthError({ detail });
      if (response.status === 403) throw new Error(`Perplexity model rejected or unavailable: ${redactPerplexitySecrets(detail)}`);
      throw new Error(redactPerplexitySecrets(detail));
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
  const normalized = normalizePerplexityOptions(providerOptions);
  return {
    attachments: normalizePerplexityFileAttachments(fileInputsFromOptions(providerOptions)),
    spaceUuid: normalized.spaceUuid,
  };
}

async function preparePerplexityProviderRequestOptions({ request, normalized, fetchImpl, page, timeoutMs = DEFAULT_PERPLEXITY_UPLOAD_TIMEOUT_MS }) {
  const uploadedAttachments = normalized.attachments.length
    ? await uploadPerplexityAttachments({ attachments: normalized.attachments, page, timeoutMs })
    : [];
  return {
    ...(request.providerOptions || {}),
    spaceUuid: normalized.spaceUuid,
    uploadedAttachments,
  };
}

export async function verifyPerplexityModels({ models, timeoutMs, streamFn = streamPerplexity }) {
  const verifiedAt = new Date().toISOString();
  const prompt = 'AI_CHAT_MODEL_CHECK';
  const verified = [];
  for (const model of models) {
    const payload = buildPerplexityPayload({
      query: `Reply exactly: ${prompt}`,
      model,
      options: { incognito: true, sourceFocus: 'web', searchFocus: 'web' },
    });
    try {
      const state = await streamFn({ payload, timeoutMs, citationMode: 'clean', model, authPrevalidated: true });
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
      const errorMessage = redactPerplexitySecrets(error.message);
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

export async function openPerplexityNetworkPage(browser) {
  const pages = await browser.pages();
  let page = pages.find(candidate => candidate.url() === PERPLEXITY_NETWORK_BOOTSTRAP_URL);
  if (!page) page = await browser.newPage({ background: true });
  if (page.url() !== PERPLEXITY_NETWORK_BOOTSTRAP_URL) {
    await page.goto(PERPLEXITY_NETWORK_BOOTSTRAP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  return page;
}

export const perplexityProvider = {
  name: 'perplexity',
  url: API_BASE_URL,
  trustedConversationHostnames: PERPLEXITY_HOSTNAMES,
  transport: 'browser-network-sse',
  preferredBrowserHeadless: true,

  defaultModel: DEFAULT_PERPLEXITY_MODEL,
  taskModels: {
    default: DEFAULT_PERPLEXITY_MODEL,
    quick_web: DEFAULT_PERPLEXITY_MODEL,
    deep_research: 'perplexity/deep-research',
    sonar: 'perplexity/sonar-2',
    reasoning: 'openai/gpt-5.6-terra-thinking',
    coding: 'openai/gpt-5.6-terra',
  },
  historyPolicy: {
    default: 'persistent',
    incognitoFlag: '--incognito',
    saveFlag: '--save-to-library',
    transportField: 'params.is_incognito',
  },
  resolveConversationAttachment: resolvePerplexityConversationAttachment,
  conversationUrlFromState({ conversation } = {}) {
    const continuation = previousPerplexityContinuationState(conversation);
    return perplexityConversationUrl(continuation.backendUuid) || conversation?.url || null;
  },

  listModelsRequiresBrowser({ request } = {}) {
    return !!request?.verifyModels;
  },

  async listModels({ browser, request } = {}) {
    const baseModels = MODELS.map(annotatePerplexityModel);
    if (!request?.verifyModels) {
      return {
        model_source: 'browser-tools-network-contract-registry',
        account_specific: false,
        verification: { enabled: false },
        models: baseModels,
      };
    }

    const page = await openPerplexityNetworkPage(browser);
    const fetchImpl = createPerplexityBrowserFetch(page);
    const authSession = await validatePerplexitySession({ fetchImpl });
    const verifiedModels = await verifyPerplexityModels({
      models: baseModels,
      timeoutMs: (request.verifyModelTimeoutSeconds || 90) * 1000,
      streamFn: args => streamPerplexity({ ...args, fetchImpl }),
    });
    return {
      model_source: 'browser-tools-network-contract-registry',
      account_specific: true,
      auth_session: authSession,
      verification: verifiedModels.verification,
      models: verifiedModels.models,
    };
  },

  async run({ browser, request, selectedModel, conversation }) {
    const model = resolvePerplexityRequestModel({ request, selectedModel });
    const normalizedOptions = normalizePerplexityProviderRequestOptions(request.providerOptions || {});
    if (normalizePerplexityOptions(request.providerOptions || {}).incognito && previousPerplexityContinuationState(conversation).backendUuid) {
      throw new Error('[perplexity] --incognito cannot continue or attach an existing conversation. Start a new Incognito query without --conversation or --attach-conversation.');
    }
    const page = await openPerplexityNetworkPage(browser);
    const fetchImpl = createPerplexityBrowserFetch(page);
    const authSession = await validatePerplexitySession({ fetchImpl });
    const requestTimeoutMs = resolvePerplexityTimeoutSeconds({ model, request }) * 1000;
    const effectiveOptions = await preparePerplexityProviderRequestOptions({ request, normalized: normalizedOptions, fetchImpl, page, timeoutMs: requestTimeoutMs });
    console.error(`[perplexity] Model resolved: ${model.id}`);
    const payload = buildPerplexityPayload({
      query: request.prompt,
      model,
      options: effectiveOptions,
      conversation,
    });
    const state = await streamPerplexity({
      payload,
      timeoutMs: requestTimeoutMs,
      citationMode: request.providerOptions?.citationMode || 'clean',
      fetchImpl,
      authPrevalidated: !!authSession.authenticated,
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
      requestedModelIdentifier: model.identifier,
      responseModelIdentifier: state.displayModel,
      userSelectedModelIdentifier: state.userSelectedModel,
      isIncognito: payload.params.is_incognito,
      incognitoExplicit: payload.requestMetadata.incognito_explicit,
      privacyState: state.privacyState,
      expiresAt: state.expiresAt,
      reconnectable: state.reconnectable,
      threadAccess: state.threadAccess,
      attachments: effectiveOptions.uploadedAttachments,
      spaceUuid: effectiveOptions.spaceUuid,
      streamState,
    });
    return attachPrivateProviderState({
      text,
      rawText: text,
      done: !!state.done,
      modelUsed: model.id,
      finalUrl: perplexityConversationUrl(state.backendUuid || previousContinuation.backendUuid),
      providerState: providerStates.providerState,
      attachments: payload.requestMetadata.attachments,
      searchResults: state.searchResults || [],
      rawData: state.rawData || {},
    }, providerStates.privateProviderState);
  },

};
