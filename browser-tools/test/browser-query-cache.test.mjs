import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCacheKey,
  getCacheConfig,
  readCachedResponse,
  writeCachedResponse,
} from '../scripts/browser-query-cache.mjs';

function withCacheEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === null) delete process.env[key];
    else process.env[key] = env[key];
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('buildCacheKey is stable across object key order', () => {
  const first = buildCacheKey('tool', { b: 2, a: 1, nested: { y: true, x: false } });
  const second = buildCacheKey('tool', { nested: { x: false, y: true }, a: 1, b: 2 });

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('cache is disabled unless BROWSER_QUERY_CACHE_DIR is set', async () => {
  await withCacheEnv({ BROWSER_QUERY_CACHE_DIR: null }, () => {
    assert.equal(getCacheConfig(), null);
    assert.equal(readCachedResponse('x', { a: 1 }), null);
    assert.equal(writeCachedResponse('x', { a: 1 }, { output: 'out' }), null);
  });
});

test('writeCachedResponse and readCachedResponse round trip output, raw text, metadata, and invocation records', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'browser-query-cache-'));
  const runDir = mkdtempSync(join(tmpdir(), 'browser-query-run-'));

  try {
    await withCacheEnv({
      BROWSER_QUERY_CACHE_DIR: cacheDir,
      BROWSER_QUERY_RUN_DIR: runDir,
      BROWSER_QUERY_STEP_ID: 'step-1',
      BROWSER_QUERY_STEP_LABEL: 'Fetch prices',
      BROWSER_QUERY_TTL_SECONDS: null,
    }, () => {
      const input = { tickers: ['AMZN', 'BZ=F'], json: false };
      const write = writeCachedResponse('yahoo-finance', input, {
        output: 'formatted output',
        rawText: 'raw output',
        pageUrl: 'https://finance.example.test',
        metadata: { source: 'test' },
        extension: 'md',
      });

      assert.ok(write);
      assert.ok(existsSync(write.entryPath));
      assert.ok(existsSync(write.responsePath));
      assert.ok(existsSync(write.rawPath));

      const cached = readCachedResponse('yahoo-finance', input);
      assert.equal(cached.output, 'formatted output');
      assert.equal(cached.rawText, 'raw output');
      assert.deepEqual(cached.entry.metadata, { source: 'test' });

      const invocationDir = join(runDir, 'browser-tool-calls', 'step-1');
      assert.ok(existsSync(invocationDir));
      const invocationText = readFileSync(join(invocationDir, newestInvocationFile(invocationDir)), 'utf-8');
      assert.match(invocationText, /"tool": "yahoo-finance"/);
      assert.match(invocationText, /"step_label": "Fetch prices"/);
    });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

function newestInvocationFile(dir) {
  const files = readdirSync(dir).sort();
  assert.ok(files.length >= 1);
  return files.at(-1);
}
