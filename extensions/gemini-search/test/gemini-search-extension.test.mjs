import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import * as geminiSearchRuntime from '../runtime.mjs';

const {
  GEMINI_SEARCH_MODEL,
  queryGeminiWithAiChat,
  resolveBrowserToolsModuleUrl,
  buildGeminiSearchPrompt,
  runGeminiSearchBatch,
  stopOwnedAiChatBrowser,
} = geminiSearchRuntime;

test('Gemini search resolves Browser Tools from the AI Chat dependency location', async () => {
  const moduleUrl = resolveBrowserToolsModuleUrl();
  assert.match(moduleUrl, /@rezkam[\\/]browser-tools/);
  const browserTools = await import(moduleUrl);
  assert.equal(typeof browserTools.startChrome, 'function');
});

test('Gemini search rejects results without exact UI mode verification', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'gemini-search-model-'));
  await assert.rejects(
    () => runGeminiSearchBatch({ query: 'query', resultDir }, {
      queryGemini: async () => ({
        text: 'unverified answer',
        model: GEMINI_SEARCH_MODEL,
        temporary: true,
        modelUiVerified: false,
      }),
    }),
    /required .* mode/i,
  );
});

test('Gemini search rejects a response that contains no source URL', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'gemini-search-no-sources-'));
  await assert.rejects(
    () => runGeminiSearchBatch({ query: 'query', resultDir }, {
      queryGemini: async () => ({
        text: 'This answer has no source links.',
        model: GEMINI_SEARCH_MODEL,
        temporary: true,
        modelUiVerified: true,
      }),
    }),
    /source URLs/i,
  );
});

test('Gemini search applies timeoutSeconds to the whole query operation', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'gemini-search-timeout-'));
  const startedAt = Date.now();
  let calls = 0;
  await assert.rejects(
    () => runGeminiSearchBatch({ queries: ['first query', 'second query'], resultDir, timeoutSeconds: 0.01 }, {
      queryGemini: async () => {
        calls += 1;
        return new Promise(() => {});
      },
    }),
    /timed out/i,
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - startedAt < 250);
});

test('Gemini search reports queries skipped after a provider timeout', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'gemini-search-timeout-partial-'));
  let calls = 0;
  const result = await runGeminiSearchBatch({
    queries: ['completed query', 'timed out query', 'skipped query'],
    resultDir,
    timeoutSeconds: 0.01,
  }, {
    queryGemini: async () => {
      calls += 1;
      if (calls === 2) return new Promise(() => {});
      return {
        text: 'answer [source](https://example.test/source)',
        model: GEMINI_SEARCH_MODEL,
        temporary: true,
        modelUiVerified: true,
      };
    },
    writeResult: async () => '/result-store/result.md',
  });

  assert.equal(calls, 2);
  assert.equal(result.successfulQueries, 1);
  assert.equal(result.failedQueries, 2);
  assert.deepEqual(result.failures, [
    { query: 'timed out query', error: 'The Gemini search timed out.' },
    { query: 'skipped query', error: 'Skipped after a previous Gemini search timed out.' },
  ]);
});

test('Gemini search returns home-relative result paths to the agent', async () => {
  const privateRoot = ['.ag', 'ents'].join('');
  const absolutePath = join(homedir(), privateRoot, 'tmp', 'gemini-search', 'result.md');
  const resultDir = await mkdtemp(join(tmpdir(), 'gemini-search-public-path-'));
  const result = await runGeminiSearchBatch({ query: 'query', resultDir }, {
    queryGemini: async () => ({ text: 'answer [source](https://example.test/source)', model: GEMINI_SEARCH_MODEL, temporary: true, modelUiVerified: true }),
    writeResult: async () => absolutePath,
  });

  assert.equal(result.files[0].path, ['~', privateRoot, 'tmp', 'gemini-search', 'result.md'].join('/'));
  assert.doesNotMatch(result.files[0].path, new RegExp(homedir().replaceAll('/', '\\/')));
});

test('Gemini shutdown reads the configured AI Chat browser-state file', async () => {
  const stopped = [];
  const state = { port: 43123, ownerToken: 'test-owner-token', status: 'started' };
  const stoppedBrowser = await stopOwnedAiChatBrowser({
    browserStateFile: '/private-configured-browser-state.json',
    readBrowserState: stateFile => {
      assert.equal(stateFile, '/private-configured-browser-state.json');
      return state;
    },
    browserTools: {
      browserWSEndpoint: async port => {
        assert.equal(port, state.port);
        return 'ws://managed-browser';
      },
      stopChrome: ({ port, ownerToken, clean }) => {
        stopped.push({ port, ownerToken, clean });
        return { status: 'stopped' };
      },
    },
  });

  assert.equal(stoppedBrowser, true);
  assert.deepEqual(stopped, [{ port: state.port, ownerToken: state.ownerToken, clean: false }]);
});

