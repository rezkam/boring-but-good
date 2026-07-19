#!/usr/bin/env node
/**
 * Probe a GIF and render sampled frames as a contact sheet for visual review.
 *
 * Usage:
 *   scripts/review-gif.mjs ./login_process.gif
 *   scripts/review-gif.mjs ./login_process.gif --fps 2 --width 480 --columns 4 --rows 4
 *   scripts/review-gif.mjs ./login_process.gif --out-dir ./.gif-review --json
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFlag, optionValue, requiredOptionValue } from './browser-control.mjs';
import { openPrivateFile, writePrivateJson } from './cdp-common.mjs';
import { parseBoundedNumber } from './gif-recorder.mjs';

export const DEFAULT_REVIEW_FPS = 2;
export const DEFAULT_REVIEW_WIDTH = 480;
export const DEFAULT_REVIEW_COLUMNS = 4;
export const DEFAULT_REVIEW_ROWS = 4;

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function usage() {
  console.error(`Usage: browser-tools review-gif <meaningful.gif> [options]

Options:
  --out-dir <path>       Review output directory (default: <GIF directory>/.gif-review)
  --fps <0.1-30>         Maximum frame sampling rate (default: ${DEFAULT_REVIEW_FPS})
  --width <64-1920>      Width of each sampled frame (default: ${DEFAULT_REVIEW_WIDTH})
  --columns <1-10>       Contact sheet columns (default: ${DEFAULT_REVIEW_COLUMNS})
  --rows <1-10>          Contact sheet rows (default: ${DEFAULT_REVIEW_ROWS})
  --json                 Print the review report as JSON

The sampling rate is reduced automatically when needed so the sheet covers the full GIF.`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf-8' });
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${command} is required for GIF review. Install it with: brew install ffmpeg`);
  }
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit status ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function gifInputPath(value) {
  if (!value || value.startsWith('--')) throw new Error('Missing GIF path');
  const path = resolve(value);
  if (extname(path).toLowerCase() !== '.gif') throw new Error(`GIF input must end in .gif: ${value}`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`GIF input not found: ${path}`);
  return path;
}

function safeStem(path) {
  return parse(basename(path)).name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function gifProbe(path) {
  const raw = run('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames,duration,r_frame_rate:format=duration',
    '-of', 'json',
    path,
  ]);
  const probe = JSON.parse(raw);
  const stream = probe.streams?.[0];
  if (!stream || stream.codec_name !== 'gif') throw new Error(`Input is not a readable GIF: ${path}`);

  const frameCount = Number(stream.nb_read_frames);
  const durationSeconds = Number(stream.duration ?? probe.format?.duration);
  if (!Number.isFinite(frameCount) || frameCount < 1) throw new Error(`Could not determine GIF frame count: ${path}`);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`Could not determine GIF duration: ${path}`);

  return {
    frameCount,
    durationSeconds,
    frameRate: stream.r_frame_rate,
    width: Number(stream.width),
    height: Number(stream.height),
  };
}

export function contactSheetSampleFps({ requestedFps, durationSeconds, columns, rows }) {
  const cells = columns * rows;
  return Number(Math.min(requestedFps, cells / durationSeconds).toFixed(6));
}

export function reviewGif(input, {
  outDir = join(dirname(input), '.gif-review'),
  fps = DEFAULT_REVIEW_FPS,
  width = DEFAULT_REVIEW_WIDTH,
  columns = DEFAULT_REVIEW_COLUMNS,
  rows = DEFAULT_REVIEW_ROWS,
} = {}) {
  const probe = gifProbe(input);
  const sampleFps = contactSheetSampleFps({
    requestedFps: fps,
    durationSeconds: probe.durationSeconds,
    columns,
    rows,
  });
  const outputDir = resolve(outDir);
  const stem = safeStem(input);
  const contactSheet = join(outputDir, `${stem}-contact-sheet.png`);
  const metadata = join(outputDir, `${stem}-review.json`);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  chmodSync(outputDir, 0o700);
  closeSync(openPrivateFile(contactSheet, 'w'));

  run('ffmpeg', [
    '-v', 'error',
    '-i', input,
    '-vf', `fps=${sampleFps},scale=${width}:-1:flags=lanczos,tile=${columns}x${rows}`,
    '-frames:v', '1',
    '-y',
    contactSheet,
  ]);
  chmodSync(contactSheet, 0o600);

  const report = {
    input,
    frame_count: probe.frameCount,
    duration_seconds: probe.durationSeconds,
    frame_rate: probe.frameRate,
    dimensions: { width: probe.width, height: probe.height },
    review: {
      sample_fps: sampleFps,
      frame_width: width,
      columns,
      rows,
      contact_sheet: contactSheet,
      metadata,
    },
  };
  writePrivateJson(metadata, report);
  return report;
}

export function parseReviewOptions(args) {
  const value = (name) => optionValue(args, name, null);
  return {
    outDir: requiredOptionValue(args, '--out-dir', null),
    fps: parseBoundedNumber(value('--fps'), '--fps', { fallback: DEFAULT_REVIEW_FPS, min: 0.1, max: 30 }),
    width: parseBoundedNumber(value('--width'), '--width', { fallback: DEFAULT_REVIEW_WIDTH, min: 64, max: 1920, integer: true }),
    columns: parseBoundedNumber(value('--columns'), '--columns', { fallback: DEFAULT_REVIEW_COLUMNS, min: 1, max: 10, integer: true }),
    rows: parseBoundedNumber(value('--rows'), '--rows', { fallback: DEFAULT_REVIEW_ROWS, min: 1, max: 10, integer: true }),
  };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    usage();
    return args.length ? 0 : 1;
  }

  const input = gifInputPath(args[0]);
  const options = parseReviewOptions(args.slice(1));
  const report = reviewGif(input, {
    ...options,
    outDir: options.outDir || join(dirname(input), '.gif-review'),
  });

  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`GIF: ${report.input}`);
    console.log(`Frames: ${report.frame_count}`);
    console.log(`Duration: ${report.duration_seconds}s`);
    console.log(`Frame rate: ${report.frame_rate}`);
    console.log(`Contact sheet: ${report.review.contact_sheet}`);
    console.log(`Review metadata: ${report.review.metadata}`);
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
