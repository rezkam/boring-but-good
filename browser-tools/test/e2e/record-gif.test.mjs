/**
 * Real local end-to-end test for GIF recording. It launches fresh headless Chrome,
 * serves a local interaction page, drives only the public CLI, and validates the
 * resulting media with ffprobe and ffmpeg. It never uses a copied profile, account,
 * external website, or external server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/browser-tools.mjs', import.meta.url));
const TEST_PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>GIF recording end-to-end test</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; }
    body {
      display: grid;
      place-items: center;
      color: white;
      background: rgb(192, 57, 43);
      font: 24px system-ui, sans-serif;
      transition: background-color 700ms linear;
    }
    main { text-align: center; }
    button, input { font: inherit; margin: 8px; }
  </style>
</head>
<body>
  <main>
    <h1 id="status">Ready</h1>
    <button id="begin">Begin interaction</button>
    <input id="name" aria-label="Name" hidden>
    <button id="finish" hidden>Finish</button>
  </main>
  <script>
    document.querySelector('#begin').addEventListener('click', () => {
      document.querySelector('#status').textContent = 'In progress';
      document.querySelector('#begin').hidden = true;
      document.querySelector('#name').hidden = false;
      document.querySelector('#finish').hidden = false;
      document.body.style.backgroundColor = 'rgb(211, 137, 32)';
    });
    document.querySelector('#finish').addEventListener('click', () => {
      document.querySelector('#status').textContent = 'Complete: ' + document.querySelector('#name').value;
      document.querySelector('#name').hidden = true;
      document.querySelector('#finish').hidden = true;
      document.body.style.backgroundColor = 'rgb(23, 143, 85)';
    });
  </script>
</body>
</html>`;

function run(command, args, { env = process.env, binary = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const result = {
        code,
        signal,
        stdout: binary ? stdoutBuffer : stdoutBuffer.toString('utf-8'),
        stderr: stderrBuffer.toString('utf-8'),
      };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(
        `${command} ${args.join(' ')} failed with ${signal || `exit ${code}`}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ));
    });
  });
}

function runBrowserTools(args, env, options = {}) {
  return run(process.execPath, [BIN, ...args], { env, ...options });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function gifProbe(path) {
  const result = await run('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration',
    '-of', 'json',
    path,
  ]);
  return JSON.parse(result.stdout);
}

async function gifPixelFrames(path) {
  const result = await run('ffmpeg', [
    '-v', 'error',
    '-i', path,
    '-vf', 'format=rgb24,crop=1:1:10:10',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ], { binary: true });

  assert.equal(result.stdout.length % 3, 0, 'decoded RGB pixel stream should contain complete pixels');
  const frames = [];
  for (let offset = 0; offset < result.stdout.length; offset += 3) {
    frames.push([...result.stdout.subarray(offset, offset + 3)]);
  }
  return frames;
}

function isRed([red, green, blue]) {
  return red > green + 60 && red > blue + 60;
}

function isGreen([red, green, blue]) {
  return green > red + 50 && green > blue + 30;
}

test('public CLI records a complete real-browser interaction as an inspectable GIF', { timeout: 90000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'browser-tools-gif-e2e-'));
  const output = join(workspace, 'profile_settings_update.gif');
  const ownerToken = randomUUID();
  let browserPort = null;
  const env = {
    ...process.env,
    BROWSER_TOOLS_OWNER_TOKEN: ownerToken,
    BROWSER_TOOLS_CACHE_DIR: join(workspace, 'cache'),
    BROWSER_TOOLS_CONFIG_DIR: join(workspace, 'config'),
    BROWSER_TOOLS_ARTIFACT_DIR: join(workspace, 'artifacts'),
  };
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(TEST_PAGE);
  });

  let serverOpen = false;
  let browserStarted = false;
  let recorderStarted = false;
  try {
    const pagePort = await listen(server);
    serverOpen = true;

    const start = await runBrowserTools(['start', '--headless'], env);
    const reportedPort = start.stdout.match(/Chrome ready on :(\d+).*headless/);
    assert.ok(reportedPort, `start should report the allocated headless browser port, got: ${start.stdout}`);
    browserPort = Number(reportedPort[1]);
    browserStarted = true;

    await runBrowserTools(['nav', `http://127.0.0.1:${pagePort}/interaction`, '--port', String(browserPort)], env);
    const initialState = await runBrowserTools([
      'eval',
      '({ title: document.title, status: document.querySelector("#status").textContent, background: getComputedStyle(document.body).backgroundColor })',
      '--port', String(browserPort),
    ], env);
    assert.match(initialState.stdout, /status: Ready/);
    assert.match(initialState.stdout, /background: rgb\(192, 57, 43\)/);

    const recordStart = await runBrowserTools([
      'record-gif', 'start',
      '--output', output,
      '--port', String(browserPort),
      '--fps', '10',
      '--pre-roll-ms', '500',
      '--post-roll-ms', '500',
      '--max-duration', '30',
    ], env);
    assert.match(recordStart.stdout, /Captured 500ms of pre-action frames/);
    assert.match(recordStart.stdout, /profile_settings_update\.gif/);
    recorderStarted = true;

    await runBrowserTools([
      'eval',
      '(() => { document.querySelector("#begin").click(); return "begun"; })()',
      '--port', String(browserPort),
    ], env);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await runBrowserTools([
      'eval',
      '(() => { document.querySelector("#name").value = "Sample User"; document.querySelector("#finish").click(); return document.querySelector("#status").textContent; })()',
      '--port', String(browserPort),
    ], env);
    await new Promise((resolve) => setTimeout(resolve, 900));

    const status = await runBrowserTools(['record-gif', 'status', '--port', String(browserPort), '--json'], env);
    const statusReport = JSON.parse(status.stdout);
    assert.equal(statusReport.recording, true);
    assert.equal(statusReport.status, 'recording');
    assert.equal(statusReport.output, output);

    const deniedStop = await runBrowserTools(
      ['record-gif', 'stop', '--port', String(browserPort)],
      { ...env, BROWSER_TOOLS_OWNER_TOKEN: randomUUID() },
      { allowFailure: true },
    );
    assert.equal(deniedStop.code, 1);
    assert.match(deniedStop.stderr, /owned by another Browser Tools agent/);
    const statusAfterDeniedStop = await runBrowserTools(['record-gif', 'status', '--port', String(browserPort), '--json'], env);
    assert.equal(JSON.parse(statusAfterDeniedStop.stdout).recording, true);

    const recordStop = await runBrowserTools(['record-gif', 'stop', '--port', String(browserPort)], env);
    assert.equal(recordStop.stdout.trim(), output);
    assert.match(recordStop.stderr, /Capturing post-action frames/);
    recorderStarted = false;

    const gif = readFileSync(output);
    assert.equal(gif.subarray(0, 6).toString('ascii'), 'GIF89a');
    assert.ok(gif.length > 1000, `expected a non-trivial GIF, got ${gif.length} bytes`);

    const probe = await gifProbe(output);
    assert.equal(probe.streams.length, 1);
    assert.equal(probe.streams[0].codec_name, 'gif');
    assert.ok(Number(probe.streams[0].width) > 100);
    assert.ok(Number(probe.streams[0].height) > 100);
    assert.ok(Number(probe.streams[0].nb_read_frames) >= 12, `expected at least 12 encoded frames, got ${probe.streams[0].nb_read_frames}`);
    assert.ok(Number(probe.format.duration) >= 1.5, `expected pre-action, interaction, and post-action duration, got ${probe.format.duration}s`);

    const pixels = await gifPixelFrames(output);
    assert.ok(pixels.length >= 12, `expected at least 12 decoded frames, got ${pixels.length}`);
    assert.ok(isRed(pixels[0]), `first frame should preserve the red pre-action state, got rgb(${pixels[0].join(', ')})`);
    assert.ok(isGreen(pixels.at(-1)), `last frame should preserve the green post-action state, got rgb(${pixels.at(-1).join(', ')})`);
    assert.ok(new Set(pixels.map((pixel) => pixel.join(','))).size >= 3, 'GIF should contain intermediate visual states, not only the first and last frames');

    const finalState = await runBrowserTools([
      'eval',
      '({ status: document.querySelector("#status").textContent, background: getComputedStyle(document.body).backgroundColor })',
      '--port', String(browserPort),
    ], env);
    assert.match(finalState.stdout, /status: Complete: Sample User/);
    assert.match(finalState.stdout, /background: rgb\(23, 143, 85\)/);
  } finally {
    if (recorderStarted && browserPort !== null) {
      await runBrowserTools(['record-gif', 'stop', '--port', String(browserPort)], env, { allowFailure: true }).catch(() => {});
    }
    if (browserStarted && browserPort !== null) {
      await runBrowserTools(['stop', '--clean', '--port', String(browserPort)], env, { allowFailure: true }).catch(() => {});
    }
    if (serverOpen) await closeServer(server).catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
  }
});
