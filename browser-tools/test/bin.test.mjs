import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/browser-tools.mjs', import.meta.url));

function run(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8', env: { ...process.env, ...env } });
}

test('no command prints usage to stderr and exits non-zero', () => {
  const result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: browser-tools <command>/);
});

test('--help prints usage and exits 0', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Usage: browser-tools <command>/);
});

test('unknown command exits 1 with an actionable error', () => {
  const result = run(['bogus']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: bogus/);
});

test('every dispatch table command names an existing usage line', () => {
  const result = run(['--help']);
  for (const name of ['start', 'status', 'stop', 'nav', 'eval', 'screenshot', 'pick', 'scrape-page', 'extract-article', 'config']) {
    assert.match(result.stderr, new RegExp(`^  ${name}$`, 'm'), `--help should list "${name}"`);
  }
});

test('status dispatches to scripts/status.mjs and reports no managed instance in an isolated cache dir', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bin-status-test-'));
  try {
    const result = run(['status', '--port', '9222', '--json'], { BROWSER_TOOLS_CACHE_DIR: tmp });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { running: false, port: 9222 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
