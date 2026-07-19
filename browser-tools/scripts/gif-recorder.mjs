import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';
import {
  OWNER_TOKEN_ENV,
  activePage,
  browserToolsCacheDir,
  connectBrowser,
  ensureCacheDir,
  normalizePort,
  ownerTokenHash,
  sleep,
} from './browser-control.mjs';

export const DEFAULT_GIF_FPS = 10;
export const DEFAULT_GIF_COLORS = 128;
export const DEFAULT_GIF_SCALE = 1;
export const DEFAULT_GIF_PRE_ROLL_MS = 1000;
export const DEFAULT_GIF_POST_ROLL_MS = 1000;
export const DEFAULT_GIF_MAX_DURATION_SECONDS = 120;
export const GIF_START_TIMEOUT_MS = 30000;
export const GIF_STOP_TIMEOUT_MS = 30000;

const GENERIC_GIF_STEMS = new Set([
  'animation',
  'browser',
  'browsercapture',
  'browsergif',
  'browserrecording',
  'capture',
  'demo',
  'gif',
  'output',
  'page',
  'recording',
  'test',
  'untitled',
  'website',
]);

function writePrivateJson(file, value) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryFile, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort. Recording state contains paths but never the owner token itself.
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

function normalizedStem(path) {
  return parse(basename(path)).name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function normalizeGifOutputPath(output, { cwd = process.cwd() } = {}) {
  if (!output || output === true || !String(output).trim()) {
    throw new Error('Missing --output. Use a meaningful action-specific filename, for example login_process.gif');
  }

  const path = resolve(cwd, String(output));
  if (extname(path).toLowerCase() !== '.gif') {
    throw new Error(`GIF output must end in .gif: ${output}`);
  }
  if (GENERIC_GIF_STEMS.has(normalizedStem(path))) {
    throw new Error(`GIF output name is too generic: ${basename(path)}. Describe the interaction, for example login_process.gif`);
  }
  return path;
}

export function parseBoundedNumber(value, name, { fallback, min, max, integer = false }) {
  if (value === null || value === undefined) return fallback;
  if (value === true || String(value).trim() === '') throw new Error(`Missing value after ${name}`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    const kind = integer ? 'an integer' : 'a number';
    throw new Error(`Invalid ${name} value: expected ${kind} from ${min} to ${max}, got "${value}"`);
  }
  return number;
}

export function gifRecordingDirForPort(port) {
  return join(browserToolsCacheDir(), `gif-recording-${normalizePort(port)}`);
}

export function gifRecordingStateFile(port) {
  return join(gifRecordingDirForPort(port), 'state.json');
}

export function gifRecordingStopFile(port) {
  return join(gifRecordingDirForPort(port), 'stop-request.json');
}

export function gifRecordingLogFile(port) {
  return join(gifRecordingDirForPort(port), 'recorder.log');
}

export function readGifRecordingState(port) {
  return readJson(gifRecordingStateFile(port));
}

export function gifRecordingReport(port) {
  const normalizedPort = normalizePort(port);
  const state = readGifRecordingState(normalizedPort);
  if (!state) return { recording: false, port: normalizedPort };

  const processRunning = processExists(state.pid);
  const terminal = state.status === 'completed' || state.status === 'failed';
  return {
    recording: processRunning && !terminal,
    processRunning,
    port: normalizedPort,
    pid: state.pid ?? null,
    status: state.status ?? 'unknown',
    phase: state.phase ?? null,
    output: state.output ?? null,
    startedAt: state.startedAt ?? null,
    completedAt: state.completedAt ?? null,
    reason: state.reason ?? null,
    error: state.error ?? null,
  };
}

export function claimGifRecording(port) {
  const normalizedPort = normalizePort(port);
  ensureCacheDir();
  const recordingDir = gifRecordingDirForPort(normalizedPort);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(recordingDir, { mode: 0o700 });
      return recordingDir;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      const state = readGifRecordingState(normalizedPort);
      if (state && processExists(state.pid) && !['completed', 'failed'].includes(state.status)) {
        throw new Error(`A GIF recording is already active on port ${normalizedPort}: ${state.output}`);
      }

      let stale = Boolean(state);
      try {
        stale ||= Date.now() - statSync(recordingDir).mtimeMs > GIF_START_TIMEOUT_MS;
      } catch {
        stale = true;
      }
      if (!stale) throw new Error(`A GIF recording is already starting on port ${normalizedPort}`);
      rmSync(recordingDir, { recursive: true, force: true });
    }
  }

  throw new Error(`Could not claim GIF recording state for port ${normalizedPort}`);
}

