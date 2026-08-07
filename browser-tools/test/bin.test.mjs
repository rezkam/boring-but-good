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
  for (const name of ['start', 'status', 'stop', 'nav', 'eval', 'screenshot', 'record-gif', 'review-gif', 'record-har', 'extract-har', 'record-cdp', 'cdp', 'pick', 'scrape-page', 'extract-article', 'config']) {
    assert.match(result.stderr, new RegExp(`^  ${name}$`, 'm'), `--help should list "${name}"`);
  }
});

test('network capture commands expose actionable no-argument usage', () => {
  for (const [command, pattern] of [
    ['record-har', /Usage: browser-tools record-har/],
    ['extract-har', /Usage: browser-tools extract-har/],
    ['record-cdp', /Usage: browser-tools record-cdp/],
    ['cdp', /Usage: browser-tools cdp call/],
  ]) {
    const result = run([command]);
    assert.equal(result.status, 1, `${command} should reject missing arguments`);
    assert.match(result.stderr, pattern);
  }
});

test('HAR and CDP status commands do not require a running browser', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bin-network-status-test-'));
  try {
    for (const [command, kind] of [['record-har', 'har'], ['record-cdp', 'cdp']]) {
      const result = run([command, 'status', '--port', '9222', '--json'], { BROWSER_TOOLS_CACHE_DIR: tmp });
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), { recording: false, kind, port: 9222 });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('review-gif without a GIF path prints usage and exits non-zero', () => {
  const result = run(['review-gif']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: browser-tools review-gif <meaningful\.gif>/);
});

test('record-gif start rejects a generic output name through the public CLI', () => {
  const result = run(['record-gif', 'start', '--output', 'recording.gif'], {
    BROWSER_TOOLS_OWNER_TOKEN: 'gif-name-validation-test',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /too generic.*login_process\.gif/);
});

test('record-gif status dispatches without requiring a running browser', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bin-gif-status-test-'));
  try {
    const result = run(['record-gif', 'status', '--port', '9222', '--json'], { BROWSER_TOOLS_CACHE_DIR: tmp });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { recording: false, port: 9222 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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

test('start stamps a CLI owner so a command-line launch is never unowned', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bin-start-owner-test-'));
  try {
    // A missing binary stops the launch just after the owner check, so no browser is started.
    const result = run(['start', '--port', '65407'], {
      BROWSER_TOOLS_CACHE_DIR: tmp,
      BROWSER_TOOLS_CHROME_BIN: join(tmp, 'missing-chrome'),
      BROWSER_TOOLS_OWNER_ID: '',
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /without an owner id/i, 'the CLI must supply its own owner id');
    assert.match(result.stderr, /Chrome binary not found/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
