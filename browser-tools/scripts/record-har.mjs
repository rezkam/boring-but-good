#!/usr/bin/env node
/**
 * Record filtered active-tab network traffic as a standard HAR 1.2 file.
 *
 * Usage:
 *   scripts/record-har.mjs start --output ./checkout_api_network.har [filters]
 *   scripts/record-har.mjs status [--json]
 *   scripts/record-har.mjs stop
 */

import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OWNER_TOKEN_ENV,
  hasFlag,
  ownerTokenHash,
  parseOwnerToken,
  parsePort,
  requiredOptionValue,
} from './browser-control.mjs';
import { privateOutputPath, withPageCdpSession } from './cdp-common.mjs';
import {
  CDP_CAPTURE_STOP_TIMEOUT_MS,
  assertCdpRecordingOwner,
  cdpRecordingLogFile,
  cdpRecordingReport,
  cdpRecordingStopFile,
  claimCdpRecording,
  readCdpRecordingState,
  removeCdpRecordingState,
  requestCdpRecordingStop,
  updateCdpRecordingState,
  waitForCdpRecordingState,
} from './cdp-recording-state.mjs';
import {
  DEFAULT_HAR_DRAIN_TIMEOUT_MS,
  parseHarCaptureOptions,
  runHarCapture,
  writeHar,
} from './har-capture.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const CAPTURE_KIND = 'har';

function usage() {
  console.error(`Usage: browser-tools record-har <command> [options]

Commands:
  start --output <meaningful.har>  Start filtered active-tab HAR capture
  status [--json]                 Report HAR capture status
  stop                            Drain in-flight requests and write the HAR

Selection:
  --preset <api|page|all>         Resource preset (default: all)
  --resource-type <types>         Include CDP types, repeatable or comma-separated
  --exclude-resource-type <types>
  --url-pattern <glob>            Include URL glob, repeatable
  --exclude-url-pattern <glob>
  --method <methods>              Include HTTP methods
  --exclude-method <methods>
  --status <code|range>           Include response status, for example 200-299
  --exclude-status <code|range>
  --mime-type <glob>              Include response MIME type
  --exclude-mime-type <glob>
  --min-size <bytes>
  --max-size <bytes>

Content and lifecycle:
  --capture <components>          headers,bodies,timing (default: all)
  --max-body-bytes <n>            Per-body capture limit (default: 1048576)
  --idle-ms <n>                   Required quiet period on stop (default: 500)
  --drain-timeout-ms <n>          Maximum in-flight drain wait (default: 5000)
  --max-duration <seconds>        Safety limit (default: 300)
  --include-sensitive             Keep auth, cookies, and secret-looking body fields
  --overwrite                     Replace existing output
  --port <n>                      Managed browser port (default: 9222)
  --owner-token <token>           Prefer ${OWNER_TOKEN_ENV} instead

Outputs are private (0600). The Browser Tools owner token is never stored in the HAR.`);
}

function encodeOptions(options) {
  return Buffer.from(JSON.stringify(options), 'utf-8').toString('base64url');
}

function decodeOptions(value) {
  if (!value) throw new Error('Missing internal HAR worker options');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'));
}

async function startCapture(args) {
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);
  if (!ownerToken) {
    throw new Error(`Missing browser owner token. Export ${OWNER_TOKEN_ENV} with the token printed by browser-tools start`);
  }
  const overwrite = hasFlag(args, '--overwrite');
  const output = privateOutputPath(requiredOptionValue(args, '--output', null), 'har', { overwrite });
  const options = parseHarCaptureOptions(args);
  claimCdpRecording(CAPTURE_KIND, port);

  const logFile = cdpRecordingLogFile(CAPTURE_KIND, port);
  let logFd = null;
  try {
    logFd = openSync(logFile, 'a', 0o600);
    const child = spawn(process.execPath, [
      SCRIPT_FILE,
      'worker',
      '--port', String(port),
      '--output', output,
      '--worker-options', encodeOptions(options),
    ], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, [OWNER_TOKEN_ENV]: ownerToken },
    });
    child.unref();
  } catch (error) {
    removeCdpRecordingState(CAPTURE_KIND, port);
    throw error;
  } finally {
    if (logFd !== null) closeSync(logFd);
  }

  const state = await waitForCdpRecordingState(
    CAPTURE_KIND,
    port,
    (candidate) => candidate.status === 'recording' || candidate.status === 'failed',
  );
  if (!state) throw new Error(`HAR recorder did not start within 30 seconds. See ${logFile}`);
  if (state.status === 'failed') throw new Error(`HAR recorder failed: ${state.error || 'unknown failure'}. See ${logFile}`);
  console.log(`✓ HAR capture active on :${port}: ${output}`);
}

