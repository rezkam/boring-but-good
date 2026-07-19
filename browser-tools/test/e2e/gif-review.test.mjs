/**
 * Real ffmpeg and ffprobe integration test for the public GIF review command.
 * It generates an animated fixture, runs the packaged CLI, and verifies both
 * machine-readable metadata and the rendered contact sheet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/browser-tools.mjs', import.meta.url));

function run(command, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrText = Buffer.concat(stderr).toString('utf-8');
      if (code === 0) {
        resolve({ stdout: binary ? stdoutBuffer : stdoutBuffer.toString('utf-8'), stderr: stderrText });
        return;
      }
      reject(new Error(
        `${command} ${args.join(' ')} failed with ${signal || `exit ${code}`}\nstdout:\n${stdoutBuffer.toString('utf-8')}\nstderr:\n${stderrText}`,
      ));
    });
  });
}

test('public CLI probes a real GIF and creates a review contact sheet', { timeout: 30000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'browser-tools-gif-review-e2e-'));
  const input = join(workspace, 'login_process.gif');
  const outputDir = join(workspace, '.gif-review');
  try {
    await run('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=5:d=1',
      '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=5:d=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
      '-loop', '0',
      '-y', input,
    ]);

    const reviewed = await run(process.execPath, [
      BIN,
      'review-gif', input,
      '--out-dir', outputDir,
      '--fps', '2',
      '--width', '160',
      '--columns', '2',
      '--rows', '2',
      '--json',
    ]);
    const report = JSON.parse(reviewed.stdout);

    assert.equal(report.input, input);
    assert.equal(report.frame_count, 10);
    assert.equal(report.duration_seconds, 2);
    assert.equal(report.frame_rate, '5/1');
    assert.deepEqual(report.dimensions, { width: 320, height: 180 });
    assert.equal(report.review.sample_fps, 2);
    assert.equal(report.review.columns, 2);
    assert.equal(report.review.rows, 2);
    assert.match(report.review.contact_sheet, /login_process-contact-sheet\.png$/);
    assert.match(report.review.metadata, /login_process-review\.json$/);
    assert.equal(existsSync(report.review.contact_sheet), true);
    assert.equal(existsSync(report.review.metadata), true);

    const metadata = JSON.parse(readFileSync(report.review.metadata, 'utf-8'));
    assert.deepEqual(metadata, report);
    const png = readFileSync(report.review.contact_sheet);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

    const sheetProbe = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      report.review.contact_sheet,
    ]);
    const sheetStream = JSON.parse(sheetProbe.stdout).streams[0];
    assert.deepEqual(sheetStream, { width: 320, height: 180 });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
