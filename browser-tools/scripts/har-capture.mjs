import { createRequire } from 'node:module';
import {
  hasFlag,
  optionValue,
  parsePositiveIntegerOption,
  sleep,
} from './browser-control.mjs';
import {
  isSensitiveName,
  matchesPatterns,
  matchesStatus,
  normalizeResourceTypes,
  optionValues,
  patternOptionValues,
  parseStatusSelectors,
  redactBodyText,
  redactHeaders,
  redactSensitive,
  redactUrl,
  resourceTypesForPreset,
  writePrivateJson,
} from './cdp-common.mjs';
import { parseBoundedNumber } from './gif-recorder.mjs';

const { version: BROWSER_TOOLS_VERSION } = createRequire(import.meta.url)('../package.json');

export const DEFAULT_HAR_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_HAR_MAX_DURATION_SECONDS = 300;
export const DEFAULT_HAR_IDLE_MS = 500;
export const DEFAULT_HAR_DRAIN_TIMEOUT_MS = 5000;
export const HAR_CAPTURE_COMPONENTS = ['headers', 'bodies', 'timing'];

function headerValue(headers, wanted) {
  const match = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === wanted.toLowerCase());
  return match ? String(match[1]) : '';
}

function queryString(url, redact) {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({
      name,
      value: redact && isSensitiveName(name)
        ? '<redacted>'
        : value,
    }));
  } catch {
    return [];
  }
}

function harHttpVersion(protocol) {
  const value = String(protocol || '').toLowerCase();
  if (value === 'h2') return 'HTTP/2';
  if (value === 'h3') return 'HTTP/3';
  if (value.startsWith('http/')) return value.toUpperCase();
  return protocol || 'HTTP/1.1';
}

function bodyMimeType(headers) {
  return headerValue(headers, 'content-type').split(';')[0] || 'application/octet-stream';
}

function mergedHeaders(primary = {}, extra = null) {
  return { ...primary, ...(extra?.headers || {}) };
}

function requestCookies(extraInfo, redact) {
  return (extraInfo?.associatedCookies || [])
    .filter((associated) => !(associated.blockedReasons || []).length)
    .map(({ cookie }) => ({
      name: cookie.name,
      value: redact ? '<redacted>' : cookie.value,
      path: cookie.path || '/',
      domain: cookie.domain || '',
      expires: Number(cookie.expires) > 0 ? new Date(cookie.expires * 1000).toISOString() : undefined,
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite: cookie.sameSite || undefined,
    }));
}

function nonNegativeDuration(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return -1;
  return end - start;
}

function harTimings(entry, captureTiming) {
  if (!captureTiming) {
    return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: -1, wait: -1, receive: -1 };
  }
  const timing = entry.response?.timing || {};
  const hasProtocolTiming = Number.isFinite(timing.requestTime) && timing.receiveHeadersEnd >= 0;
  const wait = hasProtocolTiming
    ? nonNegativeDuration(timing.sendEnd, timing.receiveHeadersEnd)
    : (entry.responseTimestamp ? Math.max(0, (entry.responseTimestamp - entry.requestTimestamp) * 1000) : -1);
  const headersAt = hasProtocolTiming ? timing.requestTime + timing.receiveHeadersEnd / 1000 : entry.responseTimestamp;
  return {
    blocked: -1,
    dns: nonNegativeDuration(timing.dnsStart, timing.dnsEnd),
    connect: nonNegativeDuration(timing.connectStart, timing.connectEnd),
    ssl: nonNegativeDuration(timing.sslStart, timing.sslEnd),
    send: nonNegativeDuration(timing.sendStart, timing.sendEnd),
    wait,
    receive: entry.finishedTimestamp && headersAt
      ? Math.max(0, (entry.finishedTimestamp - headersAt) * 1000)
      : -1,
  };
}