export function removeGifRecordingState(port) {
  rmSync(gifRecordingDirForPort(port), { recursive: true, force: true });
}

export function assertFfmpegAvailable() {
  const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8', stdio: 'ignore' });
  if (result.error?.code === 'ENOENT') {
    throw new Error('GIF recording requires ffmpeg. Install it with: brew install ffmpeg');
  }
  if (result.error) throw new Error(`Could not run ffmpeg: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg is not usable: exit status ${result.status}`);
}

export function createFfmpegGifEncoder({
  output,
  fps = DEFAULT_GIF_FPS,
  colors = DEFAULT_GIF_COLORS,
  scale = DEFAULT_GIF_SCALE,
}) {
  const filters = [];
  if (scale !== 1) filters.push(`scale=iw*${scale}:-1:flags=lanczos`);
  filters.push(`split[s0][s1];[s0]palettegen=stats_mode=diff:max_colors=${colors}[p];[s1][p]paletteuse=dither=bayer`);

  const child = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-vcodec', 'png',
    '-i', 'pipe:0',
    '-an',
    '-threads', '1',
    '-vf', filters.join(','),
    '-loop', '0',
    '-f', 'gif',
    '-y',
    output,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  let spawnError = null;
  let stderr = '';
  child.once('error', (error) => {
    spawnError = error;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf-8');
  });
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  return {
    async writeFrame(frame) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) {
        throw new Error(`ffmpeg exited before GIF recording finished${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
      }
      await new Promise((resolveWrite, rejectWrite) => {
        child.stdin.write(frame, (error) => error ? rejectWrite(error) : resolveWrite());
      });
    },
    async stop() {
      if (!child.stdin.destroyed) child.stdin.end();
      const result = await closed;
      if (spawnError) throw spawnError;
      if (result.code !== 0) {
        const termination = result.signal ? `signal ${result.signal}` : `exit status ${result.code}`;
        throw new Error(`ffmpeg failed to encode GIF (${termination})${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
      }
    },
  };
}

export function assertGifRecordingOwner(state, ownerToken) {
  if (!state?.ownerTokenHash) throw new Error('GIF recording has no owner information');
  if (!ownerToken) {
    throw new Error(`Missing browser owner token. Export ${OWNER_TOKEN_ENV} with the token printed by browser-tools start`);
  }
  if (ownerTokenHash(ownerToken) !== state.ownerTokenHash) {
    throw new Error('GIF recording is owned by another Browser Tools agent');
  }
}

export function requestGifRecordingStop(port, ownerToken) {
  const normalizedPort = normalizePort(port);
  const state = readGifRecordingState(normalizedPort);
  if (!state) throw new Error(`No GIF recording found on port ${normalizedPort}`);
  assertGifRecordingOwner(state, ownerToken);
  writePrivateJson(gifRecordingStopFile(normalizedPort), { requestedAt: new Date().toISOString() });
  return state;
}

export async function waitForGifRecordingState(port, predicate, { timeoutMs = GIF_START_TIMEOUT_MS, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = readGifRecordingState(port);
    if (state && predicate(state)) return state;
    await sleep(intervalMs);
  }
  return state;
}

