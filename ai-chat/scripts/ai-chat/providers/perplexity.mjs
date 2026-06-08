import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './shared.mjs';

const API_BASE_URL = 'https://www.perplexity.ai';
const ENDPOINT_ASK = '/rest/sse/perplexity_ask';
const ENDPOINT_SEARCH_INIT = '/search/new';
const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
const API_VERSION = '2.18';
const MODELS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'perplexity-models.json'), 'utf-8'));
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
const MODEL_BY_ID = new Map(MODELS.map(model => [model.id, model]));
const MODEL_BY_LABEL = new Map(MODELS.flatMap(model => [
  [model.name.toLowerCase(), model],
  [model.identifier.toLowerCase(), model],
  [model.id.toLowerCase(), model],
  [model.tool_name?.toLowerCase(), model],
].filter(([key]) => key)));

const SOURCE_MAP = { web: 'web', academic: 'scholar', social: 'social', finance: 'edgar', all: 'web' };
const SEARCH_MAP = { web: 'internet', writing: 'writing' };
const TIME_MAP = { all: '', day: 'DAY', week: 'WEEK', month: 'MONTH', year: 'YEAR' };

export function resolvePerplexityModel(modelName = 'perplexity/best') {
  const normalized = String(modelName || 'perplexity/best').toLowerCase();
  const alias = TASK_MODEL_ALIASES.get(normalized);
  return MODEL_BY_ID.get(modelName) || MODEL_BY_LABEL.get(normalized) || (alias ? MODEL_BY_ID.get(alias) : null) || null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
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
    source: 'bundled-registry-from-perplexity-webui-scraper',
    selected_by: uniqueStrings(['--model', model.id, model.name, model.identifier, model.tool_name]),
  };
}

export function buildPerplexityPayload({ query, model, options = {}, conversation = null }) {
  const sourceFocus = options.sourceFocus || 'web';
  const rawSources = Array.isArray(sourceFocus) ? sourceFocus : String(sourceFocus).split(',').map(s => s.trim()).filter(Boolean);
  const sources = rawSources.map(source => SOURCE_MAP[source] || 'web');
  const timeRange = options.timeRange || 'all';
  const providerState = conversation?.record?.provider_state || conversation?.providerState || null;

  const params = {
    attachments: [],
    language: options.language || 'en-US',
    timezone: options.timezone || null,
    client_coordinates: null,
    sources,
    model_preference: model.identifier,
    mode: model.mode,
    search_focus: SEARCH_MAP[options.searchFocus || 'web'] || 'internet',
    search_recency_filter: TIME_MAP[timeRange] || null,
    is_incognito: !options.saveToLibrary,
    use_schematized_api: false,
    local_search_enabled: false,
    prompt_source: 'user',
    send_back_text_in_streaming_api: true,
    version: API_VERSION,
  };

  if (providerState?.backend_uuid) {
    params.last_backend_uuid = providerState.backend_uuid;
    params.query_source = 'followup';
    if (providerState.read_write_token) params.read_write_token = providerState.read_write_token;
  }

  return { params, query_str: query };
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
  if (!text || citationMode === 'default') return text;
  return text.replace(/\[(\d{1,2})\]/g, (match, number) => {
    if (citationMode === 'clean') return '';
    const result = searchResults[Number(number) - 1];
    if (citationMode === 'markdown' && result?.url) return `[${number}](${result.url})`;
    return match;
  });
}

async function readSessionToken(page) {
  const cookies = await page.cookies(API_BASE_URL);
  const cookie = cookies.find(candidate => candidate.name === SESSION_COOKIE_NAME);
  if (!cookie?.value) throw new Error('Perplexity session cookie not found. Start Browser Tools with the logged-in profile and --sync. If managed Chrome is already running from a stale copy, stop it with --clean, restart with --sync, and retry.');
  return cookie.value;
}

