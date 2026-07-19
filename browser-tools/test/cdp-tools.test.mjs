import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesPatterns,
  matchesStatus,
  parseStatusSelectors,
  redactBodyText,
  redactSensitive,
  redactUrl,
  validateCdpMethod,
} from '../scripts/cdp-common.mjs';
import { parseCdpEventCaptureOptions, sanitizeCdpEvent } from '../scripts/cdp-event-capture.mjs';
import { sanitizeCdpCallResult } from '../scripts/cdp.mjs';
import { HarCollector, parseHarCaptureOptions } from '../scripts/har-capture.mjs';

test('HAR filters let explicit resource types narrow capture without a preset', () => {
  const xhrOnly = parseHarCaptureOptions(['--resource-type', 'xhr']);
  assert.deepEqual(xhrOnly.resourceTypes, ['XHR']);

  const apiPlusDocument = parseHarCaptureOptions([
    '--preset', 'api',
    '--resource-type', 'Document',
    '--exclude-resource-type', 'Preflight',
    '--url-pattern', '**/api/**',
    '--url-pattern', '**/graphql',
    '--method', 'get,POST',
    '--status', '200-299,304',
    '--mime-type', 'application/json*',
  ]);
  assert.deepEqual(apiPlusDocument.resourceTypes, ['XHR', 'Fetch', 'Preflight', 'EventSource', 'WebSocket', 'Document']);
  assert.deepEqual(apiPlusDocument.excludedResourceTypes, ['Preflight']);
  assert.deepEqual(apiPlusDocument.urlPatterns, ['**/api/**', '**/graphql']);
  assert.deepEqual(apiPlusDocument.methods, ['GET', 'POST']);
  assert.deepEqual(apiPlusDocument.statuses, [{ start: 200, end: 299 }, { start: 304, end: 304 }]);
  assert.deepEqual(apiPlusDocument.mimeTypes, ['application/json*']);

  assert.throws(
    () => parseHarCaptureOptions(['--min-size', '100', '--max-size', '99']),
    /--max-size must be greater/,
  );
});

test('HAR collector applies response status, MIME, and size filters before output', async () => {
  const options = parseHarCaptureOptions([
    '--resource-type', 'Fetch',
    '--status', '200-299',
    '--mime-type', 'application/json*',
    '--min-size', '10',
    '--max-size', '100',
  ]);
  const collector = new HarCollector(options);
  collector.requestWillBeSent({
    requestId: 'request-1',
    type: 'Fetch',
    timestamp: 1,
    wallTime: 1,
    initiator: { type: 'script' },
    request: { method: 'GET', url: 'https://example.test/api/data', headers: {} },
  });
  collector.responseReceived({
    requestId: 'request-1',
    type: 'Fetch',
    timestamp: 1.1,
    response: { status: 201, statusText: 'Created', mimeType: 'application/json', headers: {} },
  });
  await collector.loadingFinished(
    { requestId: 'request-1', timestamp: 1.2, encodedDataLength: 50 },
    { send: async () => ({ body: '{"ok":true}', base64Encoded: false }) },
  );
  assert.equal(collector.build().log.entries.length, 1);

  const excluded = new HarCollector(options);
  excluded.requestWillBeSent({
    requestId: 'request-2',
    type: 'Fetch',
    timestamp: 1,
    wallTime: 1,
    initiator: { type: 'script' },
    request: { method: 'GET', url: 'https://example.test/api/data', headers: {} },
  });
  excluded.responseReceived({
    requestId: 'request-2',
    type: 'Fetch',
    timestamp: 1.1,
    response: { status: 500, statusText: 'Error', mimeType: 'application/json', headers: {} },
  });
  await excluded.loadingFinished(
    { requestId: 'request-2', timestamp: 1.2, encodedDataLength: 50 },
    { send: async () => ({ body: '{"ok":false}', base64Encoded: false }) },
  );
  assert.equal(excluded.build().log.entries.length, 0);
});

