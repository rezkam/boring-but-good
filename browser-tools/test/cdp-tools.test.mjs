import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  matchesPatterns,
  matchesStatus,
  openPrivateFile,
  parseStatusSelectors,
  redactBodyText,
  redactSensitive,
  redactUrl,
  validateCdpMethod,
} from '../scripts/cdp-common.mjs';
import {
  parseCdpEventCaptureOptions,
  runCdpEventCapture,
  sanitizeCdpEvent,
} from '../scripts/cdp-event-capture.mjs';
import { sanitizeCdpCallResult } from '../scripts/cdp.mjs';
import { extractHarRecipe } from '../scripts/extract-har.mjs';
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

test('network evidence stays raw by default and redaction is explicit', () => {
  assert.equal(parseHarCaptureOptions([]).redact, false);
  assert.equal(parseHarCaptureOptions(['--redact']).redact, true);
  assert.equal(parseCdpEventCaptureOptions([]).redact, false);
  assert.equal(parseCdpEventCaptureOptions(['--redact']).redact, true);

  const event = {
    request: {
      headers: { Authorization: 'Bearer raw-secret' },
      postData: 'password=raw-password',
    },
  };
  assert.equal(sanitizeCdpEvent('Network.requestWillBeSent', event), event);
  assert.equal(
    sanitizeCdpEvent('Network.requestWillBeSent', event, { redact: true }).request.headers.Authorization,
    '<redacted>',
  );

  const result = { body: 'access_token=raw-token&safe=yes', base64Encoded: false };
  assert.equal(sanitizeCdpCallResult('Network.getResponseBody', result), result);
  assert.equal(
    sanitizeCdpCallResult('Network.getResponseBody', result, { redact: true }).body,
    'access_token=%3Credacted%3E&safe=yes',
  );
});

test('explicit recipe redaction covers raw query values and body text', () => {
  const har = {
    log: {
      entries: [{
        _resourceType: 'Fetch',
        startedDateTime: '2026-07-19T00:00:00.000Z',
        time: 1,
        timings: {},
        request: {
          method: 'POST',
          url: 'https://example.test/api?access_token=query-secret',
          headers: [{ name: 'Authorization', value: 'Bearer header-secret' }],
          queryString: [{ name: 'access_token', value: 'query-secret' }],
          postData: { mimeType: '', text: 'password=form-secret&safe=yes' },
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: [],
          content: {
            mimeType: 'application/json',
            text: '{"access_token":"response-secret","ok":true}',
          },
        },
      }],
    },
  };
  const options = {
    preset: 'api',
    resourceTypes: ['Fetch'],
    excludedResourceTypes: [],
    urlPatterns: [],
    excludedUrlPatterns: [],
    methods: [],
    excludedMethods: [],
    statuses: [],
    excludedStatuses: [],
    mimeTypes: [],
    excludedMimeTypes: [],
    redact: false,
  };

  const raw = extractHarRecipe(har, '/captures/raw.har', options);
  assert.equal(raw.requests[0].query[0].value, 'query-secret');
  assert.equal(raw.requests[0].body.text, 'password=form-secret&safe=yes');
  assert.equal(raw.requests[0].response.body.json.access_token, 'response-secret');

  const redacted = extractHarRecipe(har, '/captures/raw.har', { ...options, redact: true });
  assert.equal(redacted.requests[0].headers.authorization, '<redacted>');
  assert.equal(redacted.requests[0].query[0].value, '<redacted>');
  assert.equal(redacted.requests[0].body.text, 'password=%3Credacted%3E&safe=yes');
  assert.equal(redacted.requests[0].response.body.json.access_token, '<redacted>');
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
    redactBodyText('{"action":"checkout","access_token":"truncated-secret"', 'application/json'),
    '<redacted: malformed JSON>',
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

test('explicit raw CDP event redaction handles headers, request JSON, cookies, and WebSocket frames', () => {
  const request = sanitizeCdpEvent('Network.requestWillBeSent', {
    request: {
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      postData: '{"name":"Ada","password":"secret"}',
    },
  }, { redact: true });
  assert.equal(request.request.headers.Authorization, '<redacted>');
  assert.deepEqual(JSON.parse(request.request.postData), { name: 'Ada', password: '<redacted>' });

  const cookies = sanitizeCdpEvent('Network.requestWillBeSentExtraInfo', {
    associatedCookies: [{ cookie: { name: 'session', value: 'secret' } }],
  }, { redact: true });
  assert.equal(cookies.associatedCookies[0].cookie.value, '<redacted>');

  const frame = sanitizeCdpEvent('Network.webSocketFrameReceived', {
    response: { opcode: 1, payloadData: 'private payload' },
  }, { redact: true });
  assert.equal(frame.response.payloadData, '<redacted>');
});

test('explicit direct CDP result redaction keeps structure and filters sensitive fields', () => {
  assert.deepEqual(sanitizeCdpCallResult('Network.getResponseBody', {
    body: '{"ok":true,"access_token":"secret"}',
    base64Encoded: false,
  }, { redact: true }), {
    body: '{"ok":true,"access_token":"<redacted>"}',
    base64Encoded: false,
  });
  assert.deepEqual(sanitizeCdpCallResult('Network.getRequestPostData', {
    postData: '{"password":"secret"}',
  }, { redact: true }), {
    postData: '{"password":"<redacted>"}',
  });
});

test('raw CDP event limit is a hard bound during event bursts', async () => {
  let wildcardHandler;
  const events = [];
  const session = {
    on(type, handler) {
      assert.equal(type, '*');
      wildcardHandler = handler;
    },
    off(type, handler) {
      assert.equal(type, '*');
      assert.equal(handler, wildcardHandler);
    },
    async send() {},
  };
  const options = {
    domains: ['Network'],
    skippedDomainEnables: [],
    setupCommands: [],
    eventPatterns: ['Network.*'],
    excludedEventPatterns: [],
    postWaitMs: 1,
    maxDurationSeconds: 1,
    maxEvents: 2,
    redact: false,
  };

  const result = await runCdpEventCapture({
    session,
    options,
    shouldStop: () => false,
    writeEvent: (event) => events.push(event),
    onPhase: (phase) => {
      if (phase !== 'recording') return;
      for (let index = 0; index < 5; index += 1) {
        wildcardHandler('Network.requestWillBeSent', { requestId: String(index) });
      }
    },
  });

  assert.equal(result.reason, 'max-events');
  assert.equal(result.eventCount, 2);
  assert.equal(events.length, 2);
});

test('private output open fixes permissions when overwriting an existing file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-tools-private-output-'));
  const output = join(directory, 'network_events.jsonl');
  try {
    writeFileSync(output, 'old capture');
    chmodSync(output, 0o644);
    const fd = openPrivateFile(output, 'w');
    closeSync(fd);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('direct CDP method validation blocks managed lifecycle bypasses', () => {
  assert.equal(validateCdpMethod('Runtime.evaluate'), 'Runtime.evaluate');
  assert.throws(() => validateCdpMethod('Browser.close'), /blocked.*lifecycle safety/);
  assert.throws(() => validateCdpMethod('Page.close'), /blocked.*lifecycle safety/);
  assert.throws(() => validateCdpMethod('not-a-method'), /Expected Domain\.method/);
});
