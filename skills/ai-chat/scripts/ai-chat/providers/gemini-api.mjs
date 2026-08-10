import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { execFile } from 'node:child_process';

export const GOOGLE_ORIGINS = [
  'https://gemini.google.com',
  'https://accounts.google.com',
  'https://www.google.com',
];

const ALL_COOKIE_NAMES = new Set([
  '__Secure-1PSID', '__Secure-1PSIDTS', '__Secure-1PSIDCC', '__Secure-1PAPISID',
  'NID', 'AEC', 'SOCS', '__Secure-BUCKET', '__Secure-ENID',
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-3PSID', '__Secure-3PSIDTS', '__Secure-3PAPISID', 'SIDCC',
]);

const REQUIRED_COOKIES = ['__Secure-1PSID'];
const CHROME_USER_DATA_DIR = join(homedir(), 'Library/Application Support/Google/Chrome');
const DEFAULT_CHROME_PROFILE = 'Default';

export function resolveChromeCookiesPath(options = {}) {
  if (options.cookiesPath) return options.cookiesPath;
  if (process.env.AI_CHAT_CHROME_COOKIES_PATH) return process.env.AI_CHAT_CHROME_COOKIES_PATH;
  const profile = options.chromeProfile || process.env.AI_CHAT_CHROME_PROFILE || DEFAULT_CHROME_PROFILE;
  return join(CHROME_USER_DATA_DIR, profile, 'Cookies');
}

export function resolveChromeProfileName(options = {}) {
  if (options.cookiesPath || process.env.AI_CHAT_CHROME_COOKIES_PATH) return null;
  return options.chromeProfile || process.env.AI_CHAT_CHROME_PROFILE || DEFAULT_CHROME_PROFILE;
}
const GEMINI_APP_URL = 'https://gemini.google.com/app';
const GEMINI_BATCH_URL = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';
const GEMINI_STREAM_URL = 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const GEMINI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GEMINI_MODEL_HEADER = 'x-goog-ext-525001261-jspb';
const GEMINI_REQUEST_ID_HEADER = 'x-goog-ext-525005358-jspb';
const GEMINI_USER_STATUS_RPC = 'otAQ7b';
const DEFAULT_METADATA = ['', '', '', null, null, null, null, null, null, ''];

export const GEMINI_MODELS = [
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    model_id: '56fdd199312815e2',
    capacity_tail: 2,
    capacity_field: 12,
    min_tier: 'basic',
    family: 'gemini-3.6',
    thinking: false,
    ui_choice: '3.6 Flash',
    ui_selected: 'Gemini Flash',
    aliases: ['flash', 'quick'],
    known: true,
  },
  {
    id: 'gemini-3.6-flash-extended-thinking',
    name: 'Gemini 3.6 Flash Extended Thinking',
    model_id: 'e051ce1aa80aa576',
    capacity_tail: 2,
    capacity_field: 12,
    min_tier: 'basic',
    family: 'gemini-3.6',
    thinking: true,
    ui_choice: 'Extended thinking',
    ui_selected: 'Flash Extended',
    aliases: ['thinking', 'extended-thinking', 'reasoning'],
    known: true,
  },
];

const GEMINI_MODEL_BY_ID = new Map(GEMINI_MODELS.flatMap(model => [
  [model.id.toLowerCase(), model],
  [model.name.toLowerCase(), model],
  [model.model_id.toLowerCase(), model],
  ...(model.aliases || []).map(alias => [alias.toLowerCase(), model]),
]));

export function resolveGeminiModel(modelName = 'flash') {
  const normalized = String(modelName || 'flash').toLowerCase();
  if (normalized === 'default') return GEMINI_MODEL_BY_ID.get('flash');
  return GEMINI_MODEL_BY_ID.get(normalized) || null;
}

