import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeminiSearchExtension } from '../extensions/gemini-search/index.ts';

const theme = {
  fg: (_name, text) => text,
  bold: text => text,
};

// The reference extension leaves the footer and widget area to the user, so any call here is a defect.
function strictUi() {
  return {
    theme,
    setStatus() { assert.fail('gemini_search must not write to the shared footer status'); },
    setWidget() { assert.fail('gemini_search must not take over the widget area'); },
    setFooter() { assert.fail('gemini_search must not replace the footer'); },
  };
}

test('pi extension promptly cancels a queued search before it acquires the browser', async () => {
  let tool;
  let releaseFirst;
  let calls = 0;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const batchResult = {
    queryCount: 1,
    successfulQueries: 1,
    failedQueries: 0,
    cancelled: false,
    files: [{ query: 'first', path: '/result-store/result.md' }],
    failures: [],
  };
  const runBatch = async () => {
    calls += 1;
    if (calls === 1) await firstGate;
    return batchResult;
  };
  createGeminiSearchExtension({ runBatch })({ registerTool(definition) { tool = definition; }, on() {} });
  const ctx = { ui: { setStatus() {} } };

  const first = tool.execute('call-1', { query: 'first' }, undefined, undefined, ctx);
  await Promise.resolve();
  const controller = new AbortController();
  const second = tool.execute('call-2', { query: 'second' }, controller.signal, undefined, ctx);
  controller.abort();

  let outcome;
  try {
    outcome = await Promise.race([
      second.then(() => 'resolved', error => error.name),
      new Promise(resolve => setTimeout(() => resolve('still-waiting'), 50)),
    ]);
  } finally {
    releaseFirst();
    await first;
  }

  assert.equal(outcome, 'AbortError');
  assert.equal(calls, 1);
});

test('pi extension immediately rejects an already-aborted search without joining the browser queue', async () => {
  let tool;
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let calls = 0;
  const runBatch = async () => {
    calls += 1;
    if (calls === 1) await firstGate;
    return { queryCount: 1, successfulQueries: 1, failedQueries: 0, cancelled: false, files: [], failures: [] };
  };
  createGeminiSearchExtension({ runBatch })({ registerTool(definition) { tool = definition; }, on() {} });

  const first = tool.execute('call-1', { query: 'first' }, undefined, undefined, { hasUI: true, ui: strictUi() });
  await Promise.resolve();
  const controller = new AbortController();
  controller.abort();

  const second = tool.execute('call-2', { query: 'cancelled' }, controller.signal, undefined, { hasUI: true, ui: strictUi() });
  const outcome = await Promise.race([
    second.then(() => 'resolved', error => error.name),
    new Promise(resolve => setTimeout(() => resolve('still-waiting'), 50)),
  ]);
  assert.equal(outcome, 'AbortError');
  assert.equal(calls, 1);

  releaseFirst();
  await first;
});

test('pi extension abandons an in-flight search on abort without leaving the browser unserialized', async () => {
  let tool;
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const started = [];
  const runBatch = async params => {
    started.push(params.query);
    if (started.length === 1) await firstGate;
    return {
      queryCount: 1,
      successfulQueries: 1,
      failedQueries: 0,
      cancelled: false,
      files: [{ query: params.query, path: '/result-store/result.md' }],
      failures: [],
    };
  };
  createGeminiSearchExtension({ runBatch })({ registerTool(definition) { tool = definition; }, on() {} });
  const ctx = { hasUI: true, ui: strictUi() };

  const controller = new AbortController();
  const first = tool.execute('call-1', { query: 'first' }, controller.signal, undefined, ctx);
  await Promise.resolve();
  controller.abort();

  const outcome = await Promise.race([
    first.then(() => 'resolved', error => error.name),
    new Promise(resolve => setTimeout(() => resolve('still-waiting'), 50)),
  ]);
  assert.equal(outcome, 'AbortError');

  const second = tool.execute('call-2', { query: 'second' }, undefined, undefined, ctx);
  const queued = await Promise.race([
    second.then(() => 'started-early'),
    new Promise(resolve => setTimeout(() => resolve('waiting-for-browser'), 50)),
  ]);
  assert.equal(queued, 'waiting-for-browser');
  assert.deepEqual(started, ['first']);

  releaseFirst();
  await second;
  assert.deepEqual(started, ['first', 'second']);
});

