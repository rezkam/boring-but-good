import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, parse, resolve } from 'node:path';
import { activePage, connectBrowser } from './browser-control.mjs';

export const HAR_RESOURCE_TYPES = [
  'Document',
  'Stylesheet',
  'Image',
  'Media',
  'Font',
  'Script',
  'TextTrack',
  'XHR',
  'Fetch',
  'Prefetch',
  'EventSource',
  'Manifest',
  'SignedExchange',
  'Ping',
  'CSPViolationReport',
  'Preflight',
  'FedCM',
  'Other',
];

export const HAR_RESOURCE_PRESETS = {
  api: ['XHR', 'Fetch', 'Preflight', 'EventSource'],
  page: ['Document', 'Script', 'Stylesheet', 'XHR', 'Fetch'],
  all: [...HAR_RESOURCE_TYPES],
};

export const BLOCKED_CDP_METHODS = new Set([
  'Browser.close',
  'Browser.crash',
  'Page.close',
  'Page.crash',
  'Target.attachToBrowserTarget',
  'Target.closeTarget',
  'Target.detachFromTarget',
  'Target.disposeBrowserContext',
  'Target.sendMessageToTarget',
]);

const SENSITIVE_NAME = /(?:^|[-_])(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|session|csrf|xsrf)(?:$|[-_])/i;
const URL_HEADER_NAME = /^(?:content-location|location|origin|referer|referrer)$/i;
const GENERIC_CAPTURE_STEMS = new Set(['capture', 'network', 'output', 'recording', 'trace', 'untitled', 'test']);

export function validateCdpMethod(value, { allowBlocked = false } = {}) {
  if (!value || !/^[A-Z][A-Za-z0-9]*\.[a-zA-Z][A-Za-z0-9]*$/.test(value)) {
    throw new Error(`Invalid CDP method: ${value || '<missing>'}. Expected Domain.method`);
  }
  if (!allowBlocked && BLOCKED_CDP_METHODS.has(value)) {
    throw new Error(`CDP method ${value} is blocked because it bypasses managed-browser lifecycle safety`);
  }
  return value;
}