export function buildGeminiModelHeader(model) {
  const modelId = model?.model_id;
  if (!modelId) throw new Error(`Gemini model has no transport model_id: ${model?.id || 'unknown'}`);
  const capacity = model.capacity_tail ?? model.capacity ?? 1;
  const capacityField = model.capacity_field ?? 12;
  const tail = capacityField === 13 ? `null,${capacity}` : String(capacity);
  return `[1,null,null,null,"${modelId}",null,null,0,[4],null,null,${tail}]`;
}

let sqliteModule = null;

async function importSqlite() {
  if (sqliteModule) return sqliteModule;
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning, ...args) => {
    const message = typeof warning === 'string' ? warning : warning?.message || '';
    if (message.includes('SQLite is an experimental feature')) return;
    return originalEmitWarning(warning, ...args);
  });
  try {
    sqliteModule = await import('node:sqlite');
    return sqliteModule;
  } catch {
    return null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function supportsReadBigInts() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 24) return true;
  if (major < 24) return false;
  return minor >= 4;
}

function readKeychainPassword() {
  return new Promise(resolve => {
    execFile('security', ['find-generic-password', '-w', '-a', 'Chrome', '-s', 'Chrome Safe Storage'], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(stdout.trim() || null);
    });
  });
}

function expandHosts(host) {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 1) return [host];
  const candidates = new Set([host]);
  for (let index = 1; index <= parts.length - 2; index += 1) candidates.add(parts.slice(index).join('.'));
  return [...candidates];
}

function copySidecar(srcDb, targetDb, suffix) {
  const sidecar = `${srcDb}${suffix}`;
  if (!existsSync(sidecar)) return;
  try { copyFileSync(sidecar, `${targetDb}${suffix}`); } catch {}
}

function removePkcs7Padding(buffer) {
  if (!buffer.length) return buffer;
  const padding = buffer[buffer.length - 1];
  if (!padding || padding > 16) return buffer;
  return buffer.subarray(0, buffer.length - padding);
}

function decryptCookieValue(encrypted, key, stripHash) {
  const buffer = Buffer.from(encrypted);
  if (buffer.length < 3) return null;
  const prefix = buffer.subarray(0, 3).toString('utf8');
  if (!/^v\d\d$/.test(prefix)) return null;
  const ciphertext = buffer.subarray(3);
  if (!ciphertext.length) return '';
  try {
    const iv = Buffer.alloc(16, 0x20);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const unpadded = removePkcs7Padding(plaintext);
    const bytes = stripHash && unpadded.length >= 32 ? unpadded.subarray(32) : unpadded;
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let index = 0;
    while (index < decoded.length && decoded.charCodeAt(index) < 0x20) index += 1;
    return decoded.slice(index);
  } catch {
    return null;
  }
}