async function streamPerplexity({ token, payload, timeoutMs, citationMode }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Accept: 'text/event-stream, application/json',
    'Content-Type': 'application/json',
    Referer: `${API_BASE_URL}/`,
    Origin: API_BASE_URL,
    Cookie: `${SESSION_COOKIE_NAME}=${token}`,
  };

  try {
    await fetch(`${API_BASE_URL}${ENDPOINT_SEARCH_INIT}?q=${encodeURIComponent(payload.query_str.slice(0, 2000))}`, { headers, signal: controller.signal });
    const response = await fetch(`${API_BASE_URL}${ENDPOINT_ASK}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Perplexity HTTP ${response.status}: ${await response.text()}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const state = { chunks: [], searchResults: [], rawData: {}, done: false };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = parseSseLine(line);
        if (!data) continue;
        extractPerplexityState(data, state, citationMode);
        if (state.done) return state;
      }
    }
    return state;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyPerplexityModels({ token, models, timeoutMs }) {
  const verifiedAt = new Date().toISOString();
  const verified = [];
  for (const model of models) {
    const payload = buildPerplexityPayload({
      query: 'Reply exactly: AI_CHAT_MODEL_CHECK',
      model,
      options: { saveToLibrary: false, sourceFocus: 'web', searchFocus: 'web' },
    });
    try {
      const state = await streamPerplexity({ token, payload, timeoutMs, citationMode: 'clean' });
      const text = state.answer || state.chunks.at(-1) || state.chunks.join('') || '';
      verified.push({
        ...model,
        available: true,
        verified_at: verifiedAt,
        verification: {
          status: text.includes('AI_CHAT_MODEL_CHECK') ? 'ok' : 'accepted_response_mismatch',
          response_chars: text.length,
          backend_uuid: state.backendUuid || null,
        },
      });
    } catch (error) {
      const clarification = /requested clarification/i.test(error.message);
      verified.push({
        ...model,
        available: clarification,
        verified_at: verifiedAt,
        verification: {
          status: clarification ? 'accepted_clarification_required' : 'failed',
          error: error.message,
        },
      });
    }
  }
  return verified;
}

export const perplexityProvider = {
  name: 'perplexity',
  url: API_BASE_URL,
  transport: 'webui-api',

  defaultModel: 'perplexity/best',
  taskModels: {
    default: 'perplexity/best',
    quick_web: 'perplexity/best',
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
    const token = await readSessionToken(page);
    const verifiedModels = await verifyPerplexityModels({
      token,
      models: baseModels,
      timeoutMs: (request.verifyModelTimeoutSeconds || 90) * 1000,
    });
    return {
      model_source: 'bundled-registry-from-perplexity-webui-scraper',
      account_specific: true,
      verification: {
        enabled: true,
        prompt: 'AI_CHAT_MODEL_CHECK',
        incognito: true,
      },
      models: verifiedModels,
    };
  },

  async run({ browser, request, selectedModel, conversation }) {
    const page = await this.findPage({ browser });
    const token = await readSessionToken(page);
    const model = resolvePerplexityModel(selectedModel === 'default' ? request.modelName : selectedModel) || resolvePerplexityModel('perplexity/best');
    console.error(`[perplexity] Model resolved: ${model.id}`);
    const payload = buildPerplexityPayload({
      query: request.prompt,
      model,
      options: request.providerOptions || {},
      conversation,
    });
    const state = await streamPerplexity({
      token,
      payload,
      timeoutMs: request.timeoutSeconds * 1000,
      citationMode: request.providerOptions?.citationMode || 'clean',
    });
    const text = state.answer || state.chunks.at(-1) || state.chunks.join('') || '';
    return {
      text,
      rawText: text,
      done: !!state.done || !!text,
      modelUsed: model.id,
      finalUrl: null,
      providerState: {
        backend_uuid: state.backendUuid || null,
        read_write_token: state.readWriteToken || null,
        is_incognito: payload.params.is_incognito,
        saved_to_library: !payload.params.is_incognito,
      },
      searchResults: state.searchResults || [],
      rawData: state.rawData || {},
    };
  },

  async findPage({ browser }) {
    const pages = await browser.pages();
    let page = pages.find(candidate => candidate.url().includes('perplexity.ai'));
    if (!page) page = await browser.newPage({ background: true });
    if (!page.url().includes('perplexity.ai')) await page.goto(API_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1000);
    return page;
  },

  async createAttemptContext({ page, request, selectedModel, conversation }) {
    const token = await readSessionToken(page);
    const model = resolvePerplexityModel(selectedModel === 'default' ? request.modelName : selectedModel) || resolvePerplexityModel('perplexity/best');
    return { token, model, conversation };
  },

  async setModel({ selectedModel }) {
    const model = resolvePerplexityModel(selectedModel);
    if (!model && selectedModel !== 'default') throw new Error(`[perplexity] Unknown model: ${selectedModel}`);
    console.error(`[perplexity] Model resolved: ${(model || resolvePerplexityModel('perplexity/best')).id}`);
  },

  async clearInput() {},
  async typePrompt() {},
  async submit() {},

  async waitForResponse({ request, timeoutMs, attemptContext }) {
    const model = attemptContext.model;
    const payload = buildPerplexityPayload({
      query: request.prompt,
      model,
      options: request.providerOptions || {},
      conversation: attemptContext.conversation,
    });
    const state = await streamPerplexity({
      token: attemptContext.token,
      payload,
      timeoutMs,
      citationMode: request.providerOptions?.citationMode || 'clean',
    });
    const text = state.answer || state.chunks.at(-1) || state.chunks.join('') || '';
    return {
      text,
      rawText: text,
      done: !!state.done || !!text,
      modelUsed: model.id,
      finalUrl: null,
      providerState: {
        backend_uuid: state.backendUuid || null,
        read_write_token: state.readWriteToken || null,
        is_incognito: payload.params.is_incognito,
        saved_to_library: !payload.params.is_incognito,
      },
      searchResults: state.searchResults || [],
      rawData: state.rawData || {},
    };
  },
};
