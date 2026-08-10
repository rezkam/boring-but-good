import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GEMINI_SEARCH_MODEL,
  queryGeminiWithAiChat,
  buildGeminiSearchPrompt,
  runGeminiSearchBatch,
  stopOwnedAiChatBrowser,
} from '../extensions/gemini-search/runtime.mjs';

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
  await assert.rejects(
    () => runGeminiSearchBatch({ query: 'query', resultDir, timeoutSeconds: 0.01 }, {
      queryGemini: async () => new Promise(() => {}),
    }),
    /timed out/i,
  );
  assert.ok(Date.now() - startedAt < 250);
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

  const result = await runGeminiSearchBatch({
    queries: ['latest runtime release', 'current browser support'],
    resultDir,
    timeoutSeconds: 90,
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
  assert.deepEqual(calls.map(call => call.options), [
    { timeoutSeconds: 90 },
    { timeoutSeconds: 90 },
  ]);
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