export async function getGoogleCookies(options = {}) {
  if (platform() !== 'darwin') return null;
  const chromeCookiesPath = resolveChromeCookiesPath(options);
  if (!existsSync(chromeCookiesPath)) return null;

  const password = await readKeychainPassword();
  if (!password) return null;

  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-chat-chrome-cookies-'));

  try {
    const tempDb = join(tempDir, 'Cookies');
    copyFileSync(chromeCookiesPath, tempDb);
    copySidecar(chromeCookiesPath, tempDb, '-wal');
    copySidecar(chromeCookiesPath, tempDb, '-shm');

    const sqlite = await importSqlite();
    if (!sqlite) return null;

    const options = { readOnly: true };
    if (supportsReadBigInts()) options.readBigInts = true;
    const db = new sqlite.DatabaseSync(tempDb, options);

    let metaVersion = 0;
    try {
      const rows = db.prepare("SELECT value FROM meta WHERE key = 'version'").all();
      const value = rows[0]?.value;
      if (typeof value === 'number') metaVersion = Math.floor(value);
      else if (typeof value === 'bigint') metaVersion = Number(value);
      else if (typeof value === 'string') metaVersion = Number.parseInt(value, 10) || 0;
    } catch {}
    const stripHash = metaVersion >= 24;

    const hosts = GOOGLE_ORIGINS.map(origin => new URL(origin).hostname);
    const clauses = [];
    for (const host of hosts) {
      for (const candidate of expandHosts(host)) {
        const escaped = candidate.replaceAll("'", "''");
        clauses.push(`host_key = '${escaped}'`);
        clauses.push(`host_key = '.${escaped}'`);
        clauses.push(`host_key LIKE '%.${escaped}'`);
      }
    }

    let rows;
    try {
      rows = db.prepare(`SELECT name, value, host_key, encrypted_value FROM cookies WHERE (${clauses.join(' OR ')}) ORDER BY expires_utc DESC`).all();
    } catch {
      db.close();
      return null;
    }

    const cookies = {};
    for (const row of rows) {
      const name = row.name;
      if (!ALL_COOKIE_NAMES.has(name)) continue;
      if (cookies[name]) continue;

      let value = typeof row.value === 'string' && row.value.length > 0 ? row.value : null;
      if (!value && row.encrypted_value instanceof Uint8Array) value = decryptCookieValue(row.encrypted_value, key, stripHash);
      if (value) cookies[name] = value;
    }

    db.close();
    if (!hasRequiredGoogleCookies(cookies)) return null;
    return cookies;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function hasRequiredGoogleCookies(cookieMap) {
  return REQUIRED_COOKIES.every(name => Boolean(cookieMap?.[name]));
}

export function browserCookiesToGoogleCookieMap(cookies = []) {
  const cookieMap = {};
  for (const cookie of cookies || []) {
    const name = cookie?.name;
    const value = cookie?.value;
    if (!ALL_COOKIE_NAMES.has(name)) continue;
    if (cookieMap[name]) continue;
    if (typeof value === 'string' && value.length > 0) cookieMap[name] = value;
  }
  return cookieMap;
}

export function classifyGeminiUiState({ url = '', title = '', text = '', promptInput = false, accountButton = false } = {}) {
  const normalizedUrl = String(url || '');
  const normalizedTitle = String(title || '');
  const normalizedText = String(text || '');
  let host = '';
  try { host = new URL(normalizedUrl).hostname; } catch {}

  const consentRequired = host === 'consent.google.com'
    || /Before you continue to Google|Reject all\s+Accept all|Accept all\s+More options/i.test(normalizedText);
  const signInRequired = !consentRequired && (
    host === 'accounts.google.com'
    || /\bSign in\b/i.test(normalizedTitle)
    || (/\bSign in\b/i.test(normalizedText) && !accountButton)
  );
  const unsupportedCountry = /Gemini isn't currently supported|not currently available/i.test(normalizedText);
  const appHost = host === 'gemini.google.com';
  const ready = appHost && !!promptInput && !consentRequired && !signInRequired && !unsupportedCountry;

  let reason = 'gemini_app_ready';
  if (consentRequired) reason = 'google_consent_required';
  else if (signInRequired) reason = 'google_sign_in_required';
  else if (unsupportedCountry) reason = 'unsupported_region_or_account';
  else if (!appHost) reason = 'not_on_gemini_app';
  else if (!promptInput) reason = 'prompt_input_not_visible';

  return {
    ready,
    reason,
    final_url: normalizedUrl,
    title: normalizedTitle,
    prompt_input: !!promptInput,
    account_button: !!accountButton,
    consent_required: consentRequired,
    sign_in_required: signInRequired,
    unsupported_region_or_account: unsupportedCountry,
  };
}

export function buildGeminiCookieHeader(cookieMap) {
  return Object.entries(cookieMap)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function fetchWithCookieRedirects(url, cookieHeader, maxRedirects, signal) {
  let current = url;
  for (let index = 0; index <= maxRedirects; index += 1) {
    const response = await fetch(current, {
      headers: { 'user-agent': GEMINI_USER_AGENT, cookie: cookieHeader },
      redirect: 'manual',
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        current = new URL(location, current).toString();
        continue;
      }
    }
    return await response.text();
  }
  throw new Error(`Too many redirects (>${maxRedirects})`);
}

export async function fetchGeminiPageData(cookieHeader, signal) {
  const html = await fetchWithCookieRedirects(GEMINI_APP_URL, cookieHeader, 10, signal);
  let token = '';
  for (const key of ['SNlM0e', 'thykhd']) {
    const match = html.match(new RegExp(`"${key}":"(.*?)"`));
    if (match?.[1]) { token = match[1]; break; }
  }
  if (!token) throw new Error('Unable to authenticate with Gemini. Make sure Chrome is signed into gemini.google.com.');
  const getVal = key => html.match(new RegExp(`"${key}":"(.*?)"`))?.[1] || '';
  return { token, pctx: getVal('Ylro7b'), bl: getVal('cfb2h'), sid: getVal('FdrFJe') };
}

function slugifyModelName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function computeGeminiCapacity(tierFlags = [], capabilityFlags = []) {
  if (tierFlags.includes(21)) return { capacity: 1, capacity_field: 13 };
  if (tierFlags.includes(22)) return { capacity: 2, capacity_field: 13 };
  if (capabilityFlags.includes(115)) return { capacity: 4, capacity_field: 12 };
  if (tierFlags.includes(16) || capabilityFlags.includes(106)) return { capacity: 3, capacity_field: 12 };
  if (tierFlags.includes(8) || (!capabilityFlags.includes(106) && capabilityFlags.includes(19))) return { capacity: 2, capacity_field: 12 };
  return { capacity: 1, capacity_field: 12 };
}

function parseGoogleBatchParts(rawText) {
  let body = rawText || '';
  if (body.startsWith(")]}'")) body = body.slice(4);
  const parts = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) continue;
      for (const part of parsed) if (Array.isArray(part)) parts.push(part);
    } catch {}
  }
  return parts;
}

