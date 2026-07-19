import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GIF_POST_ROLL_MS,
  DEFAULT_GIF_PRE_ROLL_MS,
  assertGifRecordingOwner,
  claimAndPrepareGifOutput,
  normalizeGifOutputPath,
  parseBoundedNumber,
  prepareGifOutput,
  recordGifSession,
} from '../scripts/gif-recorder.mjs';
import { ownerTokenHash } from '../scripts/browser-control.mjs';

test('GIF output requires an action-specific .gif filename', () => {
  const cwd = '/project/artifacts';
  assert.equal(
    normalizeGifOutputPath('login_process.gif', { cwd }),
    '/project/artifacts/login_process.gif',
  );
  assert.throws(
    () => normalizeGifOutputPath(null, { cwd }),
    /meaningful action-specific filename/,
  );
  assert.throws(
    () => normalizeGifOutputPath('recording.gif', { cwd }),
    /too generic.*login_process\.gif/,
  );
  assert.throws(
    () => normalizeGifOutputPath('checkout_process.mp4', { cwd }),
    /must end in \.gif/,
  );
});

test('GIF numeric options enforce safe bounds', () => {
  assert.equal(parseBoundedNumber(null, '--fps', { fallback: 10, min: 1, max: 30, integer: true }), 10);
  assert.equal(parseBoundedNumber('8', '--fps', { fallback: 10, min: 1, max: 30, integer: true }), 8);
  assert.throws(
    () => parseBoundedNumber('31', '--fps', { fallback: 10, min: 1, max: 30, integer: true }),
    /from 1 to 30/,
  );
  assert.throws(
    () => parseBoundedNumber('1.5', '--fps', { fallback: 10, min: 1, max: 30, integer: true }),
    /expected an integer/,
  );
});

test('GIF session captures pre-action and post-action time around the interaction', async () => {
  const events = [];
  let phase = 'not-started';
  let clock = 0;
  const page = {
    screenshot: async () => Buffer.from('real-page-frame'),
  };

  const result = await recordGifSession({
    page,
    output: '/project/artifacts/login_process.gif',
    fps: 10,
    preRollMs: 600,
    postRollMs: 800,
    shouldStop: () => true,
    onPhase: async (nextPhase) => {
      phase = nextPhase;
      events.push(['phase', nextPhase]);
    },
    sleepFn: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    encoderFactory: (options) => {
      events.push(['start', options]);
      return {
        writeFrame: async () => events.push(['frame', phase]),
        stop: async () => events.push(['stop']),
      };
    },
  });

  assert.equal(result.reason, 'requested');
  assert.equal(result.frameCount, 14);
  assert.deepEqual(events.filter(([event]) => event === 'phase'), [
    ['phase', 'pre-roll'],
    ['phase', 'recording'],
    ['phase', 'post-roll'],
  ]);
  assert.equal(events.filter(([event, framePhase]) => event === 'frame' && framePhase === 'pre-roll').length, 6);
  assert.equal(events.filter(([event, framePhase]) => event === 'frame' && framePhase === 'post-roll').length, 8);
  assert.deepEqual(events.at(-1), ['stop']);
  assert.ok(DEFAULT_GIF_PRE_ROLL_MS > 0);
  assert.ok(DEFAULT_GIF_POST_ROLL_MS > 0);
});

test('GIF recording ownership uses the browser owner token hash', () => {
  const state = { ownerTokenHash: ownerTokenHash('correct-token') };
  assert.doesNotThrow(() => assertGifRecordingOwner(state, 'correct-token'));
  assert.throws(() => assertGifRecordingOwner(state, null), /Missing browser owner token/);
  assert.throws(() => assertGifRecordingOwner(state, 'wrong-token'), /owned by another/);
  assert.doesNotMatch(JSON.stringify(state), /correct-token/);
});

test('GIF output preparation creates parents and preserves existing files by default', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gif-recorder-test-'));
  try {
    const output = join(directory, 'nested', 'checkout_process.gif');
    prepareGifOutput(output);
    assert.equal(existsSync(join(directory, 'nested')), true);
    assert.equal(existsSync(output), true);
    assert.equal(statSync(output).mode & 0o777, 0o600);

    writeFileSync(output, 'existing GIF');
    chmodSync(output, 0o644);
    assert.throws(() => prepareGifOutput(output), /already exists.*--overwrite/);
    assert.equal(readFileSync(output, 'utf-8'), 'existing GIF');
    assert.doesNotThrow(() => prepareGifOutput(output, { overwrite: true }));
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('GIF recorder claims ownership before creating or truncating output', () => {
  const calls = [];
  claimAndPrepareGifOutput(9222, '/captures/login_process.gif', { overwrite: true }, {
    claim: () => calls.push('claim'),
    prepare: () => calls.push('prepare'),
    release: () => calls.push('release'),
  });
  assert.deepEqual(calls, ['claim', 'prepare']);

  const failedCalls = [];
  assert.throws(() => claimAndPrepareGifOutput(9222, '/captures/login_process.gif', {}, {
    claim: () => failedCalls.push('claim'),
    prepare: () => {
      failedCalls.push('prepare');
      throw new Error('output exists');
    },
    release: () => failedCalls.push('release'),
  }), /output exists/);
  assert.deepEqual(failedCalls, ['claim', 'prepare', 'release']);

  const rejectedCalls = [];
  assert.throws(() => claimAndPrepareGifOutput(9222, '/captures/login_process.gif', {}, {
    claim: () => {
      rejectedCalls.push('claim');
      throw new Error('recording already active');
    },
    prepare: () => rejectedCalls.push('prepare'),
    release: () => rejectedCalls.push('release'),
  }), /recording already active/);
  assert.deepEqual(rejectedCalls, ['claim']);
});
