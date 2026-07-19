#!/usr/bin/env node
/**
 * Record the active browser tab as a GIF around a multi-step interaction.
 * Start waits for pre-action frames; stop captures post-action frames before finalizing.
 *
 * Usage:
 *   scripts/record-gif.mjs start --output ./login_process.gif [--port 9223]
 *   scripts/record-gif.mjs status [--port 9223] [--json]
 *   scripts/record-gif.mjs stop [--port 9223]
 */

import { closeSync, openSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OWNER_TOKEN_ENV,
  hasFlag,
  optionValue,
  parseOwnerToken,
  parsePort,
  requiredOptionValue,
} from './browser-control.mjs';
import {
  DEFAULT_GIF_COLORS,
  DEFAULT_GIF_FPS,
  DEFAULT_GIF_MAX_DURATION_SECONDS,
  DEFAULT_GIF_POST_ROLL_MS,
  DEFAULT_GIF_PRE_ROLL_MS,
  DEFAULT_GIF_SCALE,
  GIF_STOP_TIMEOUT_MS,
  assertFfmpegAvailable,
  assertGifRecordingOwner,
  claimGifRecording,
  gifRecordingLogFile,
  gifRecordingReport,
  normalizeGifOutputPath,
  parseBoundedNumber,
  prepareGifOutput,
  readGifRecordingState,
  removeGifRecordingState,
  requestGifRecordingStop,
  runGifRecordingWorker,
  waitForGifRecordingState,
} from './gif-recorder.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function usage() {
  console.error(`Usage: browser-tools record-gif <command> [options]

Commands:
  start --output <meaningful.gif>  Start recording and capture pre-action frames
  status [--json]                 Report recording status
  stop                            Capture post-action frames and finish the GIF

Options:
  --port <n>                      Managed browser port (default: 9222)
  --owner-token <token>           Prefer ${OWNER_TOKEN_ENV} instead
  --fps <1-30>                    GIF frame rate (default: ${DEFAULT_GIF_FPS})
  --colors <2-256>                GIF palette size (default: ${DEFAULT_GIF_COLORS})
  --scale <0.1-2>                 Output scale (default: ${DEFAULT_GIF_SCALE})
  --pre-roll-ms <100-10000>       Frames before actions (default: ${DEFAULT_GIF_PRE_ROLL_MS})
  --post-roll-ms <100-10000>      Frames after actions (default: ${DEFAULT_GIF_POST_ROLL_MS})
  --max-duration <1-3600>         Safety limit in seconds (default: ${DEFAULT_GIF_MAX_DURATION_SECONDS})
  --overwrite                     Replace an existing output file

Use an action-specific filename such as login_process.gif, not recording.gif.`);
}

function startOptions(args) {
  const value = (name) => optionValue(args, name, null);
  return {
    fps: parseBoundedNumber(value('--fps'), '--fps', { fallback: DEFAULT_GIF_FPS, min: 1, max: 30, integer: true }),
    colors: parseBoundedNumber(value('--colors'), '--colors', { fallback: DEFAULT_GIF_COLORS, min: 2, max: 256, integer: true }),
    scale: parseBoundedNumber(value('--scale'), '--scale', { fallback: DEFAULT_GIF_SCALE, min: 0.1, max: 2 }),
    preRollMs: parseBoundedNumber(value('--pre-roll-ms'), '--pre-roll-ms', { fallback: DEFAULT_GIF_PRE_ROLL_MS, min: 100, max: 10000, integer: true }),
    postRollMs: parseBoundedNumber(value('--post-roll-ms'), '--post-roll-ms', { fallback: DEFAULT_GIF_POST_ROLL_MS, min: 100, max: 10000, integer: true }),
    maxDurationSeconds: parseBoundedNumber(value('--max-duration'), '--max-duration', { fallback: DEFAULT_GIF_MAX_DURATION_SECONDS, min: 1, max: 3600, integer: true }),
  };
}