function enrichGeminiAccountModel(modelData, account) {
  const modelId = getNestedValue(modelData, [0]);
  const displayName = getNestedValue(modelData, [1]) || '';
  const description = getNestedValue(modelData, [2]) || '';
  if (!modelId || !displayName) return null;

  const staticByModelId = GEMINI_MODELS.find(model => model.model_id === modelId);
  if (!staticByModelId) return null;
  const capacity = account.capacity;
  const capacityField = account.capacity_field;
  const id = staticByModelId.id;
  const name = staticByModelId.name;
  const thinking = /think|thinking/i.test(`${id} ${name} ${displayName} ${description}`);
  return {
    ...(staticByModelId || {}),
    id,
    name,
    display_name: displayName,
    description,
    model_id: modelId,
    capacity,
    capacity_field: capacityField,
    capacity_tail: capacityField === 12 ? capacity : null,
    account_specific: true,
    available: account.account_status_code == null || account.account_status_code === 1000,
    account_status_code: account.account_status_code,
    tier_flags: account.tier_flags,
    capability_flags: account.capability_flags,
    source: 'gemini-account-rpc',
    thinking,
    aliases: uniqueStrings([...(staticByModelId?.aliases || []), displayName, name, modelId]),
  };
}

export function parseGeminiAccountModelsResponse(rawText) {
  const models = [];
  let accountStatusCode = null;
  let tierFlags = [];
  let capabilityFlags = [];

  for (const part of parseGoogleBatchParts(rawText)) {
    const bodyString = getNestedValue(part, [2]);
    if (!bodyString || typeof bodyString !== 'string') continue;
    try {
      const body = JSON.parse(bodyString);
      const modelList = getNestedValue(body, [15]);
      if (!Array.isArray(modelList)) continue;
      accountStatusCode = getNestedValue(body, [14]) ?? accountStatusCode;
      tierFlags = Array.isArray(getNestedValue(body, [16])) ? getNestedValue(body, [16]) : [];
      capabilityFlags = Array.isArray(getNestedValue(body, [17])) ? getNestedValue(body, [17]) : [];
      const capacity = computeGeminiCapacity(tierFlags, capabilityFlags);
      for (const modelData of modelList) {
        if (!Array.isArray(modelData)) continue;
        const model = enrichGeminiAccountModel(modelData, {
          ...capacity,
          account_status_code: accountStatusCode,
          tier_flags: tierFlags,
          capability_flags: capabilityFlags,
        });
        if (model) models.push(model);
      }
    } catch {}
  }

  return { models, account_status_code: accountStatusCode, tier_flags: tierFlags, capability_flags: capabilityFlags };
}