function showStatus(args) {
  const port = parsePort(args);
  const report = cdpRecordingReport(CAPTURE_KIND, port);
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.recording) {
    console.log(`✓ HAR capture ${report.phase} on :${port}: ${report.output}`);
  } else if (report.status) {
    console.log(`HAR capture ${report.status} on :${port}: ${report.output}`);
  } else {
    console.log(`No HAR capture found for port ${port}`);
  }
}

async function stopCapture(args) {
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);
  const initialState = readCdpRecordingState(CAPTURE_KIND, port);
  if (!initialState) throw new Error(`No HAR capture found on port ${port}`);
  assertCdpRecordingOwner(initialState, ownerToken);
  if (initialState.status === 'completed') {
    console.log(initialState.output);
    removeCdpRecordingState(CAPTURE_KIND, port);
    return;
  }
  if (initialState.status === 'failed') {
    throw new Error(`HAR recorder failed: ${initialState.error || 'unknown failure'}. See ${cdpRecordingLogFile(CAPTURE_KIND, port)}`);
  }

  requestCdpRecordingStop(CAPTURE_KIND, port, ownerToken);
  console.error('⟳ Draining in-flight requests and finalizing HAR...');
  const timeoutMs = CDP_CAPTURE_STOP_TIMEOUT_MS
    + (initialState.options?.drainTimeoutMs || DEFAULT_HAR_DRAIN_TIMEOUT_MS);
  const state = await waitForCdpRecordingState(
    CAPTURE_KIND,
    port,
    (candidate) => ['completed', 'failed'].includes(candidate.status),
    { timeoutMs },
  );
  if (!state || !['completed', 'failed'].includes(state.status)) {
    throw new Error(`HAR recorder did not stop within ${Math.ceil(timeoutMs / 1000)} seconds`);
  }
  if (state.status === 'failed') {
    throw new Error(`HAR recorder failed: ${state.error || 'unknown failure'}. See ${cdpRecordingLogFile(CAPTURE_KIND, port)}`);
  }
  console.log(state.output);
  removeCdpRecordingState(CAPTURE_KIND, port);
}

async function runWorker(args) {
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);
  const output = requiredOptionValue(args, '--output', null);
  const options = decodeOptions(requiredOptionValue(args, '--worker-options', null));
  const startedAt = new Date().toISOString();
  let state = {
    managedBy: 'browser-tools-cdp-recorder',
    kind: CAPTURE_KIND,
    pid: process.pid,
    port,
    output,
    ownerTokenHash: ownerTokenHash(ownerToken),
    status: 'starting',
    phase: 'starting',
    startedAt,
    options,
  };
  const update = (changes) => {
    state = { ...state, ...changes };
    updateCdpRecordingState(CAPTURE_KIND, port, state);
  };
  update({});

  try {
    const result = await withPageCdpSession(port, ownerToken, async ({ page, session }) => runHarCapture({
      session,
      page,
      options,
      shouldStop: () => existsSync(cdpRecordingStopFile(CAPTURE_KIND, port)),
      onPhase: (phase, reason = null) => update({
        status: phase === 'recording' ? 'recording' : state.status,
        phase,
        reason: reason ?? state.reason,
        readyAt: phase === 'recording' ? new Date().toISOString() : state.readyAt,
      }),
    }));
    writeHar(output, result.har);
    update({
      status: 'completed',
      phase: 'completed',
      reason: result.reason,
      eventCount: result.eventCount,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    update({
      status: 'failed',
      phase: 'failed',
      error: error.message,
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command] = args;
  if (!command || command === '--help' || command === '-h') {
    usage();
    return command ? 0 : 1;
  }
  if (command === 'start') await startCapture(args.slice(1));
  else if (command === 'status') showStatus(args.slice(1));
  else if (command === 'stop') await stopCapture(args.slice(1));
  else if (command === 'worker') await runWorker(args.slice(1));
  else {
    usage();
    throw new Error(`Unknown record-har command: ${command}`);
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
