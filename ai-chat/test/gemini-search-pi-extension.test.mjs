import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeminiSearchExtension } from '../extensions/gemini-search/index.ts';

const theme = {
  fg: (_name, text) => text,
  bold: text => text,
};

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
  createGeminiSearchExtension({ runBatch })({ registerTool(definition) { tool = definition; } });
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

test('pi extension registers a file-backed multi-query Gemini search tool', async () => {
  let tool;
  const statuses = [];
  const updates = [];
  const pi = {
    registerTool(definition) { tool = definition; },
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
    ui: { setStatus: (...args) => statuses.push(args) },
  });

  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Completed 2/2 Gemini searches in temporary chats.\nRead the full results from:\n1. /result-store/result-1.md\n2. /result-store/result-2.md',
  }]);
  assert.equal(updates.length, 3);
  assert.deepEqual(statuses.at(-1), ['gemini-search', undefined]);

  const partial = tool.renderResult(updates[0], { expanded: false, isPartial: true }, theme);
  assert.match(partial.render(80).join('\n'), /first query/);

  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme);
  assert.match(collapsed.render(80).join('\n'), /2\/2 results ready/);

  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme);
  assert.match(expanded.render(100).join('\n'), /\/result-store\/result-2\.md/);
});