export async function recordGifSession({
  page,
  output,
  fps = DEFAULT_GIF_FPS,
  colors = DEFAULT_GIF_COLORS,
  scale = DEFAULT_GIF_SCALE,
  preRollMs = DEFAULT_GIF_PRE_ROLL_MS,
  postRollMs = DEFAULT_GIF_POST_ROLL_MS,
  maxDurationSeconds = DEFAULT_GIF_MAX_DURATION_SECONDS,
  shouldStop = () => false,
  onPhase = () => {},
  sleepFn = sleep,
  now = () => Date.now(),
  encoderFactory = createFfmpegGifEncoder,
}) {
  const encoder = encoderFactory({
    output,
    fps,
    colors,
    scale,
  });
  const frameIntervalMs = 1000 / fps;
  let nextFrameAt = now();
  let frameCount = 0;

  const captureFrame = async () => {
    const waitMs = Math.max(0, nextFrameAt - now());
    if (waitMs > 0) await sleepFn(waitMs);
    const frame = await page.screenshot({
      type: 'png',
      encoding: 'binary',
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    });
    await encoder.writeFrame(frame);
    frameCount += 1;
    nextFrameAt += frameIntervalMs;
    if (nextFrameAt < now()) nextFrameAt = now();
  };

  const capturePeriod = async (durationMs) => {
    const periodStartedAt = now();
    const requiredFrames = Math.max(1, Math.ceil(durationMs / frameIntervalMs));
    for (let frame = 0; frame < requiredFrames; frame += 1) await captureFrame();
    const remainingMs = periodStartedAt + durationMs - now();
    if (remainingMs > 0) await sleepFn(remainingMs);
  };

  try {
    await onPhase('pre-roll');
    await capturePeriod(preRollMs);
    await onPhase('recording');

    const deadline = now() + maxDurationSeconds * 1000;
    while (!shouldStop() && now() < deadline) {
      await captureFrame();
    }

    const stopRequested = shouldStop();
    const reason = stopRequested ? 'requested' : 'max-duration';
    await onPhase('post-roll', reason);
    await capturePeriod(postRollMs);
    await encoder.stop();
    return { reason, frameCount };
  } catch (error) {
    await encoder.stop().catch(() => {});
    throw error;
  }
}

export async function runGifRecordingWorker({
  port,
  output,
  ownerToken,
  fps = DEFAULT_GIF_FPS,
  colors = DEFAULT_GIF_COLORS,
  scale = DEFAULT_GIF_SCALE,
  preRollMs = DEFAULT_GIF_PRE_ROLL_MS,
  postRollMs = DEFAULT_GIF_POST_ROLL_MS,
  maxDurationSeconds = DEFAULT_GIF_MAX_DURATION_SECONDS,
}) {
  const normalizedPort = normalizePort(port);
  const stateFile = gifRecordingStateFile(normalizedPort);
  const startedAt = new Date().toISOString();
  const baseState = {
    managedBy: 'browser-tools-gif-recorder',
    pid: process.pid,
    port: normalizedPort,
    output,
    ownerTokenHash: ownerTokenHash(ownerToken),
    status: 'starting',
    phase: 'starting',
    startedAt,
    options: { fps, colors, scale, preRollMs, postRollMs, maxDurationSeconds },
  };
  writePrivateJson(stateFile, baseState);

  let browser;
  let currentState = baseState;
  const updateState = (changes) => {
    currentState = { ...currentState, ...changes };
    writePrivateJson(stateFile, currentState);
  };

  try {
    browser = await connectBrowser(normalizedPort, { ownerToken });
    const page = await activePage(browser);
    const result = await recordGifSession({
      page,
      output,
      fps,
      colors,
      scale,
      preRollMs,
      postRollMs,
      maxDurationSeconds,
      shouldStop: () => existsSync(gifRecordingStopFile(normalizedPort)),
      onPhase: (phase, reason = null) => updateState({
        status: phase === 'recording' ? 'recording' : currentState.status,
        phase,
        readyAt: phase === 'recording' ? new Date().toISOString() : currentState.readyAt,
        reason: reason ?? currentState.reason,
      }),
    });
    updateState({
      status: 'completed',
      phase: 'completed',
      reason: result.reason,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    updateState({
      status: 'failed',
      phase: 'failed',
      error: error.message,
      completedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    browser?.disconnect();
  }
}

export function prepareGifOutput(output, { overwrite = false } = {}) {
  mkdirSync(dirname(output), { recursive: true });
  if (existsSync(output) && !overwrite) {
    throw new Error(`GIF output already exists: ${output}. Choose another meaningful name or pass --overwrite`);
  }
}