test('Gemini shutdown attempts the owner-checked stop before probing DevTools', async () => {
  const events = [];
  const stoppedBrowser = await stopOwnedAiChatBrowser({
    browserStateFile: '/private-state.json',
    readBrowserState: () => ({ port: 43124, ownerToken: 'test-owner-token', status: 'started' }),
    browserTools: {
      stopChrome: () => { events.push('stop'); return { status: 'failed' }; },
      browserWSEndpoint: async () => { events.push('probe'); return null; },
    },
  });

  assert.equal(stoppedBrowser, true);
  assert.deepEqual(events, ['stop', 'probe']);
});

test('Gemini search rejects a citation copied only from the query', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'gemini-search-echoed-link-'));
  const query = 'Summarize https://EXAMPLE.test:443/input#fragment';
  await assert.rejects(
    () => runGeminiSearchBatch({ query, resultDir }, {
      queryGemini: async () => ({
        text: 'I cannot verify this, but here is the input: [source](https://example.test/input)',
        model: GEMINI_SEARCH_MODEL,
        temporary: true,
        modelUiVerified: true,
      }),
    }),
    /source URLs/i,
  );
});

test('Gemini search keeps Browser Tools startup diagnostics out of the terminal', () => {
  assert.equal(typeof geminiSearchRuntime.startChromeWithoutTerminalOutput, 'function');

  const run = spawnSync(process.execPath, [
    fileURLToPath(new URL('./fixtures/run-quiet-browser-start.mjs', import.meta.url)),
  ], { encoding: 'utf8' });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.deepEqual(JSON.parse(run.stdout), {
    status: 'started',
    port: 43125,
    ownerToken: 'fixture-owner-token',
  });
});

test('Gemini search cancels a stalled isolated browser startup without orphaning Chrome', async () => {
  const markerDir = await mkdtemp(join(tmpdir(), 'gemini-search-browser-cancel-'));
  const markerPath = join(markerDir, 'stopped');
  const startedMarkerPath = join(markerDir, 'started');
  const controller = new AbortController();
  const started = geminiSearchRuntime.startChromeWithoutTerminalOutput({ port: 43126, markerPath, startedMarkerPath }, {
    moduleUrl: new URL('./fixtures/stalled-browser-start.mjs', import.meta.url).href,
    signal: controller.signal,
    timeoutMs: 500,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await access(startedMarkerPath);
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  controller.abort();

  await assert.rejects(started, error => error?.name === 'AbortError');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await access(markerPath);
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  assert.equal(await readFile(markerPath, 'utf8'), 'stopped');
});

test('Gemini search bounds an isolated startup child after cancellation', async () => {
  const markerDir = await mkdtemp(join(tmpdir(), 'gemini-search-browser-deadline-'));
  const startedMarkerPath = join(markerDir, 'started');
  const pidMarkerPath = join(markerDir, 'pid');
  const controller = new AbortController();
  const started = geminiSearchRuntime.startChromeWithoutTerminalOutput({
    port: 43127,
    startedMarkerPath,
    pidMarkerPath,
    delayMs: 500,
  }, {
    moduleUrl: new URL('./fixtures/stalled-browser-start.mjs', import.meta.url).href,
    signal: controller.signal,
    timeoutMs: 1000,
    cleanupDeadlineMs: 50,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await access(startedMarkerPath);
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  controller.abort();
  await assert.rejects(started, error => error?.name === 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 100));

  const pid = Number(await readFile(pidMarkerPath, 'utf8'));
  assert.throws(
    () => process.kill(pid, 0),
    error => error?.code === 'ESRCH',
  );
});

test('Gemini search supplies a private logger without replacing process stderr', async () => {
  const original = process.stderr.write;
  let capturedLogger;
  const result = await queryGeminiWithAiChat('query', {
    run: async (_request, deps) => {
      capturedLogger = deps.logger;
      assert.equal(process.stderr.write, original);
      deps.logger.error('private diagnostic');
      return {
        result: { text: 'answer https://example.test/source', modelUsed: GEMINI_SEARCH_MODEL },
        metadata: { model: GEMINI_SEARCH_MODEL, provider_state: { is_temporary: true, model_ui_verified: true } },
      };
    },
  });

  assert.equal(process.stderr.write, original);
  assert.equal(typeof capturedLogger.error, 'function');
  assert.equal(result.text, 'answer https://example.test/source');
});

test('Gemini search tracks the real provider lifetime after caller cancellation', async () => {
  assert.equal(typeof geminiSearchRuntime.hasGeminiSearchProviderRunInFlight, 'function');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const running = queryGeminiWithAiChat('tracked prompt', {
    signal: controller.signal,
    run: async () => {
      await gate;
      return {
        result: { text: 'answer https://example.test/source', modelUsed: GEMINI_SEARCH_MODEL },
        metadata: { model: GEMINI_SEARCH_MODEL, provider_state: { is_temporary: true, model_ui_verified: true } },
      };
    },
  });
  await Promise.resolve();
  assert.equal(geminiSearchRuntime.hasGeminiSearchProviderRunInFlight(), true);

  controller.abort();
  await assert.rejects(running, error => error?.name === 'AbortError');
  assert.equal(geminiSearchRuntime.hasGeminiSearchProviderRunInFlight(), true);

  release();
  for (let attempt = 0; attempt < 20 && geminiSearchRuntime.hasGeminiSearchProviderRunInFlight(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(geminiSearchRuntime.hasGeminiSearchProviderRunInFlight(), false);
});

test('Gemini search serializes abandoned provider runs before starting another query', async () => {
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const starts = [];
  const run = async request => {
    starts.push(request.prompt);
    if (starts.length === 1) await gate;
    return {
      result: { text: 'answer https://example.test/source', modelUsed: GEMINI_SEARCH_MODEL },
      metadata: { model: GEMINI_SEARCH_MODEL, provider_state: { is_temporary: true, model_ui_verified: true } },
    };
  };

  const controller = new AbortController();
  const first = queryGeminiWithAiChat('first prompt', { run, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(first, error => error?.name === 'AbortError');

  let secondStarted = false;
  const second = queryGeminiWithAiChat('second prompt', {
    run,
    onStarted: () => { secondStarted = true; },
  });
  await Promise.resolve();
  assert.equal(starts.length, 1);
  assert.equal(secondStarted, false);

  releaseFirst();
  await second;
  assert.equal(starts.length, 2);
  assert.equal(secondStarted, true);
});

test('Gemini search redacts unexpected result-directory filesystem errors', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'gemini-search-directory-error-'));
  const blockingFile = join(parent, 'not-a-directory');
  await writeFile(blockingFile, 'fixture', { mode: 0o600 });
  const resultDir = join(blockingFile, 'child');

  await assert.rejects(
    () => runGeminiSearchBatch({ query: 'query', resultDir }, {
      queryGemini: async () => assert.fail('must validate private output before querying'),
    }),
    error => {
      assert.doesNotMatch(error.message, new RegExp(parent.replaceAll('/', '\\/')));
      assert.match(error.message, /could not be prepared safely/i);
      return true;
    },
  );
});

test('Gemini search refuses an existing permissive result directory before querying', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'gemini-search-permissions-'));
  await chmod(resultDir, 0o755);

  await assert.rejects(
    () => runGeminiSearchBatch({ query: 'query', resultDir }, {
      queryGemini: async () => assert.fail('must validate private output before querying'),
    }),
    /mode 0700/,
  );
});

test('Gemini search redacts private browser profile paths from failures', async () => {
  const privateAlias = 'Private Browser Alias';
  await assert.rejects(
    () => runGeminiSearchBatch({ query: 'query' }, {
      queryGemini: async () => {
        throw new Error(`Chrome profile folder not found: ${homedir()}/Library/Application Support/Google/Chrome/${privateAlias}`);
      },
    }),
    error => {
      assert.doesNotMatch(error.message, new RegExp(privateAlias));
      assert.doesNotMatch(error.message, new RegExp(homedir().replaceAll('/', '\\/')));
      assert.match(error.message, /configured Gemini browser profile/i);
      return true;
    },
  );
});

test('Gemini search stops safely between queries when cancellation is requested', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'gemini-search-cancel-'));
  const controller = new AbortController();
  const calls = [];

  const result = await runGeminiSearchBatch({
    queries: ['first query', 'second query'],
    resultDir,
    signal: controller.signal,
  }, {
    queryGemini: async () => {
      calls.push('query');
      controller.abort();
      return { text: 'completed before cancellation [source](https://example.test/source)', model: GEMINI_SEARCH_MODEL, temporary: true, modelUiVerified: true };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.successfulQueries, 1);
  assert.equal(result.files.length, 1);
});