test('pi extension stops a browser left running when the session shuts down mid-search', async () => {
  let tool;
  const handlers = new Map();
  let releaseSearch;
  const searchGate = new Promise(resolve => { releaseSearch = resolve; });
  const runBatch = async () => {
    await searchGate;
    return { queryCount: 1, successfulQueries: 1, failedQueries: 0, cancelled: false, files: [], failures: [] };
  };
  const stopped = [];
  createGeminiSearchExtension({
    runBatch,
    stopOwnedBrowser: async () => { stopped.push('stopped'); },
  })({
    registerTool(definition) { tool = definition; },
    on(event, handler) { handlers.set(event, handler); },
  });

  const search = tool.execute('call-1', { query: 'in flight' }, undefined, undefined, { hasUI: true, ui: strictUi() });
  await Promise.resolve();
  await handlers.get('session_shutdown')({ reason: 'quit' }, { hasUI: true, ui: strictUi() });
  assert.deepEqual(stopped, ['stopped']);

  releaseSearch();
  await search;
});

test('pi extension leaves the browser alone when no search is running at shutdown', async () => {
  let tool;
  const handlers = new Map();
  const stopped = [];
  createGeminiSearchExtension({
    runBatch: async () => ({ queryCount: 1, successfulQueries: 1, failedQueries: 0, cancelled: false, files: [], failures: [] }),
    stopOwnedBrowser: async () => { stopped.push('stopped'); },
  })({
    registerTool(definition) { tool = definition; },
    on(event, handler) { handlers.set(event, handler); },
  });

  await tool.execute('call-1', { query: 'finished' }, undefined, undefined, { hasUI: true, ui: strictUi() });
  await handlers.get('session_shutdown')({ reason: 'quit' }, { hasUI: true, ui: strictUi() });
  assert.deepEqual(stopped, []);
});

test('pi extension reports progress in its own tool row without touching shared chrome', async () => {
  let tool;
  const updates = [];
  const runBatch = async (_params, deps) => {
    deps.onProgress({ phase: 'searching', index: 0, total: 1, query: 'only query' });
    return {
      queryCount: 1,
      successfulQueries: 1,
      failedQueries: 0,
      cancelled: false,
      files: [{ query: 'only query', path: '/result-store/result.md' }],
      failures: [],
    };
  };
  createGeminiSearchExtension({ runBatch })({ registerTool(definition) { tool = definition; }, on() {} });

  const result = await tool.execute('call-1', { query: 'only query' }, undefined, update => updates.push(update), {
    hasUI: true,
    ui: strictUi(),
  });
  assert.match(result.content[0].text, /1\/1/);
  assert.equal(updates.length, 1);
  assert.match(updates[0].content[0].text, /searching: only query/);
});

test('pi extension registers a file-backed multi-query Gemini search tool', async () => {
  let tool;
  const updates = [];
  const pi = {
    registerTool(definition) { tool = definition; },
    on() {},
  };
  const runBatch = async (_params, deps) => {
    deps.onProgress({ phase: 'searching', index: 0, total: 2, query: 'first query' });
    deps.onProgress({ phase: 'complete', index: 0, total: 2, query: 'first query', path: '/result-store/result-1.md' });
    deps.onProgress({ phase: 'searching', index: 1, total: 2, query: 'second query' });
    return {
      queryCount: 2,
      successfulQueries: 2,
      failedQueries: 0,
      files: [
        { query: 'first query', path: '/result-store/result-1.md' },
        { query: 'second query', path: '/result-store/result-2.md' },
      ],
      failures: [],
    };
  };

  createGeminiSearchExtension({ runBatch })(pi);

  assert.equal(tool.name, 'gemini_search');
  assert.equal(tool.executionMode, 'sequential');
  assert.match(tool.description, /temporary/i);
  assert.match(tool.description, /result file/i);

  const result = await tool.execute('call-1', {
    queries: ['first query', 'second query'],
  }, undefined, update => updates.push(update), {
    hasUI: true,
    ui: strictUi(),
  });

  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Completed 2/2 Gemini searches in temporary chats.\nRead the full results from:\n1. /result-store/result-1.md\n2. /result-store/result-2.md',
  }]);
  assert.equal(updates.length, 3);

  const partial = tool.renderResult(updates[0], { expanded: false, isPartial: true }, theme);
  assert.match(partial.render(80).join('\n'), /first query/);

  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme);
  assert.match(collapsed.render(80).join('\n'), /2\/2 results ready/);

  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme);
  assert.match(expanded.render(100).join('\n'), /\/result-store\/result-2\.md/);
});