async function startRecording(args) {
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);
  if (!ownerToken) {
    throw new Error(`Missing browser owner token. Export ${OWNER_TOKEN_ENV} with the token printed by browser-tools start`);
  }

  const output = normalizeGifOutputPath(requiredOptionValue(args, '--output', null));
  const overwrite = hasFlag(args, '--overwrite');
  const options = startOptions(args);
  assertFfmpegAvailable();
  prepareGifOutput(output, { overwrite });
  claimGifRecording(port);

  const logFile = gifRecordingLogFile(port);
  let logFd = null;
  try {
    logFd = openSync(logFile, 'a', 0o600);
    const workerArgs = [
      SCRIPT_FILE,
      'worker',
      '--port', String(port),
      '--output', output,
      '--fps', String(options.fps),
      '--colors', String(options.colors),
      '--scale', String(options.scale),
      '--pre-roll-ms', String(options.preRollMs),
      '--post-roll-ms', String(options.postRollMs),
      '--max-duration', String(options.maxDurationSeconds),
    ];

    const child = spawn(process.execPath, workerArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, [OWNER_TOKEN_ENV]: ownerToken },
    });
    child.unref();
  } catch (error) {
    removeGifRecordingState(port);
    throw error;
  } finally {
    if (logFd !== null) closeSync(logFd);
  }

  const state = await waitForGifRecordingState(
    port,
    (candidate) => candidate.status === 'recording' || candidate.status === 'failed',
  );
  if (!state) {
    throw new Error(`GIF recorder did not start within 30 seconds. See ${logFile}`);
  }
  if (state.status === 'failed') {
    const message = state.error || 'unknown recorder failure';
    throw new Error(`GIF recorder failed: ${message}. See ${logFile}`);
  }

  console.log(`✓ Recording active tab to ${output}`);
  console.log(`✓ Captured ${options.preRollMs}ms of pre-action frames; perform browser actions now`);
}

function statusRecording(args) {
  const port = parsePort(args);
  const report = gifRecordingReport(port);
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!report.status) {
    console.log(`No GIF recording found for port ${port}`);
  } else if (report.recording) {
    console.log(`✓ GIF recording ${report.phase} on :${port}: ${report.output}`);
  } else {
    console.log(`GIF recording ${report.status} on :${port}: ${report.output}`);
  }
}

async function stopRecording(args) {
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);
  const initialState = readGifRecordingState(port);
  if (!initialState) throw new Error(`No GIF recording found on port ${port}`);
  assertGifRecordingOwner(initialState, ownerToken);

  if (initialState.status === 'completed') {
    console.log(initialState.output);
    removeGifRecordingState(port);
    return;
  }
  if (initialState.status === 'failed') {
    throw new Error(`GIF recorder failed: ${initialState.error || 'unknown failure'}. See ${gifRecordingLogFile(port)}`);
  }

  requestGifRecordingStop(port, ownerToken);
  console.error('⟳ Capturing post-action frames and finalizing GIF...');
  const timeoutMs = GIF_STOP_TIMEOUT_MS + (initialState.options?.postRollMs || DEFAULT_GIF_POST_ROLL_MS);
  const state = await waitForGifRecordingState(
    port,
    (candidate) => candidate.status === 'completed' || candidate.status === 'failed',
    { timeoutMs },
  );
  if (!state || !['completed', 'failed'].includes(state.status)) {
    throw new Error(`GIF recorder did not stop within ${Math.ceil(timeoutMs / 1000)} seconds. Check browser-tools record-gif status --port ${port}`);
  }
  if (state.status === 'failed') {
    throw new Error(`GIF recorder failed: ${state.error || 'unknown failure'}. See ${gifRecordingLogFile(port)}`);
  }

  console.log(state.output);
  removeGifRecordingState(port);
}

async function runWorker(args) {
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);
  const output = normalizeGifOutputPath(requiredOptionValue(args, '--output', null));
  await runGifRecordingWorker({
    port,
    output,
    ownerToken,
    ...startOptions(args),
  });
}

export async function main(args = process.argv.slice(2)) {
  const [command] = args;
  if (!command || command === '--help' || command === '-h') {
    usage();
    return command ? 0 : 1;
  }

  if (command === 'start') await startRecording(args.slice(1));
  else if (command === 'status') statusRecording(args.slice(1));
  else if (command === 'stop') await stopRecording(args.slice(1));
  else if (command === 'worker') await runWorker(args.slice(1));
  else {
    usage();
    throw new Error(`Unknown record-gif command: ${command}`);
  }
  return 0;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(SCRIPT_FILE);
}

if (isDirectExecution()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