test('Gemini search runs multiple queries and writes private result files', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'gemini-search-extension-'));
  const calls = [];
  const updates = [];
  const controller = new AbortController();

  const result = await runGeminiSearchBatch({
    queries: ['latest runtime release', 'current browser support'],
    resultDir,
    timeoutSeconds: 90,
    signal: controller.signal,
  }, {
    queryGemini: async (prompt, options) => {
      calls.push({ prompt, options });
      return { text: `answer ${calls.length} [source](https://example.test/source-${calls.length})`, model: GEMINI_SEARCH_MODEL, temporary: true, modelUiVerified: true };
    },
    onProgress: update => updates.push(update),
  });

  assert.equal(result.successfulQueries, 2);
  assert.equal(result.failedQueries, 0);
  assert.equal(result.files.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prompt, buildGeminiSearchPrompt('latest runtime release'));
  assert.deepEqual(calls.map(call => call.options.timeoutSeconds), [90, 90]);
  assert.ok(calls.every(call => call.options.signal instanceof AbortSignal));
  assert.ok(calls.every(call => call.options.signal.aborted === false));
  controller.abort();
  assert.ok(calls.every(call => call.options.signal.aborted === true));
  assert.deepEqual(updates.map(update => update.phase), [
    'searching', 'complete', 'searching', 'complete',
  ]);

  for (const [index, file] of result.files.entries()) {
    const stats = await lstat(file.path);
    assert.equal(stats.mode & 0o777, 0o600);
    const content = await readFile(file.path, 'utf8');
    assert.match(content, new RegExp(`answer ${index + 1}`));
    assert.match(content, new RegExp(file.query));
  }
});
