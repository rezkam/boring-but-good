import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OWNER_TOKEN_ENV,
  browserToolsCacheDir,
  ensureCacheDir,
  normalizePort,
  ownerTokenHash,
  sleep,
} from './browser-control.mjs';

export const CDP_CAPTURE_START_TIMEOUT_MS = 30000;
export const CDP_CAPTURE_STOP_TIMEOUT_MS = 30000;

function safeKind(kind) {
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new Error(`Invalid capture kind: ${kind}`);
  return kind;
}

function writePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort. State contains output paths but never the owner token itself.
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function processExists(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function cdpRecordingDir(kind, port) {
  return join(browserToolsCacheDir(), `${safeKind(kind)}-recording-${normalizePort(port)}`);
}

export function cdpRecordingStateFile(kind, port) {
  return join(cdpRecordingDir(kind, port), 'state.json');
}

export function cdpRecordingStopFile(kind, port) {
  return join(cdpRecordingDir(kind, port), 'stop-request.json');
}

export function cdpRecordingLogFile(kind, port) {
  return join(cdpRecordingDir(kind, port), 'recorder.log');
}

export function readCdpRecordingState(kind, port) {
  return readJson(cdpRecordingStateFile(kind, port));
}

export function updateCdpRecordingState(kind, port, state) {
  writePrivateJson(cdpRecordingStateFile(kind, port), state);
  return state;
}

export function cdpRecordingReport(kind, port) {
  const normalizedPort = normalizePort(port);
  const state = readCdpRecordingState(kind, normalizedPort);
  if (!state) return { recording: false, kind, port: normalizedPort };
  const processRunning = processExists(state.pid);
  const terminal = ['completed', 'failed'].includes(state.status);
  return {
    recording: processRunning && !terminal,
    processRunning,
    kind,
    port: normalizedPort,
    pid: state.pid ?? null,
    status: state.status ?? 'unknown',
    phase: state.phase ?? null,
    output: state.output ?? null,
    eventCount: state.eventCount ?? null,
    startedAt: state.startedAt ?? null,
    completedAt: state.completedAt ?? null,
    reason: state.reason ?? null,
    error: state.error ?? null,
  };
}

export function claimCdpRecording(kind, port) {
  const normalizedPort = normalizePort(port);
  ensureCacheDir();
  const directory = cdpRecordingDir(kind, normalizedPort);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(directory, { mode: 0o700 });
      return directory;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const state = readCdpRecordingState(kind, normalizedPort);
      if (state && processExists(state.pid) && !['completed', 'failed'].includes(state.status)) {
        throw new Error(`A ${kind} capture is already active on port ${normalizedPort}: ${state.output}`);
      }
      let stale = Boolean(state);
      try {
        stale ||= Date.now() - statSync(directory).mtimeMs > CDP_CAPTURE_START_TIMEOUT_MS;
      } catch {
        stale = true;
      }
      if (!stale) throw new Error(`A ${kind} capture is already starting on port ${normalizedPort}`);
      rmSync(directory, { recursive: true, force: true });
    }
  }
  throw new Error(`Could not claim ${kind} capture state for port ${normalizedPort}`);
}

export function assertCdpRecordingOwner(state, ownerToken) {
  if (!state?.ownerTokenHash) throw new Error('Capture has no owner information');
  if (!ownerToken) {
    throw new Error(`Missing browser owner token. Export ${OWNER_TOKEN_ENV} with the token printed by browser-tools start`);
  }
  if (ownerTokenHash(ownerToken) !== state.ownerTokenHash) {
    throw new Error('Capture is owned by another Browser Tools agent');
  }
}

export function requestCdpRecordingStop(kind, port, ownerToken) {
  const state = readCdpRecordingState(kind, port);
  if (!state) throw new Error(`No ${kind} capture found on port ${normalizePort(port)}`);
  assertCdpRecordingOwner(state, ownerToken);
  writePrivateJson(cdpRecordingStopFile(kind, port), { requestedAt: new Date().toISOString() });
  return state;
}

export async function waitForCdpRecordingState(kind, port, predicate, {
  timeoutMs = CDP_CAPTURE_START_TIMEOUT_MS,
  intervalMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = readCdpRecordingState(kind, port);
    if (state && predicate(state)) return state;
    await sleep(intervalMs);
  }
  return state;
}

export function removeCdpRecordingState(kind, port) {
  rmSync(cdpRecordingDir(kind, port), { recursive: true, force: true });
}