export async function fetchGeminiAccountModels(cookieMap, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const effectiveSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const cookieHeader = buildGeminiCookieHeader(cookieMap);
  const pageData = await fetchGeminiPageData(cookieHeader, effectiveSignal);

  const reqParams = new URLSearchParams();
  reqParams.set('rpcids', GEMINI_USER_STATUS_RPC);
  reqParams.set('hl', 'en');
  reqParams.set('_reqid', String(Math.floor(Math.random() * 90000) + 10000));
  reqParams.set('rt', 'c');
  reqParams.set('source-path', '/app');
  if (pageData.bl) reqParams.set('bl', pageData.bl);
  if (pageData.sid) reqParams.set('f.sid', pageData.sid);

  const bodyParams = new URLSearchParams();
  bodyParams.set('at', pageData.token);
  bodyParams.set('f.req', JSON.stringify([[[GEMINI_USER_STATUS_RPC, '[]', null, 'generic']]]));

  const response = await fetch(`${GEMINI_BATCH_URL}?${reqParams.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      origin: 'https://gemini.google.com',
      referer: 'https://gemini.google.com/',
      'x-same-domain': '1',
      'user-agent': GEMINI_USER_AGENT,
      cookie: cookieHeader,
      [GEMINI_MODEL_HEADER]: '[1,null,null,null,null,null,null,null,[4]]',
      'x-goog-ext-73010989-jspb': '[0]',
    },
    body: bodyParams.toString(),
    signal: effectiveSignal,
  });

  const rawText = await response.text();
  if (!response.ok) throw new Error(`Gemini model discovery failed: ${response.status}`);
  return { ...parseGeminiAccountModelsResponse(rawText), rawText };
}

function getNestedValue(value, pathParts) {
  let current = value;
  for (const part of pathParts) {
    if (current == null || !Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function parseGeminiStreamResponse(rawText) {
  let bestText = '';
  let errorCode;
  let conversationId;
  let responseId;
  let choiceId;
  let metadata;
  let body = rawText;
  if (body.startsWith(")]}'")) body = body.slice(4);

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) continue;
    try {
      const json = JSON.parse(trimmed);
      if (!Array.isArray(json)) continue;
      for (const part of json) {
        const code = getNestedValue(part, [5, 2, 0, 1, 0]);
        if (typeof code === 'number' && code >= 0 && !errorCode) errorCode = code;
        const innerStr = getNestedValue(part, [2]);
        if (!innerStr || typeof innerStr !== 'string') continue;
        try {
          const parsed = JSON.parse(innerStr);
          const ids = getNestedValue(parsed, [1]);
          if (Array.isArray(ids)) {
            metadata = ids;
            if (typeof ids[0] === 'string') conversationId = ids[0];
            if (typeof ids[1] === 'string') responseId = ids[1];
          }
          const candidateList = getNestedValue(parsed, [4]);
          if (!Array.isArray(candidateList)) continue;
          for (const candidate of candidateList) {
            if (typeof candidate?.[0] === 'string') choiceId = candidate[0];
            let text = getNestedValue(candidate, [1, 0]) || '';
            if (/^http:\/\/googleusercontent\.com\/card_content\/\d+/.test(text)) {
              const alt = getNestedValue(candidate, [22, 0]);
              if (alt) text = alt;
            }
            text = String(text).replace(/http:\/\/googleusercontent\.com\/\w+\/\d+\n*/g, '');
            if (text.length > bestText.length) bestText = text;
          }
        } catch {}
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

export function buildGeminiInnerRequest({ prompt, conversationState = {}, temporary = true, requestUuid = crypto.randomUUID().toUpperCase() }) {
  const messageContent = [prompt, 0, null, null, null, null, 0];
  const innerReqList = new Array(69).fill(null);
  innerReqList[0] = messageContent;
  innerReqList[1] = ['en'];
  innerReqList[2] = Array.isArray(conversationState.metadata) ? conversationState.metadata : DEFAULT_METADATA;
  innerReqList[6] = [1];
  innerReqList[7] = 1;
  innerReqList[10] = 1;
  innerReqList[11] = 0;
  innerReqList[17] = [[0]];
  innerReqList[18] = 0;
  innerReqList[27] = 1;
  innerReqList[30] = [4];
  innerReqList[41] = [1];
  if (temporary) innerReqList[45] = 1;
  innerReqList[53] = 0;
  innerReqList[59] = requestUuid;
  innerReqList[61] = [];
  innerReqList[68] = 2;
  return { innerReqList, requestUuid, fReq: JSON.stringify([null, JSON.stringify(innerReqList)]) };
}

export async function queryGeminiWeb(prompt, cookieMap, options = {}) {
  const resolvedModel = options.modelConfig || resolveGeminiModel(options.model || 'flash') || resolveGeminiModel('flash');
  const model = resolvedModel.id;
  const modelHeader = buildGeminiModelHeader(resolvedModel);
  const timeoutMs = options.timeoutMs || 120000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const effectiveSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const cookieHeader = buildGeminiCookieHeader(cookieMap);
  const pageData = await fetchGeminiPageData(cookieHeader, effectiveSignal);

  const { requestUuid, fReq } = buildGeminiInnerRequest({
    prompt,
    conversationState: options.conversationState || {},
    temporary: options.temporary !== false,
  });

  const reqParams = new URLSearchParams();
  reqParams.set('hl', 'en');
  reqParams.set('_reqid', String(Math.floor(Math.random() * 90000) + 10000));
  reqParams.set('rt', 'c');
  if (pageData.bl) reqParams.set('bl', pageData.bl);
  if (pageData.sid) reqParams.set('f.sid', pageData.sid);

  const bodyParams = new URLSearchParams();
  bodyParams.set('at', pageData.token);
  bodyParams.set('f.req', fReq);

  const response = await fetch(`${GEMINI_STREAM_URL}?${reqParams.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      host: 'gemini.google.com',
      origin: 'https://gemini.google.com',
      referer: 'https://gemini.google.com/',
      'x-same-domain': '1',
      'user-agent': GEMINI_USER_AGENT,
      cookie: cookieHeader,
      [GEMINI_MODEL_HEADER]: modelHeader,
      'x-goog-ext-73010989-jspb': '[0]',
      'x-goog-ext-73010990-jspb': '[0]',
      [GEMINI_REQUEST_ID_HEADER]: `["${requestUuid}",1]`,
    },
    body: bodyParams.toString(),
    signal: effectiveSignal,
  });

  const rawText = await response.text();
  if (process.env.AI_CHAT_GEMINI_RAW_OUT) writeFileSync(process.env.AI_CHAT_GEMINI_RAW_OUT, rawText, 'utf-8');
  if (!response.ok) throw new Error(`Gemini request failed: ${response.status}`);
  const result = parseGeminiStreamResponse(rawText);
  if (result.errorCode === 1052 && options.allowModelFallback !== false && model !== 'gemini-3.6-flash') {
    const fallback = await queryGeminiWeb(prompt, cookieMap, { ...options, model: 'gemini-3.6-flash', modelConfig: null });
    return { ...fallback, modelFallbackFrom: model, modelFallbackReason: 'error_1052' };
  }
  if (!result.text) {
    const error = new Error(result.errorCode ? `Gemini Web returned error ${result.errorCode}` : 'Gemini Web returned empty response');
    error.errorCode = result.errorCode || null;
    error.model = model;
    error.rawText = rawText;
    throw error;
  }
  return {
    text: result.text,
    rawText,
    modelUsed: model,
    errorCode: result.errorCode,
    conversationState: {
      conversation_id: result.conversationId || null,
      response_id: result.responseId || null,
      choice_id: result.choiceId || null,
      metadata: result.metadata || null,
    },
  };
}
