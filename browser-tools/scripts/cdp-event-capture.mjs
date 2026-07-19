import { hasFlag, parsePositiveIntegerOption, sleep } from './browser-control.mjs';
import {
  matchesPatterns,
  optionValues,
  rawOptionValues,
  redactBodyText,
  redactSensitive,
  validateCdpMethod,
} from './cdp-common.mjs';

export const DEFAULT_CDP_POST_WAIT_MS = 500;
export const DEFAULT_CDP_MAX_DURATION_SECONDS = 300;
export const DEFAULT_CDP_MAX_EVENTS = 100000;

function validateDomain(domain) {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(domain)) throw new Error(`Invalid CDP domain: ${domain}`);
  return domain;
}

function validateEventPattern(pattern) {
  if (!/^[A-Z*][A-Za-z0-9*?]*\.[A-Za-z0-9*?]+$/.test(pattern)) {
    throw new Error(`Invalid CDP event pattern: ${pattern}. Use Domain.event or Domain.*`);
  }
  return pattern;
}

function parseSetupCommand(value) {
  let command;
  if (String(value).trim().startsWith('{')) {
    try {
      command = JSON.parse(value);
    } catch (error) {
      throw new Error(`Invalid --setup JSON: ${error.message}`);
    }
  } else {
    command = { method: value, params: {} };
  }
  const method = validateCdpMethod(command.method);
  const params = command.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`CDP setup params for ${method} must be a JSON object`);
  }
  return { method, params };
}

export function parseCdpEventCaptureOptions(args) {
  const eventPatterns = optionValues(args, '--event').map(validateEventPattern);
  const excludedEventPatterns = optionValues(args, '--exclude-event').map(validateEventPattern);
  const explicitDomains = optionValues(args, '--domain').map(validateDomain);
  const inferredDomains = eventPatterns
    .map((pattern) => pattern.split('.')[0])
    .filter((domain) => !domain.includes('*') && !domain.includes('?'))
    .map(validateDomain);
  const domains = [...new Set([...explicitDomains, ...inferredDomains])];
  if (!domains.length) domains.push('Network');
  const skippedDomainEnables = optionValues(args, '--skip-enable').map(validateDomain);
  const setupCommands = rawOptionValues(args, '--setup').map(parseSetupCommand);

  return {
    domains,
    skippedDomainEnables,
    setupCommands,
    eventPatterns: eventPatterns.length ? eventPatterns : domains.map((domain) => `${domain}.*`),
    excludedEventPatterns,
    postWaitMs: parsePositiveIntegerOption(args, '--post-wait-ms', DEFAULT_CDP_POST_WAIT_MS),
    maxDurationSeconds: parsePositiveIntegerOption(args, '--max-duration', DEFAULT_CDP_MAX_DURATION_SECONDS),
    maxEvents: parsePositiveIntegerOption(args, '--max-events', DEFAULT_CDP_MAX_EVENTS),
    includeSensitive: hasFlag(args, '--include-sensitive'),
  };
}

function headerValue(headers, wanted) {
  const match = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === wanted.toLowerCase());
  return match ? String(match[1]) : '';
}

export function sanitizeCdpEvent(method, params, { includeSensitive = false } = {}) {
  if (includeSensitive) return params;
  const sanitized = redactSensitive(params);
  if (method === 'Network.requestWillBeSent') {
    if (sanitized.request?.postData !== undefined) {
      const mimeType = headerValue(sanitized.request.headers, 'content-type');
      sanitized.request.postData = redactBodyText(sanitized.request.postData, mimeType);
    }
    if (sanitized.request?.postDataEntries !== undefined) sanitized.request.postDataEntries = '<redacted>';
  }
  if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
    if (sanitized.response?.payloadData !== undefined) sanitized.response.payloadData = '<redacted>';
  }
  if (method === 'Network.eventSourceMessageReceived' && sanitized.data !== undefined) {
    sanitized.data = '<redacted>';
  }
  return sanitized;
}

export async function runCdpEventCapture({
  session,
  options,
  shouldStop,
  writeEvent,
  onPhase = () => {},
}) {
  let eventCount = 0;
  const startedMonotonic = performance.now();
  const onAnyEvent = (method, params) => {
    if (typeof method !== 'string') return;
    if (!matchesPatterns(method, options.eventPatterns, options.excludedEventPatterns)) return;
    writeEvent({
      timestamp: new Date().toISOString(),
      elapsed_ms: Number((performance.now() - startedMonotonic).toFixed(3)),
      method,
      params: sanitizeCdpEvent(method, params, options),
    });
    eventCount += 1;
  };
  session.on('*', onAnyEvent);

  for (const domain of options.domains) {
    if (options.skippedDomainEnables.includes(domain)) continue;
    try {
      await session.send(`${domain}.enable`);
    } catch (error) {
      throw new Error(`Could not enable CDP domain ${domain}: ${error.message}. Use --skip-enable ${domain} and --setup when the domain needs a different activation method.`);
    }
  }
  for (const command of options.setupCommands) {
    await session.send(command.method, command.params);
  }
  await onPhase('recording');

  const deadline = Date.now() + options.maxDurationSeconds * 1000;
  while (!shouldStop() && Date.now() < deadline && eventCount < options.maxEvents) await sleep(100);
  const reason = shouldStop() ? 'requested' : (eventCount >= options.maxEvents ? 'max-events' : 'max-duration');
  await onPhase('post-wait', reason);
  await sleep(options.postWaitMs);
  session.off('*', onAnyEvent);
  return { reason, eventCount };
}
