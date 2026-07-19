#!/usr/bin/env node
/**
 * Record selected active-tab CDP events as private JSON Lines.
 *
 * Usage:
 *   scripts/record-cdp.mjs start --output ./checkout_network_events.jsonl --domain Network
 *   scripts/record-cdp.mjs status --json
 *   scripts/record-cdp.mjs stop
 */

import { closeSync, existsSync, openSync, realpathSync, writeSync } from 'node:fs';
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
import { openPrivateFile, privateOutputPath, withPageCdpSession } from './cdp-common.mjs';
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
  DEFAULT_CDP_POST_WAIT_MS,
  parseCdpEventCaptureOptions,
  runCdpEventCapture,
} from './cdp-event-capture.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const CAPTURE_KIND = 'cdp';

function usage() {
  console.error(`Usage: browser-tools record-cdp <command> [options]

Commands:
  start --output <meaningful.jsonl>  Start raw active-tab CDP event capture
  status [--json]                   Report CDP capture status
  stop                              Capture the post-wait period and finalize

Selection:
  --domain <name>                   Enable a CDP domain, repeatable
  --event <pattern>                 Include Domain.event or Domain.*, repeatable
  --exclude-event <pattern>         Exclude event pattern, repeatable
  --skip-enable <domain>            Subscribe without calling Domain.enable
  --setup <json|Domain.method>      Session setup command, repeatable

Lifecycle:
  --post-wait-ms <n>                Capture after stop request (default: 500)
  --max-duration <seconds>          Safety limit (default: 300)
  --max-events <n>                  Event safety limit (default: 100000)
  --redact                          Redact auth, cookies, bodies, and frame payloads
  --overwrite                       Replace existing output
  --port <n>                        Managed browser port (default: 9222)
  --owner-token <token>             Prefer ${OWNER_TOKEN_ENV} instead

Each JSONL record contains an ISO timestamp, elapsed milliseconds, CDP method, and
parameters. Outputs are private (0600). The Browser Tools owner token is never stored.`);
}

function encodeOptions(options) {
  return Buffer.from(JSON.stringify(options), 'utf-8').toString('base64url');
}

function decodeOptions(value) {
  if (!value) throw new Error('Missing internal CDP worker options');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'));
}

async function startCapture(args) {
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);
  if (!ownerToken) {
    throw new Error(`Missing browser owner token. Export ${OWNER_TOKEN_ENV} with the token printed by browser-tools start`);
  }
  const overwrite = hasFlag(args, '--overwrite');
  const output = privateOutputPath(requiredOptionValue(args, '--output', null), 'jsonl', { overwrite });
  const options = parseCdpEventCaptureOptions(args);
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
  if (!state) throw new Error(`CDP recorder did not start within 30 seconds. See ${logFile}`);
  if (state.status === 'failed') throw new Error(`CDP recorder failed: ${state.error || 'unknown failure'}. See ${logFile}`);
  console.log(`✓ CDP capture active on :${port}: ${output}`);
}

function showStatus(args) {
  const port = parsePort(args);
  const report = cdpRecordingReport(CAPTURE_KIND, port);
  if (hasFlag(args, '--json')) console.log(JSON.stringify(report, null, 2));
  else if (report.recording) console.log(`✓ CDP capture ${report.phase} on :${port}: ${report.output}`);
  else if (report.status) console.log(`CDP capture ${report.status} on :${port}: ${report.output}`);
  else console.log(`No CDP capture found for port ${port}`);
}

async function stopCapture(args) {
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);
  const initialState = readCdpRecordingState(CAPTURE_KIND, port);
  if (!initialState) throw new Error(`No CDP capture found on port ${port}`);
  assertCdpRecordingOwner(initialState, ownerToken);
  if (initialState.status === 'completed') {
    console.log(initialState.output);
    removeCdpRecordingState(CAPTURE_KIND, port);
    return;
  }
  if (initialState.status === 'failed') {
    throw new Error(`CDP recorder failed: ${initialState.error || 'unknown failure'}. See ${cdpRecordingLogFile(CAPTURE_KIND, port)}`);
  }

  requestCdpRecordingStop(CAPTURE_KIND, port, ownerToken);
  console.error('⟳ Capturing final CDP events and closing JSONL...');
  const timeoutMs = CDP_CAPTURE_STOP_TIMEOUT_MS
    + (initialState.options?.postWaitMs || DEFAULT_CDP_POST_WAIT_MS);
  const state = await waitForCdpRecordingState(
    CAPTURE_KIND,
    port,
    (candidate) => ['completed', 'failed'].includes(candidate.status),
    { timeoutMs },
  );
  if (!state || !['completed', 'failed'].includes(state.status)) {
    throw new Error(`CDP recorder did not stop within ${Math.ceil(timeoutMs / 1000)} seconds`);
  }
  if (state.status === 'failed') {
    throw new Error(`CDP recorder failed: ${state.error || 'unknown failure'}. See ${cdpRecordingLogFile(CAPTURE_KIND, port)}`);
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

  let outputFd = null;
  try {
    const result = await withPageCdpSession(port, ownerToken, async ({ session }) => {
      outputFd = openPrivateFile(output, 'w');
      return runCdpEventCapture({
        session,
        options,
        shouldStop: () => existsSync(cdpRecordingStopFile(CAPTURE_KIND, port)),
        writeEvent: (event) => writeSync(outputFd, `${JSON.stringify(event)}\n`),
        onPhase: (phase, reason = null) => update({
          status: phase === 'recording' ? 'recording' : state.status,
          phase,
          reason: reason ?? state.reason,
          readyAt: phase === 'recording' ? new Date().toISOString() : state.readyAt,
        }),
      });
    });
    closeSync(outputFd);
    outputFd = null;
    update({
      status: 'completed',
      phase: 'completed',
      reason: result.reason,
      eventCount: result.eventCount,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (outputFd !== null) closeSync(outputFd);
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
    throw new Error(`Unknown record-cdp command: ${command}`);
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
