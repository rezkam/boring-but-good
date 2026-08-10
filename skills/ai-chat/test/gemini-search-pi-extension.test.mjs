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

test('pi extension ignores late progress after a cancelled tool call settles', async () => {
  let tool;
  let reportProgress;
  const updates = [];
  const runBatch = async (_params, deps) => {
    reportProgress = deps.onProgress;
    reportProgress({ phase: 'complete', index: 0, total: 2, query: 'completed query', path: '/result-store/result.md' });
    return new Promise(() => {});
  };
  createGeminiSearchExtension({ runBatch })({ registerTool(definition) { tool = definition; }, on() {} });
  const controller = new AbortController();
  const search = tool.execute('call-1', {
    queries: ['completed query', 'late query'],
  }, controller.signal, update => updates.push(update), { hasUI: true, ui: strictUi() });
  await Promise.resolve();
  controller.abort();
  await search;
  const settledUpdateCount = updates.length;

  reportProgress({ phase: 'failed', index: 1, total: 2, query: 'late query', error: 'late failure' });
  assert.equal(updates.length, settledUpdateCount);
});

test('pi extension cancellation keeps completed and failed query counts', async () => {
  let tool;
  const runBatch = async (_params, deps) => {
    deps.onProgress({ phase: 'failed', index: 0, total: 2, query: 'failed query', error: 'failed safely' });
    deps.onProgress({ phase: 'complete', index: 1, total: 2, query: 'completed query', path: '/result-store/result.md' });
    return new Promise(() => {});
  };
  createGeminiSearchExtension({ runBatch })({ registerTool(definition) { tool = definition; }, on() {} });
  const controller = new AbortController();
  const search = tool.execute('call-1', {
    queries: ['failed query', 'completed query'],
  }, controller.signal, undefined, { hasUI: true, ui: strictUi() });
  await Promise.resolve();
  controller.abort();

  const result = await search;
  assert.equal(result.details.queryCount, 2);
  assert.equal(result.details.successfulQueries, 1);
  assert.equal(result.details.failedQueries, 1);
  assert.deepEqual(result.details.failures, [{ query: 'failed query', error: 'failed safely' }]);
  assert.equal(result.details.cancelled, true);

  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {});
  assert.match(expanded.render(100).join('\n'), /failed query: failed safely/);
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

test('pi extension stops a provider run that outlives the settled tool call', async () => {
  const handlers = new Map();
  const stopped = [];
  createGeminiSearchExtension({
    hasProviderRunInFlight: () => true,
    stopOwnedBrowser: async () => { stopped.push('stopped'); },
  })({
    registerTool() {},
    on(event, handler) { handlers.set(event, handler); },
  });

  await handlers.get('session_shutdown')({ reason: 'quit' }, { hasUI: true, ui: strictUi() });
  assert.deepEqual(stopped, ['stopped']);
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

test('pi extension never forwards a model-controlled result directory', async () => {
  let tool;
  let received;
  createGeminiSearchExtension({
    runBatch: async params => {
      received = params;
      return { queryCount: 1, successfulQueries: 1, failedQueries: 0, cancelled: false, files: [], failures: [] };
    },
  })({ registerTool(definition) { tool = definition; }, on() {} });

  await tool.execute('call-1', {
    query: 'query',
    timeoutSeconds: 30,
    resultDir: '/model-controlled-output',
  }, undefined, undefined, { hasUI: true, ui: strictUi() });

  assert.deepEqual(received, { query: 'query', queries: undefined, timeoutSeconds: 30, signal: undefined });
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

test('pi extension renders terminal failures as one themed tool-row line', () => {
  let tool;
  createGeminiSearchExtension()({ registerTool(definition) { tool = definition; }, on() {} });

  const rendered = tool.renderResult({
    content: [{ type: 'text', text: 'Gemini search failed.' }],
    details: undefined,
  }, { expanded: false, isPartial: false }, theme, { isError: true });

  assert.deepEqual(rendered.render(80).map(line => line.trimEnd()), ['✗ Gemini search failed.']);
});

test('pi extension previews every query and expands to each full prompt', () => {
  let tool;
  createGeminiSearchExtension()({ registerTool(definition) { tool = definition; }, on() {} });
  const args = { queries: [
    'first research angle with enough detail to require truncation FIRST_FULL_END',
    'second research angle with enough detail to require truncation SECOND_FULL_END',
    'third research angle with enough detail to require truncation THIRD_FULL_END',
  ] };

  const collapsed = tool.renderCall(args, theme, { expanded: false });
  const collapsedText = collapsed.render(100).join('\n');
  assert.match(collapsedText, /3 queries/);
  assert.match(collapsedText, /first research angle/);
  assert.match(collapsedText, /second research angle/);
  assert.match(collapsedText, /third research angle/);
  assert.doesNotMatch(collapsedText, /FIRST_FULL_END|SECOND_FULL_END|THIRD_FULL_END/);

  const expanded = tool.renderCall(args, theme, { expanded: true, lastComponent: collapsed });
  const expandedText = expanded.render(100).join('\n');
  assert.equal(expanded, collapsed);
  assert.match(expandedText, /FIRST_FULL_END/);
  assert.match(expandedText, /SECOND_FULL_END/);
  assert.match(expandedText, /THIRD_FULL_END/);

  const deduplicated = tool.renderCall({
    queries: ['first research angle', 'first research angle', 'second research angle'],
  }, theme, { expanded: false });
  assert.match(deduplicated.render(80)[0], /2 queries/);
});

test('pi extension expands a single full prompt', () => {
  let tool;
  createGeminiSearchExtension()({ registerTool(definition) { tool = definition; }, on() {} });
  const query = 'single research prompt with enough detail to hide its distinctive SINGLE_FULL_END';

  const collapsed = tool.renderCall({ query }, theme, { expanded: false });
  assert.doesNotMatch(collapsed.render(100).join('\n'), /SINGLE_FULL_END/);

  const expanded = tool.renderCall({ query }, theme, { expanded: true, lastComponent: collapsed });
  assert.equal(expanded, collapsed);
  assert.match(expanded.render(100).join('\n'), /SINGLE_FULL_END/);
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
  assert.equal(updates[0].details.successfulQueries, 0);
  assert.equal(updates[1].details.successfulQueries, 1);
  assert.equal(updates[2].details.successfulQueries, 1);

  const partial = tool.renderResult(updates[0], { expanded: false, isPartial: true }, theme, {});
  assert.equal(partial.render(80).length, 1);
  assert.match(partial.render(80).join('\n'), /0\/2.*searching.*first query/i);

  const updatedPartial = tool.renderResult(updates[2], { expanded: false, isPartial: true }, theme, {
    lastComponent: partial,
  });
  assert.equal(updatedPartial, partial);
  assert.equal(updatedPartial.render(80).length, 1);
  assert.match(updatedPartial.render(80).join('\n'), /1\/2.*searching.*second query/i);

  const narrowPartial = tool.renderResult({
    content: [{ type: 'text', text: 'searching' }],
    details: {
      phase: 'searching',
      index: 1,
      total: 2,
      query: 'a deliberately long research query that would otherwise wrap inside the tool shell',
      successfulQueries: 1,
      failedQueries: 0,
    },
  }, { expanded: false, isPartial: true }, theme, {});
  assert.equal(narrowPartial.render(68).length, 1);

  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {});
  assert.match(collapsed.render(80).join('\n'), /2\/2 results ready/);

  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme);
  assert.match(expanded.render(100).join('\n'), /\/result-store\/result-2\.md/);
});