test('URL, status, and sensitive-data helpers preserve structure while filtering secrets', () => {
  assert.equal(matchesPatterns('https://example.test/api/users', ['**/api/**'], []), true);
  assert.equal(matchesPatterns('https://example.test/api/users', [], ['**/api/**']), false);
  assert.equal(matchesStatus(204, parseStatusSelectors(['200-299']), []), true);
  assert.equal(matchesStatus(500, parseStatusSelectors(['200-299']), []), false);

  assert.deepEqual(redactSensitive({
    displayName: 'Ada',
    access_token: 'secret',
    nested: { password: 'hidden', safe: true },
  }), {
    displayName: 'Ada',
    access_token: '<redacted>',
    nested: { password: '<redacted>', safe: true },
  });
  assert.equal(
    redactBodyText('{"action":"checkout","refreshToken":"secret"}', 'application/json'),
    '{"action":"checkout","refreshToken":"<redacted>"}',
  );
  assert.equal(
    redactUrl('https://example.test/callback?code=public&access_token=secret'),
    'https://example.test/callback?code=public&access_token=%3Credacted%3E',
  );
});

test('raw CDP capture supports wildcard events, skipped enables, and setup calls', () => {
  const options = parseCdpEventCaptureOptions([
    '--domain', 'Target',
    '--event', 'Target.*',
    '--exclude-event', 'Target.targetInfoChanged',
    '--skip-enable', 'Target',
    '--setup', '{"method":"Target.setDiscoverTargets","params":{"discover":true}}',
  ]);
  assert.deepEqual(options.domains, ['Target']);
  assert.deepEqual(options.eventPatterns, ['Target.*']);
  assert.deepEqual(options.excludedEventPatterns, ['Target.targetInfoChanged']);
  assert.deepEqual(options.skippedDomainEnables, ['Target']);
  assert.deepEqual(options.setupCommands, [{
    method: 'Target.setDiscoverTargets',
    params: { discover: true },
  }]);

  assert.throws(
    () => parseCdpEventCaptureOptions(['--setup', 'Browser.close']),
    /blocked.*lifecycle safety/,
  );
});

test('raw CDP event redaction handles headers, request JSON, cookies, and WebSocket frames', () => {
  const request = sanitizeCdpEvent('Network.requestWillBeSent', {
    request: {
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      postData: '{"name":"Ada","password":"secret"}',
    },
  });
  assert.equal(request.request.headers.Authorization, '<redacted>');
  assert.deepEqual(JSON.parse(request.request.postData), { name: 'Ada', password: '<redacted>' });

  const cookies = sanitizeCdpEvent('Network.requestWillBeSentExtraInfo', {
    associatedCookies: [{ cookie: { name: 'session', value: 'secret' } }],
  });
  assert.equal(cookies.associatedCookies[0].cookie.value, '<redacted>');

  const frame = sanitizeCdpEvent('Network.webSocketFrameReceived', {
    response: { opcode: 1, payloadData: 'private payload' },
  });
  assert.equal(frame.response.payloadData, '<redacted>');
});

test('direct CDP body results keep structure but redact sensitive fields', () => {
  assert.deepEqual(sanitizeCdpCallResult('Network.getResponseBody', {
    body: '{"ok":true,"access_token":"secret"}',
    base64Encoded: false,
  }), {
    body: '{"ok":true,"access_token":"<redacted>"}',
    base64Encoded: false,
  });
  assert.deepEqual(sanitizeCdpCallResult('Network.getRequestPostData', {
    postData: '{"password":"secret"}',
  }), {
    postData: '{"password":"<redacted>"}',
  });
});

test('direct CDP method validation blocks managed lifecycle bypasses', () => {
  assert.equal(validateCdpMethod('Runtime.evaluate'), 'Runtime.evaluate');
  assert.throws(() => validateCdpMethod('Browser.close'), /blocked.*lifecycle safety/);
  assert.throws(() => validateCdpMethod('not-a-method'), /Expected Domain\.method/);
});
