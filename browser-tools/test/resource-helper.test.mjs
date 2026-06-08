import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBrowserResource,
  runCachedBrowserResource,
} from '../scripts/resource-helper.mjs';

function tmpFile(name) {
  const dir = mkdtempSync(join(tmpdir(), 'resource-helper-test-'));
  return { dir, file: join(dir, name) };
}

async function withSilencedConsole(callback) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await callback();
  } finally {
    console.log = originalLog;
  }
}

test('runCachedBrowserResource serves cache without connecting to Chrome', async () => {
  const { dir, file } = tmpFile('cached.md');
  try {
    const result = await withSilencedConsole(() => runCachedBrowserResource({
      tool: 'helper-a',
      cacheInput: { q: 'x' },
      outFile: file,
      readCache: () => ({
        key: 'cache-key-a',
        output: 'cached output',
        entry: { metadata: { source: 'helper-a' } },
      }),
      connect: async () => {
        throw new Error('should not connect on cache hit');
      },
      run: async () => {
        throw new Error('should not run on cache hit');
      },
    }));

    assert.equal(result.status, 'cached');
    assert.equal(readFileSync(file, 'utf-8'), 'cached output');
    assert.deepEqual(JSON.parse(readFileSync(`${file}.meta.json`, 'utf-8')), {
      source: 'helper-a',
      cache_hit: true,
      cache_key: 'cache-key-a',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCachedBrowserResource owns fresh browser page lifecycle, cache write, and output sidecar', async () => {
  const { dir, file } = tmpFile('fresh.json');
  const calls = [];
  let cachePayload = null;
  let pageClosed = false;
  const page = {
    url: () => 'https://example.test/data',
    isClosed: () => pageClosed,
    close: async () => {
      pageClosed = true;
      calls.push('close');
    },
  };
  const browser = {
    newPage: async (options) => {
      calls.push(['newPage', options]);
      return page;
    },
    disconnect: () => calls.push('disconnect'),
  };

  try {
    const result = await withSilencedConsole(() => runCachedBrowserResource({
      tool: 'helper-b',
      cacheInput: { q: 'fresh' },
      outFile: file,
      port: 9333,
      ownerToken: 'owner-a',
      connect: async (port, options) => {
        calls.push(['connect', port, options]);
        return browser;
      },
      readCache: () => null,
      writeCache: (tool, input, payload) => {
        cachePayload = { tool, input, payload };
        return { key: 'fresh-key-b' };
      },
      run: async ({ page }) => ({
        output: '{"ok":true}',
        metadata: { source: 'helper-b', cache_hit: false },
        pageUrl: page.url(),
        extension: 'json',
      }),
    }));

    assert.equal(result.status, 'fresh');
    assert.equal(readFileSync(file, 'utf-8'), '{"ok":true}');
    assert.deepEqual(JSON.parse(readFileSync(`${file}.meta.json`, 'utf-8')), {
      source: 'helper-b',
      cache_hit: false,
      cache_key: 'fresh-key-b',
    });
    assert.deepEqual(cachePayload.tool, 'helper-b');
    assert.deepEqual(cachePayload.input, { q: 'fresh' });
    assert.equal(cachePayload.payload.pageUrl, 'https://example.test/data');
    assert.deepEqual(calls, [
      ['connect', 9333, { ownerToken: 'owner-a' }],
      ['newPage', { background: true }],
      'close',
      'disconnect',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runBrowserResource disconnects when a generic extractor fails', async () => {
  const calls = [];
  const page = {
    isClosed: () => false,
    close: async () => calls.push('close'),
  };
  const browser = {
    disconnect: () => calls.push('disconnect'),
  };

  await assert.rejects(
    runBrowserResource({
      connect: async () => browser,
      getPage: async () => page,
      closePage: true,
      run: async () => {
        throw new Error('helper failed');
      },
    }),
    /helper failed/,
  );

  assert.deepEqual(calls, ['close', 'disconnect']);
});