function totalTime(timings) {
  const values = Object.values(timings).filter((value) => value >= 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : 0;
}

function truncateText(text, maxBytes) {
  if (text === undefined || text === null) return { text, truncated: false };
  const buffer = Buffer.from(String(text), 'utf-8');
  if (buffer.length <= maxBytes) return { text: String(text), truncated: false };
  return { text: buffer.subarray(0, maxBytes).toString('utf-8'), truncated: true };
}

export function parseHarCaptureOptions(args) {
  const preset = String(optionValue(args, '--preset', 'all')).toLowerCase();
  const explicitTypes = normalizeResourceTypes(optionValues(args, '--resource-type'));
  const presetTypes = explicitTypes.length && !args.includes('--preset') ? [] : resourceTypesForPreset(preset);
  const resourceTypes = [...new Set([...presetTypes, ...explicitTypes])];
  const excludedResourceTypes = normalizeResourceTypes(optionValues(args, '--exclude-resource-type'));
  const methods = optionValues(args, '--method').map((method) => method.toUpperCase());
  const excludedMethods = optionValues(args, '--exclude-method').map((method) => method.toUpperCase());
  const captureValues = optionValues(args, '--capture');
  const capture = captureValues.length ? captureValues : [...HAR_CAPTURE_COMPONENTS];
  for (const component of capture) {
    if (!HAR_CAPTURE_COMPONENTS.includes(component)) {
      throw new Error(`Unknown --capture component: ${component}. Expected: ${HAR_CAPTURE_COMPONENTS.join(', ')}`);
    }
  }
  const minSize = parseBoundedNumber(optionValue(args, '--min-size', null), '--min-size', { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
  const maxSize = parseBoundedNumber(optionValue(args, '--max-size', null), '--max-size', { fallback: Number.MAX_SAFE_INTEGER, min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
  if (maxSize < minSize) throw new Error('--max-size must be greater than or equal to --min-size');

  return {
    preset,
    resourceTypes,
    excludedResourceTypes,
    urlPatterns: patternOptionValues(args, '--url-pattern'),
    excludedUrlPatterns: patternOptionValues(args, '--exclude-url-pattern'),
    methods,
    excludedMethods,
    statuses: parseStatusSelectors(optionValues(args, '--status')),
    excludedStatuses: parseStatusSelectors(optionValues(args, '--exclude-status')),
    mimeTypes: optionValues(args, '--mime-type'),
    excludedMimeTypes: optionValues(args, '--exclude-mime-type'),
    minSize,
    maxSize,
    capture: [...new Set(capture)],
    maxBodyBytes: parsePositiveIntegerOption(args, '--max-body-bytes', DEFAULT_HAR_MAX_BODY_BYTES),
    maxDurationSeconds: parsePositiveIntegerOption(args, '--max-duration', DEFAULT_HAR_MAX_DURATION_SECONDS),
    idleMs: parsePositiveIntegerOption(args, '--idle-ms', DEFAULT_HAR_IDLE_MS),
    drainTimeoutMs: parsePositiveIntegerOption(args, '--drain-timeout-ms', DEFAULT_HAR_DRAIN_TIMEOUT_MS),
    redact: hasFlag(args, '--redact'),
  };
}

export class HarCollector {
  constructor(options, { pageId = 'page_0', pageUrl = '', pageTitle = '' } = {}) {
    this.options = options;
    this.pageId = pageId;
    this.pageUrl = pageUrl;
    this.pageTitle = pageTitle;
    this.entries = [];
    this.currentByRequestId = new Map();
    this.entriesByRequestId = new Map();
    this.requestIndexes = new Map();
    this.requestExtraIndexes = new Map();
    this.responseExtraIndexes = new Map();
    this.pendingRequestExtra = new Map();
    this.pendingResponseExtra = new Map();
    this.activeRequestIds = new Set();
    this.lastActivityAt = Date.now();
  }

  requestMatches(event) {
    const method = String(event.request.method).toUpperCase();
    const resourceType = event.type || 'Other';
    if (!this.options.resourceTypes.includes(resourceType)) return false;
    if (this.options.excludedResourceTypes.includes(resourceType)) return false;
    if (this.options.methods.length && !this.options.methods.includes(method)) return false;
    if (this.options.excludedMethods.includes(method)) return false;
    return matchesPatterns(event.request.url, this.options.urlPatterns, this.options.excludedUrlPatterns);
  }

  responseMatches(entry) {
    const status = entry.responseExtraInfo?.statusCode ?? entry.response?.status ?? 0;
    if (!matchesStatus(status, this.options.statuses, this.options.excludedStatuses)) return false;
    const mimeType = entry.response?.mimeType || '';
    if (!matchesPatterns(mimeType, this.options.mimeTypes, this.options.excludedMimeTypes)) return false;
    const size = entry.encodedDataLength ?? 0;
    return size >= this.options.minSize && size <= this.options.maxSize;
  }

  requestWillBeSent(event) {
    this.lastActivityAt = Date.now();
    const entryIndex = this.requestIndexes.get(event.requestId) || 0;
    this.requestIndexes.set(event.requestId, entryIndex + 1);
    if (event.redirectResponse) {
      const redirected = this.currentByRequestId.get(event.requestId);
      if (redirected) {
        redirected.response = event.redirectResponse;
        redirected.responseTimestamp = event.timestamp;
        redirected.finishedTimestamp = event.timestamp;
        redirected.encodedDataLength = Number(event.redirectResponse.encodedDataLength || 0);
      }
    }

    if (!this.requestMatches(event)) {
      this.currentByRequestId.delete(event.requestId);
      this.activeRequestIds.delete(event.requestId);
      return;
    }

    const requestEntries = this.entriesByRequestId.get(event.requestId) || [];
    const entry = {
      requestId: event.requestId,
      request: event.request,
      resourceType: event.type || 'Other',
      requestTimestamp: event.timestamp,
      wallTime: event.wallTime,
      initiator: event.initiator,
      response: null,
      responseTimestamp: null,
      finishedTimestamp: null,
      encodedDataLength: 0,
      responseBody: null,
      failed: null,
      servedFromCache: false,
      requestExtraInfo: this.pendingRequestExtra.get(event.requestId)?.get(entryIndex) || null,
      responseExtraInfo: this.pendingResponseExtra.get(event.requestId)?.get(entryIndex) || null,
    };
    requestEntries[entryIndex] = entry;
    this.entriesByRequestId.set(event.requestId, requestEntries);
    this.entries.push(entry);
    this.currentByRequestId.set(event.requestId, entry);
    this.activeRequestIds.add(event.requestId);
  }

  requestWillBeSentExtraInfo(event) {
    this.assignExtraInfo(event, 'request');
  }

  responseReceivedExtraInfo(event) {
    this.assignExtraInfo(event, 'response');
  }

  assignExtraInfo(event, kind) {
    this.lastActivityAt = Date.now();
    const indexes = kind === 'request' ? this.requestExtraIndexes : this.responseExtraIndexes;
    const pending = kind === 'request' ? this.pendingRequestExtra : this.pendingResponseExtra;
    const property = kind === 'request' ? 'requestExtraInfo' : 'responseExtraInfo';
    const index = indexes.get(event.requestId) || 0;
    indexes.set(event.requestId, index + 1);
    const entry = this.entriesByRequestId.get(event.requestId)?.[index];
    if (entry) {
      entry[property] = event;
      return;
    }
    if (!pending.has(event.requestId)) pending.set(event.requestId, new Map());
    pending.get(event.requestId).set(index, event);
  }

  responseReceived(event) {
    this.lastActivityAt = Date.now();
    const entry = this.currentByRequestId.get(event.requestId);
    if (!entry) return;
    entry.response = event.response;
    entry.responseTimestamp = event.timestamp;
    if (event.type) entry.resourceType = event.type;
  }

  requestServedFromCache(event) {
    const entry = this.currentByRequestId.get(event.requestId);
    if (entry) entry.servedFromCache = true;
  }

  async loadingFinished(event, session) {
    this.lastActivityAt = Date.now();
    const entry = this.currentByRequestId.get(event.requestId);
    this.activeRequestIds.delete(event.requestId);
    if (!entry) return;
    entry.finishedTimestamp = event.timestamp;
    entry.encodedDataLength = Number(event.encodedDataLength || 0);
    if (!this.options.capture.includes('bodies') || !this.responseMatches(entry)) return;
    try {
      entry.responseBody = await session.send('Network.getResponseBody', { requestId: event.requestId });
    } catch (error) {
      entry.responseBodyError = error.message;
    }
  }

  loadingFailed(event) {
    this.lastActivityAt = Date.now();
    const entry = this.currentByRequestId.get(event.requestId);
    this.activeRequestIds.delete(event.requestId);
    if (!entry) return;
    entry.finishedTimestamp = event.timestamp;
    entry.failed = {
      errorText: event.errorText,
      canceled: Boolean(event.canceled),
      blockedReason: event.blockedReason || null,
    };
  }

  async waitForDrain({ idleMs = this.options.idleMs, timeoutMs = this.options.drainTimeoutMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.activeRequestIds.size === 0 && Date.now() - this.lastActivityAt >= idleMs) return true;
      await sleep(50);
    }
    return false;
  }

  toHarEntry(entry) {
    const redact = this.options.redact;
    const includeSensitive = !redact;
    const captureHeaders = this.options.capture.includes('headers');
    const rawRequestHeaders = mergedHeaders(entry.request.headers, entry.requestExtraInfo);
    const rawResponseHeaders = mergedHeaders(entry.response?.headers, entry.responseExtraInfo);
    const requestHeaders = captureHeaders ? redactHeaders(rawRequestHeaders, { includeSensitive }) : [];
    const responseHeaders = captureHeaders ? redactHeaders(rawResponseHeaders, { includeSensitive }) : [];
    const requestMimeType = bodyMimeType(rawRequestHeaders);
    const requestBody = this.options.capture.includes('bodies') && entry.request.postData !== undefined
      ? truncateText(redactBodyText(entry.request.postData, requestMimeType, { includeSensitive }), this.options.maxBodyBytes)
      : { text: undefined, truncated: false };

    let responseText;
    let responseEncoding;
    let responseTruncated = false;
    if (entry.responseBody) {
      responseEncoding = entry.responseBody.base64Encoded ? 'base64' : undefined;
      const rawText = entry.responseBody.body;
      const redacted = responseEncoding
        ? rawText
        : redactBodyText(rawText, entry.response?.mimeType, { includeSensitive });
      const truncated = truncateText(redacted, this.options.maxBodyBytes);
      responseText = truncated.text;
      responseTruncated = truncated.truncated;
    }

    const timings = harTimings(entry, this.options.capture.includes('timing'));
    const request = {
      method: entry.request.method,
      url: redactUrl(entry.request.url, { includeSensitive }),
      httpVersion: harHttpVersion(entry.response?.protocol),
      headers: requestHeaders,
      queryString: queryString(entry.request.url, redact),
      cookies: captureHeaders ? requestCookies(entry.requestExtraInfo, redact) : [],
      headersSize: -1,
      bodySize: entry.request.postData ? Buffer.byteLength(entry.request.postData) : 0,
    };
    if (requestBody.text !== undefined) {
      request.postData = {
        mimeType: requestMimeType,
        text: requestBody.text,
        ...(requestBody.truncated ? { _truncated: true } : {}),
      };
    }

    const response = {
      status: Number(entry.responseExtraInfo?.statusCode ?? entry.response?.status ?? 0),
      statusText: entry.response?.statusText || (entry.failed?.errorText ?? ''),
      httpVersion: harHttpVersion(entry.response?.protocol),
      headers: responseHeaders,
      cookies: [],
      content: {
        size: entry.responseBody?.body ? Buffer.byteLength(entry.responseBody.body) : Number(entry.encodedDataLength || 0),
        mimeType: entry.response?.mimeType || 'application/octet-stream',
        ...(responseText !== undefined ? { text: responseText } : {}),
        ...(responseEncoding ? { encoding: responseEncoding } : {}),
        ...(responseTruncated ? { _truncated: true } : {}),
      },
      redirectURL: redactUrl(headerValue(rawResponseHeaders, 'location'), { includeSensitive }),
      headersSize: -1,
      bodySize: Number(entry.encodedDataLength || 0),
    };

    return {
      pageref: this.pageId,
      startedDateTime: new Date((entry.wallTime || Date.now() / 1000) * 1000).toISOString(),
      time: totalTime(timings),
      request,
      response,
      cache: entry.servedFromCache ? { _servedFromCache: true } : {},
      timings,
      serverIPAddress: entry.response?.remoteIPAddress || '',
      connection: entry.response?.connectionId ? String(entry.response.connectionId) : '',
      _resourceType: entry.resourceType,
      _requestId: entry.requestId,
      _initiator: redact ? redactSensitive(entry.initiator) : entry.initiator,
      ...(entry.failed ? { _failure: entry.failed } : {}),
      ...(entry.responseBodyError ? { _responseBodyError: entry.responseBodyError } : {}),
      ...(redact ? { _redacted: true } : {}),
    };
  }

  build() {
    const entries = this.entries
      .filter((entry) => entry.response || entry.failed)
      .filter((entry) => this.responseMatches(entry))
      .map((entry) => this.toHarEntry(entry));
    const startedDateTime = entries[0]?.startedDateTime || new Date().toISOString();
    return {
      log: {
        version: '1.2',
        creator: { name: '@rezkam/browser-tools', version: BROWSER_TOOLS_VERSION },
        pages: [{
          startedDateTime,
          id: this.pageId,
          title: this.pageTitle,
          pageTimings: {},
          _url: redactUrl(this.pageUrl, { includeSensitive: !this.options.redact }),
        }],
        entries,
        _capture: {
          preset: this.options.preset,
          resourceTypes: this.options.resourceTypes,
          filters: {
            urlPatterns: this.options.urlPatterns,
            excludedUrlPatterns: this.options.excludedUrlPatterns,
            methods: this.options.methods,
            statuses: this.options.statuses,
            mimeTypes: this.options.mimeTypes,
            minSize: this.options.minSize,
            maxSize: this.options.maxSize,
          },
          components: this.options.capture,
          redacted: this.options.redact,
        },
      },
    };
  }
}

export async function runHarCapture({
  session,
  page,
  options,
  shouldStop,
  onPhase = () => {},
}) {
  const collector = new HarCollector(options, {
    pageUrl: page.url(),
    pageTitle: await page.title().catch(() => ''),
  });
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };

  session.on('Network.requestWillBeSent', (event) => collector.requestWillBeSent(event));
  session.on('Network.requestWillBeSentExtraInfo', (event) => collector.requestWillBeSentExtraInfo(event));
  session.on('Network.responseReceived', (event) => collector.responseReceived(event));
  session.on('Network.responseReceivedExtraInfo', (event) => collector.responseReceivedExtraInfo(event));
  session.on('Network.requestServedFromCache', (event) => collector.requestServedFromCache(event));
  session.on('Network.loadingFinished', (event) => track(collector.loadingFinished(event, session)));
  session.on('Network.loadingFailed', (event) => collector.loadingFailed(event));

  await session.send('Network.enable', {
    maxTotalBufferSize: Math.max(options.maxBodyBytes * 4, 4 * 1024 * 1024),
    maxResourceBufferSize: options.maxBodyBytes,
    maxPostDataSize: options.maxBodyBytes,
  });
  await onPhase('recording');

  const deadline = Date.now() + options.maxDurationSeconds * 1000;
  while (!shouldStop() && Date.now() < deadline) await sleep(100);
  const reason = shouldStop() ? 'requested' : 'max-duration';
  await onPhase('draining', reason);
  await collector.waitForDrain();
  await Promise.allSettled([...pending]);
  return { reason, har: collector.build(), eventCount: collector.entries.length };
}

export function writeHar(file, har) {
  writePrivateJson(file, har);
}
