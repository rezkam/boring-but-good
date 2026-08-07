import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAiChatRequest,
  runAiChat,
  validateAiChatBrowserState,
} from '../scripts/ai-chat/module.mjs';
import { assertGrokPageUsable, classifyGrokPageState } from '../scripts/ai-chat/providers/grok.mjs';
import { validatePerplexitySession } from '../scripts/ai-chat/providers/perplexity.mjs';
import { stopChrome } from '../../browser-tools/scripts/browser-control.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LIVE_BROWSER_EDGE_TESTS = process.env.AI_CHAT_LIVE_BROWSER_EDGE_TESTS === '1';

function noCache() {
  return { read: () => null, write: () => null };
}

async function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertOutsideRepo(path) {
  const resolved = resolve(path);
  assert.notEqual(resolved, REPO_ROOT);
  assert.equal(resolved.startsWith(`${REPO_ROOT}/`), false, `${path} must stay outside the repo`);
}

test('browser edge harness gives each provider command its own AI Chat owned browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-edge-reuse-'));
  try {
    const stateFile = join(dir, 'browser.json');
    const connectCalls = [];
    const runCalls = [];
    const stopCalls = [];
    let startCount = 0;
    let disconnectCount = 0;
    let livePort = null;
    const browser = {
      sessionId: 'managed-session-1',
      disconnect() { disconnectCount += 1; },
    };
    const commonDeps = {
      async startChrome() {
        startCount += 1;
        livePort = 62101;
        return { status: 'started', port: 62101, ownerToken: 'reuse-token', profileName: 'Default', requestedProfileName: 'Default' };
      },
      managedBrowserSafetyForPort(port) {
        assert.equal(port, 62101);
        return { ok: true };
      },
      readManagedStateForPort(port) {
        assert.equal(port, 62101);
        return { managedBy: 'browser-tools', ownerId: 'ai-chat', profileName: 'Default' };
      },
      managedBrowserOwnershipSafety({ ownerToken }) {
        assert.equal(ownerToken, 'reuse-token');
        return { ok: true, ownerId: 'ai-chat' };
      },
      // Reflects reality: a stopped browser no longer answers on its debug port.
      browserWSEndpoint: async port => (port === livePort ? `ws://localhost:${port}` : null),
      async connectBrowser(port, options) {
        connectCalls.push({ port, ownerToken: options.ownerToken });
        return browser;
      },
      stopChrome(args) {
        stopCalls.push(args);
        livePort = null;
        return { status: 'stopped', port: args.port };
      },
      cache: noCache(),
      io: { stdout: () => {}, writeFile: () => assert.fail('no file expected') },
    };

    for (const providerName of ['grok', 'gemini']) {
      const request = buildAiChatRequest({ providerName, prompt: `hello ${providerName}`, jsonOutput: true, browserStateFile: stateFile });
      await runAiChat(request, {
        ...commonDeps,
        provider: {
          name: providerName,
          runRequiresBrowser: () => true,
          async run({ browser: runBrowser, request: runRequest }) {
            assert.equal(runBrowser.sessionId, 'managed-session-1');
            runCalls.push({ providerName, port: runRequest.port });
            return { text: `${providerName} answer`, rawText: `${providerName} answer`, done: true, modelUsed: 'default' };
          },
        },
      });
    }

    assert.equal(startCount, 2, 'each command must start its own browser once the previous one closed');
    assert.equal(disconnectCount, 2);
    assert.deepEqual(stopCalls, [
      { port: 62101, ownerToken: 'reuse-token', clean: false },
      { port: 62101, ownerToken: 'reuse-token', clean: false },
    ]);
    assert.deepEqual(connectCalls, [
      { port: 62101, ownerToken: 'reuse-token' },
      { port: 62101, ownerToken: 'reuse-token' },
    ]);
    assert.deepEqual(runCalls, [
      { providerName: 'grok', port: 62101 },
      { providerName: 'gemini', port: 62101 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('browser edge harness diagnoses unsafe saved browser states before attachment', async () => {
  const scenarios = [
    {
      name: 'missing owner token',
      state: { version: 1, ownerId: 'ai-chat', port: 62201 },
      expected: { reason: 'missing-owner-token', stale: false, ownerId: null },
    },
    {
      name: 'wrong owner token',
      state: { version: 1, ownerId: 'ai-chat', ownerToken: 'wrong-token', port: 62202 },
      tools: {
        managedBrowserSafetyForPort: () => ({ ok: true }),
        readManagedStateForPort: () => ({ managedBy: 'browser-tools', ownerId: 'other-agent' }),
        managedBrowserOwnershipSafety: ({ ownerToken }) => {
          assert.equal(ownerToken, 'wrong-token');
          return { ok: false, reason: 'owner-token-mismatch', ownerId: 'other-agent' };
        },
      },
      expected: { reason: 'owner-token-mismatch', stale: false, ownerId: 'other-agent' },
    },
    {
      name: 'unmanaged Chrome on saved debug port',
      state: { version: 1, ownerId: 'ai-chat', ownerToken: 'owned-token', port: 62203 },
      tools: {
        managedBrowserSafetyForPort: () => ({ ok: false, reason: 'missing-managed-state' }),
        browserWSEndpoint: async () => 'ws://localhost:62203',
      },
      expected: { reason: 'missing-managed-state', stale: false, ownerId: null },
    },
    {
      name: 'stale managed state',
      state: { version: 1, ownerId: 'ai-chat', ownerToken: 'stale-token', port: 62204 },
      tools: {
        managedBrowserSafetyForPort: () => ({ ok: false, reason: 'process-not-found' }),
        browserWSEndpoint: async () => null,
      },
      expected: { reason: 'process-not-found', stale: true, ownerId: null },
    },
    {
      name: 'unavailable debug port',
      state: { version: 1, ownerId: 'ai-chat', ownerToken: 'owned-token', port: 62205 },
      tools: {
        managedBrowserSafetyForPort: () => ({ ok: true }),
        readManagedStateForPort: () => ({ managedBy: 'browser-tools', ownerId: 'ai-chat' }),
        managedBrowserOwnershipSafety: () => ({ ok: true, ownerId: 'ai-chat' }),
        browserWSEndpoint: async () => null,
      },
      expected: { reason: 'debug-port-unavailable', stale: false, ownerId: 'ai-chat' },
    },
  ];

  for (const scenario of scenarios) {
    const browserTools = {
      managedBrowserSafetyForPort: () => assert.fail(`${scenario.name} should not ask for managed safety`),
      readManagedStateForPort: () => assert.fail(`${scenario.name} should not read managed state`),
      managedBrowserOwnershipSafety: () => assert.fail(`${scenario.name} should not check ownership`),
      browserWSEndpoint: async () => assert.fail(`${scenario.name} should not check CDP`),
      ...(scenario.tools || {}),
    };
    const result = await validateAiChatBrowserState(scenario.state, {
      browserTools,
      stateFile: '/tmp/ai-chat-browser-edge-state.json',
    });

    assert.equal(result.ok, false, scenario.name);
    assert.equal(result.reason, scenario.expected.reason, scenario.name);
    assert.equal(result.stale, scenario.expected.stale, scenario.name);
    assert.equal(result.ownerId || null, scenario.expected.ownerId, scenario.name);
  }
});

test('profile auth diagnostics report logged-out or sync-required profiles without browser ownership changes', async () => {
  const grokSnapshot = {
    url: 'https://x.com/i/flow/login?redirect_after_login=%2Fi%2Fgrok',
    title: 'Sign in',
    bodyText: '',
    hasComposer: false,
    composerDisabled: false,
    loginTextVisible: true,
  };
  const grokState = classifyGrokPageState(grokSnapshot);
  assert.equal(grokState.status, 'auth_required');
  assert.equal(grokState.usable, false);

  await assert.rejects(
    () => assertGrokPageUsable({
      page: {
        url: () => grokSnapshot.url,
        evaluate: async () => grokSnapshot,
      },
      retries: 1,
      delayMs: 0,
    }),
    (error) => {
      assert.match(error.message, /not authenticated/i);
      assert.match(error.message, /--sync/);
      assert.match(error.message, /Current page: https:\/\/x\.com\/i\/flow\/login/);
      return true;
    },
  );

  let networkRequestCount = 0;
  await assert.rejects(
    () => validatePerplexitySession({
      fetchImpl: async () => {
        networkRequestCount += 1;
        return { ok: true, json: async () => ({ user: null }) };
      },
    }),
    (error) => {
      assert.match(error.message, /did not return a logged-in user/i);
      assert.match(error.message, /--sync/);
      return true;
    },
  );
  assert.equal(networkRequestCount, 1);
});

test('evidence capture records browser screenshots only when the provider returns a final URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-edge-evidence-'));
  try {
    const finalUrl = 'https://provider.example.test/conversation/abc123';
    const evidencePath = join(dir, 'with-final-url.png');
    const stdoutWithUrl = [];
    const screenshots = [];
    const finalPage = {
      url: () => finalUrl,
      screenshot: async (options) => {
        screenshots.push(options);
        writeFileSync(options.path, 'fake png', 'utf-8');
      },
    };

    const withUrl = await runAiChat(buildAiChatRequest({
      providerName: 'browser-with-url',
      prompt: 'capture evidence',
      jsonOutput: true,
      captureEvidence: true,
      evidencePath,
    }), {
      browser: { pages: async () => [finalPage] },
      provider: {
        name: 'browser-with-url',
        runRequiresBrowser: () => true,
        async run() {
          return { text: 'answer', rawText: 'answer', done: true, modelUsed: 'default', finalUrl };
        },
      },
      cache: noCache(),
      io: { stdout: text => stdoutWithUrl.push(text), writeFile: () => assert.fail('no file expected') },
    });

    assert.equal(screenshots.length, 1);
    assert.equal(screenshots[0].path, evidencePath);
    assert.equal(existsSync(evidencePath), true);
    assert.equal(withUrl.metadata.evidence_path, evidencePath);
    assert.equal(withUrl.metadata.evidence_url, finalUrl);
    assert.equal(JSON.parse(stdoutWithUrl[0]).evidence_url, finalUrl);

    const missingUrlEvidencePath = join(dir, 'without-final-url.png');
    const stdoutWithoutUrl = [];
    const withoutUrl = await runAiChat(buildAiChatRequest({
      providerName: 'browser-without-url',
      prompt: 'capture evidence',
      jsonOutput: true,
      captureEvidence: true,
      evidencePath: missingUrlEvidencePath,
    }), {
      browser: { pages: async () => assert.fail('missing final URL should not inspect browser pages') },
      provider: {
        name: 'browser-without-url',
        runRequiresBrowser: () => true,
        async run() {
          return { text: 'answer', rawText: 'answer', done: true, modelUsed: 'default', finalUrl: null };
        },
      },
      cache: noCache(),
      io: { stdout: text => stdoutWithoutUrl.push(text), writeFile: () => assert.fail('no file expected') },
    });

    assert.equal(existsSync(missingUrlEvidencePath), false);
    assert.equal(withoutUrl.metadata.evidence_path, null);
    assert.equal(withoutUrl.metadata.evidence_skipped_reason, 'missing-final-url');
    assert.equal(JSON.parse(stdoutWithoutUrl[0]).evidence_skipped_reason, 'missing-final-url');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live browser edge harness uses private artifacts and cleans only the browser it owns', { skip: LIVE_BROWSER_EDGE_TESTS ? false : 'set AI_CHAT_LIVE_BROWSER_EDGE_TESTS=1' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-edge-live-'));
  const cacheDir = join(dir, 'cache');
  const artifactDir = join(dir, 'artifacts');
  const stateFile = join(dir, 'ai-chat-browser.json');
  const firstEvidencePath = join(artifactDir, 'provider-one.png');
  const secondEvidencePath = join(artifactDir, 'provider-two.png');
  const runCalls = [];

  assertOutsideRepo(dir);
  assertOutsideRepo(cacheDir);
  assertOutsideRepo(artifactDir);
  assertOutsideRepo(stateFile);

  function liveProvider(name, { finalUrl = true } = {}) {
    return {
      name,
      runRequiresBrowser: () => true,
      async run({ browser, request }) {
        const page = await browser.newPage({ background: true });
        const html = `<html><head><title>${name}</title></head><body><main>${name}</main></body></html>`;
        await page.goto(`data:text/html,${encodeURIComponent(html)}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const pageUrl = page.url();
        runCalls.push({ provider: name, port: request.port, pageUrl });
        return {
          text: `${name} answer`,
          rawText: `${name} answer`,
          done: true,
          modelUsed: 'default',
          finalUrl: finalUrl ? pageUrl : null,
        };
      },
    };
  }

  await withEnv({
    BROWSER_TOOLS_CACHE_DIR: cacheDir,
    BROWSER_TOOLS_ARTIFACT_DIR: artifactDir,
    BROWSER_QUERY_CACHE_DIR: null,
  }, async () => {
    try {
      const firstStdout = [];
      const first = await runAiChat(buildAiChatRequest({
        providerName: 'live-provider-one',
        prompt: 'live browser one',
        jsonOutput: true,
        browserStateFile: stateFile,
        captureEvidence: true,
        evidencePath: firstEvidencePath,
        timeoutSeconds: 15,
      }), {
        provider: liveProvider('live-provider-one'),
        cache: noCache(),
        io: { stdout: text => firstStdout.push(text), writeFile: () => assert.fail('no file expected') },
      });
      const stateAfterFirst = JSON.parse(readFileSync(stateFile, 'utf-8'));

      const secondStdout = [];
      const second = await runAiChat(buildAiChatRequest({
        providerName: 'live-provider-two',
        prompt: 'live browser two',
        jsonOutput: true,
        browserStateFile: stateFile,
        captureEvidence: true,
        evidencePath: secondEvidencePath,
        timeoutSeconds: 15,
      }), {
        provider: liveProvider('live-provider-two', { finalUrl: false }),
        cache: noCache(),
        io: { stdout: text => secondStdout.push(text), writeFile: () => assert.fail('no file expected') },
      });
      const stateAfterSecond = JSON.parse(readFileSync(stateFile, 'utf-8'));

      assert.equal(stateAfterSecond.port, stateAfterFirst.port);
      assert.equal(stateAfterSecond.ownerToken, stateAfterFirst.ownerToken);
      assert.deepEqual(runCalls.map(call => call.provider), ['live-provider-one', 'live-provider-two']);
      assert.deepEqual([...new Set(runCalls.map(call => call.port))], [stateAfterFirst.port]);
      assert.equal(existsSync(firstEvidencePath), true);
      assert.equal(existsSync(secondEvidencePath), false);
      assert.equal(first.metadata.evidence_path, firstEvidencePath);
      assert.equal(JSON.parse(firstStdout[0]).evidence_path, firstEvidencePath);
      assert.equal(second.metadata.evidence_skipped_reason, 'missing-final-url');
      assert.equal(JSON.parse(secondStdout[0]).evidence_skipped_reason, 'missing-final-url');

      const wrongOwnerResult = stopChrome({ port: stateAfterSecond.port, ownerToken: 'not-the-ai-chat-live-test-token', clean: true, dryRun: true });
      assert.equal(wrongOwnerResult.status, 'not-owned');
    } finally {
      if (existsSync(stateFile)) {
        const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
        if (state?.port && state?.ownerToken) stopChrome({ port: state.port, ownerToken: state.ownerToken, clean: true });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