export function rawOptionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value after ${name}`);
    values.push(String(value));
    index += 1;
  }
  return values;
}

export function optionValues(args, name) {
  return rawOptionValues(args, name)
    .flatMap((value) => value.split(',').map((part) => part.trim()).filter(Boolean));
}

export function patternOptionValues(args, name) {
  return rawOptionValues(args, name).map((value) => value.trim()).filter(Boolean);
}

export function normalizeResourceTypes(values, { allowEmpty = true } = {}) {
  if (!values.length && allowEmpty) return [];
  const canonical = new Map(HAR_RESOURCE_TYPES.map((type) => [type.toLowerCase(), type]));
  return [...new Set(values.map((value) => {
    const type = canonical.get(String(value).toLowerCase());
    if (!type) throw new Error(`Unsupported HAR resource type: ${value}. Expected one of: ${HAR_RESOURCE_TYPES.join(', ')}`);
    return type;
  }))];
}

export function resourceTypesForPreset(preset = 'all') {
  const types = HAR_RESOURCE_PRESETS[String(preset).toLowerCase()];
  if (!types) throw new Error(`Unknown capture preset: ${preset}. Expected api, page, or all`);
  return [...types];
}

export function globToRegExp(pattern) {
  let source = '';
  for (const character of String(pattern)) {
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

export function matchesPatterns(value, includes = [], excludes = []) {
  const text = String(value ?? '');
  if (excludes.some((pattern) => globToRegExp(pattern).test(text))) return false;
  return !includes.length || includes.some((pattern) => globToRegExp(pattern).test(text));
}

export function parseStatusSelectors(values) {
  return values.map((value) => {
    const match = String(value).match(/^(\d{3})(?:-(\d{3}))?$/);
    if (!match) throw new Error(`Invalid status selector: ${value}. Use a code or range such as 200-299`);
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (end < start) throw new Error(`Invalid status selector range: ${value}`);
    return { start, end };
  });
}

export function matchesStatus(status, includes = [], excludes = []) {
  const number = Number(status);
  const matches = (selector) => number >= selector.start && number <= selector.end;
  if (excludes.some(matches)) return false;
  return !includes.length || includes.some(matches);
}

export function redactUrl(value, { includeSensitive = false } = {}) {
  if (includeSensitive) return value;
  const text = String(value);
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveName(key)) url.searchParams.set(key, '<redacted>');
    }
    return url.toString();
  } catch {
    const hashIndex = text.indexOf('#');
    const beforeHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
    const hash = hashIndex >= 0 ? text.slice(hashIndex) : '';
    const queryIndex = beforeHash.indexOf('?');
    if (queryIndex < 0) return value;
    const params = new URLSearchParams(beforeHash.slice(queryIndex + 1));
    let changed = false;
    for (const key of [...params.keys()]) {
      if (isSensitiveName(key)) {
        params.set(key, '<redacted>');
        changed = true;
      }
    }
    return changed ? `${beforeHash.slice(0, queryIndex)}?${params}${hash}` : value;
  }
}

export function isSensitiveName(name) {
  const normalized = String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return SENSITIVE_NAME.test(normalized);
}

export function redactSensitive(value, { includeSensitive = false, parentKey = '' } = {}) {
  if (includeSensitive || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, { includeSensitive, parentKey }));
  }
  if (typeof value !== 'object') return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/headersText$/i.test(key) && typeof child === 'string') {
      result[key] = '<redacted>';
      continue;
    }
    if (/(?:^|_)(?:url|documenturl|redirecturl)$/i.test(key) && typeof child === 'string') {
      result[key] = redactUrl(child, { includeSensitive });
      continue;
    }
    if (/cookies?/i.test(key) && child && typeof child === 'object') {
      result[key] = redactSensitive(child, { includeSensitive, parentKey: 'cookies' });
      continue;
    }
    if (isSensitiveName(key)) {
      result[key] = '<redacted>';
      continue;
    }
    if (URL_HEADER_NAME.test(key) && typeof child === 'string') {
      result[key] = redactUrl(child, { includeSensitive });
      continue;
    }
    if (key === 'value' && isSensitiveName(value.name)) {
      result[key] = '<redacted>';
      continue;
    }
    if (key === 'value' && URL_HEADER_NAME.test(value.name) && typeof child === 'string') {
      result[key] = redactUrl(child, { includeSensitive });
      continue;
    }
    if (key === 'value' && /cookies?|associatedcookies/i.test(parentKey)) {
      result[key] = '<redacted>';
      continue;
    }
    if (key === 'payloadData' && /websocket/i.test(parentKey)) {
      result[key] = '<redacted>';
      continue;
    }
    result[key] = redactSensitive(child, { includeSensitive, parentKey: key });
  }
  return result;
}

export function redactHeaders(headers = {}, { includeSensitive = false } = {}) {
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: includeSensitive
      ? String(value)
      : (isSensitiveName(name)
        ? '<redacted>'
        : (URL_HEADER_NAME.test(name) ? redactUrl(value) : String(value))),
  }));
}

export function redactBodyText(text, mimeType = '', { includeSensitive = false } = {}) {
  if (includeSensitive || text === undefined || text === null) return text;
  const value = String(text);
  const normalizedMime = String(mimeType).toLowerCase();
  if (normalizedMime.includes('json') || /^[\s]*[\[{]/.test(value)) {
    try {
      return JSON.stringify(redactSensitive(JSON.parse(value)));
    } catch {
      return '<redacted: malformed JSON>';
    }
  }
  const looksFormEncoded = normalizedMime.includes('application/x-www-form-urlencoded')
    || value.split('&').every((part) => /^[^=&\s]+=[^&]*$/.test(part));
  if (looksFormEncoded) {
    const params = new URLSearchParams(value);
    let changed = false;
    for (const key of [...params.keys()]) {
      if (isSensitiveName(key)) {
        params.set(key, '<redacted>');
        changed = true;
      }
    }
    return changed ? params.toString() : value;
  }
  return value;
}

export function openPrivateFile(file, flags) {
  const fd = openSync(file, flags, 0o600);
  try {
    chmodSync(file, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw new Error(`Could not make capture output private: ${file}: ${error.message}`);
  }
}

export function privateOutputPath(value, extension, { overwrite = false, cwd = process.cwd() } = {}) {
  if (!value || value === true || !String(value).trim()) {
    throw new Error(`Missing --output. Use a meaningful interaction-specific .${extension} filename`);
  }
  const path = resolve(cwd, String(value));
  if (extname(path).toLowerCase() !== `.${extension.toLowerCase()}`) {
    throw new Error(`Capture output must end in .${extension}: ${value}`);
  }
  const stem = parse(basename(path)).name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (GENERIC_CAPTURE_STEMS.has(stem)) {
    throw new Error(`Capture output name is too generic: ${basename(path)}. Describe the interaction, for example checkout_api_network.${extension}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !overwrite) {
    throw new Error(`Capture output already exists: ${path}. Choose another meaningful name or pass --overwrite`);
  }
  return path;
}

export function writePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort. Capture output may contain private request data.
  }
}

export async function withPageCdpSession(port, ownerToken, callback) {
  const browser = await connectBrowser(port, { ownerToken });
  let session;
  try {
    const page = await activePage(browser);
    session = await page.createCDPSession();
    return await callback({ browser, page, session });
  } finally {
    if (session && !session.detached) await session.detach().catch(() => {});
    browser.disconnect();
  }
}
