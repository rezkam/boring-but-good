/**
 * Real local-browser integration tests for HAR and raw CDP capture.
 * The server and browser profile are isolated and no external service is used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/browser-tools.mjs', import.meta.url));

function run(command, args, { env = process.env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
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

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    request.once('error', reject);
  });
}

async function startBrowser(env) {
  const started = await runBrowserTools(['start', '--headless'], env);
  const match = started.stdout.match(/Chrome ready on :(\d+).*headless/);
  assert.ok(match, `start should report the allocated headless port, got: ${started.stdout}`);
  return Number(match[1]);
}

test('public CLI performs owner-protected CDP calls and blocks lifecycle bypasses', { timeout: 90000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'browser-tools-cdp-call-e2e-'));
  const ownerToken = randomUUID();
  const env = {
    ...process.env,
    BROWSER_TOOLS_OWNER_TOKEN: ownerToken,
    BROWSER_TOOLS_CACHE_DIR: join(workspace, 'cache'),
    BROWSER_TOOLS_CONFIG_DIR: join(workspace, 'config'),
  };
  let browserPort = null;
  try {
    browserPort = await startBrowser(env);

    const evaluated = await runBrowserTools([
      'cdp', 'call', 'Runtime.evaluate',
      '--params', JSON.stringify({
        expression: '({ title: document.title, access_token: "call-secret" })',
        returnByValue: true,
      }),
      '--port', String(browserPort),
    ], env);
    const raw = JSON.parse(evaluated.stdout);
    assert.equal(raw.result.value.title, 'New Tab');
    assert.equal(raw.result.value.access_token, 'call-secret');

    const redacted = await runBrowserTools([
      'cdp', 'call', 'Runtime.evaluate',
      '--params', JSON.stringify({
        expression: '({ access_token: "call-secret" })',
        returnByValue: true,
      }),
      '--redact',
      '--port', String(browserPort),
    ], env);
    assert.equal(JSON.parse(redacted.stdout).result.value.access_token, '<redacted>');

    const wrongOwner = await runBrowserTools(
      ['cdp', 'call', 'Runtime.evaluate', '--params', '{"expression":"1"}', '--port', String(browserPort)],
      { ...env, BROWSER_TOOLS_OWNER_TOKEN: randomUUID() },
      { allowFailure: true },
    );
    assert.equal(wrongOwner.code, 1);
    assert.match(wrongOwner.stderr, /owner-token-mismatch/);

    for (const method of ['Browser.close', 'Page.close']) {
      const blocked = await runBrowserTools(
        ['cdp', 'call', method, '--params', '{}', '--port', String(browserPort)],
        env,
        { allowFailure: true },
      );
      assert.equal(blocked.code, 1);
      assert.match(blocked.stderr, /blocked.*managed-browser lifecycle safety/i);
    }

    const status = await runBrowserTools(['status', '--port', String(browserPort), '--json'], env);
    assert.equal(JSON.parse(status.stdout).running, true);
  } finally {
    if (browserPort !== null) {
      await runBrowserTools(['stop', '--clean', '--port', String(browserPort)], env, { allowFailure: true }).catch(() => {});
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('public CLI records selected CDP events as private explicitly redacted JSONL', { timeout: 90000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'browser-tools-cdp-e2e-'));
  const output = join(workspace, 'checkout_network_events.jsonl');
  const ownerToken = randomUUID();
  const env = {
    ...process.env,
    BROWSER_TOOLS_OWNER_TOKEN: ownerToken,
    BROWSER_TOOLS_CACHE_DIR: join(workspace, 'cache'),
    BROWSER_TOOLS_CONFIG_DIR: join(workspace, 'config'),
  };
  const server = createServer(async (request, response) => {
    if (request.url === '/api/raw') {
      const body = await requestBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, received: JSON.parse(body) }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Raw CDP fixture</title>');
  });

  let browserPort = null;
  let serverOpen = false;
  let recording = false;
  try {
    const pagePort = await listen(server);
    serverOpen = true;
    browserPort = await startBrowser(env);
    await runBrowserTools(['nav', `http://127.0.0.1:${pagePort}/`, '--port', String(browserPort)], env);
    writeFileSync(output, 'old world-readable capture');
    chmodSync(output, 0o644);

    const captureStart = await runBrowserTools([
      'record-cdp', 'start',
      '--output', output,
      '--domain', 'Network',
      '--event', 'Network.*',
      '--exclude-event', 'Network.dataReceived',
      '--redact',
      '--overwrite',
      '--post-wait-ms', '300',
      '--port', String(browserPort),
    ], env);
    assert.match(captureStart.stdout, /CDP capture active/);
    recording = true;

    await runBrowserTools([
      'eval',
      `(async () => {
        const response = await fetch('/api/raw', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer raw-secret'
          },
          body: JSON.stringify({ action: 'checkout', password: 'raw-password' })
        });
        return response.json();
      })()`,
      '--port', String(browserPort),
    ], env);

    const status = await runBrowserTools(['record-cdp', 'status', '--port', String(browserPort), '--json'], env);
    assert.equal(JSON.parse(status.stdout).recording, true);
    const captureStop = await runBrowserTools(['record-cdp', 'stop', '--port', String(browserPort)], env);
    assert.equal(captureStop.stdout.trim(), output);
    recording = false;

    assert.equal(statSync(output).mode & 0o777, 0o600);
    const eventText = readFileSync(output, 'utf-8');
    assert.equal(eventText.includes(ownerToken), false);
    assert.equal(eventText.includes('raw-secret'), false);
    assert.equal(eventText.includes('raw-password'), false);
    const events = eventText.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(events.length >= 3);
    assert.equal(events.some((event) => event.method === 'Network.dataReceived'), false);
    assert.equal(events.some((event) => event.method === 'Network.responseReceived'), true);
    assert.equal(events.some((event) => event.method === 'Network.loadingFinished'), true);

    const request = events.find((event) => (
      event.method === 'Network.requestWillBeSent'
      && event.params.request.url.endsWith('/api/raw')
    ));
    assert.ok(request);
    assert.equal(request.params.request.headers.Authorization, '<redacted>');
    assert.deepEqual(JSON.parse(request.params.request.postData), {
      action: 'checkout',
      password: '<redacted>',
    });
  } finally {
    if (recording && browserPort !== null) {
      await runBrowserTools(['record-cdp', 'stop', '--port', String(browserPort)], env, { allowFailure: true }).catch(() => {});
    }
    if (browserPort !== null) {
      await runBrowserTools(['stop', '--clean', '--port', String(browserPort)], env, { allowFailure: true }).catch(() => {});
    }
    if (serverOpen) await closeServer(server).catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('public CLI captures raw API traffic by default and optionally redacts extracted recipes', { timeout: 90000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'browser-tools-har-e2e-'));
  const output = join(workspace, 'checkout_api_network.har');
  const ownerToken = randomUUID();
  const env = {
    ...process.env,
    BROWSER_TOOLS_OWNER_TOKEN: ownerToken,
    BROWSER_TOOLS_CACHE_DIR: join(workspace, 'cache'),
    BROWSER_TOOLS_CONFIG_DIR: join(workspace, 'config'),
  };
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/api/profile')) {
      response.writeHead(200, { 'content-type': 'application/json', 'x-api-key': 'response-secret' });
      response.end(JSON.stringify({ id: 7, displayName: 'Ada', access_token: 'server-secret' }));
      return;
    }
    if (request.url === '/api/update') {
      const body = await requestBody(request);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, received: JSON.parse(body), refreshToken: 'refresh-secret' }));
      return;
    }
    if (request.url === '/asset.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from('89504e470d0a1a0a', 'hex'));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Network capture fixture</title><h1>Ready</h1>');
  });

  let browserPort = null;
  let serverOpen = false;
  let recording = false;
  try {
    const pagePort = await listen(server);
    serverOpen = true;
    browserPort = await startBrowser(env);
    await runBrowserTools(['nav', `http://127.0.0.1:${pagePort}/`, '--port', String(browserPort)], env);

    const captureStart = await runBrowserTools([
      'record-har', 'start',
      '--output', output,
      '--preset', 'api',
      '--url-pattern', '**/api/**',
      '--method', 'GET,POST',
      '--capture', 'headers,bodies,timing',
      '--max-body-bytes', '65536',
      '--port', String(browserPort),
    ], env);
    assert.match(captureStart.stdout, /HAR capture active/);
    recording = true;

    await runBrowserTools([
      'eval',
      `(async () => {
        const image = new Image();
        image.src = '/asset.png';
        document.body.append(image);
        await fetch('/api/profile?user=7&access_token=query-secret', { headers: { Authorization: 'Bearer site-secret' } });
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/update');
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.onload = resolve;
          xhr.onerror = reject;
          xhr.send(JSON.stringify({ name: 'Ada', password: 'request-secret' }));
        });
        return 'complete';
      })()`,
      '--port', String(browserPort),
    ], env);

    const deniedStop = await runBrowserTools(
      ['record-har', 'stop', '--port', String(browserPort)],
      { ...env, BROWSER_TOOLS_OWNER_TOKEN: randomUUID() },
      { allowFailure: true },
    );
    assert.equal(deniedStop.code, 1);
    assert.match(deniedStop.stderr, /owned by another Browser Tools agent/);

    const captureStop = await runBrowserTools(['record-har', 'stop', '--port', String(browserPort)], env);
    assert.equal(captureStop.stdout.trim(), output);
    recording = false;

    assert.equal(statSync(output).mode & 0o777, 0o600);
    const harText = readFileSync(output, 'utf-8');
    assert.equal(harText.includes(ownerToken), false, 'HAR must never contain the Browser Tools owner token');
    for (const secret of ['site-secret', 'response-secret', 'request-secret', 'server-secret', 'refresh-secret', 'query-secret']) {
      assert.equal(harText.includes(secret), true, `raw HAR should contain debugging evidence: ${secret}`);
    }
    const har = JSON.parse(harText);
    assert.equal(har.log.version, '1.2');
    assert.equal(har.log.creator.name, '@rezkam/browser-tools');
    assert.equal(har.log.entries.length, 2);
    assert.deepEqual(new Set(har.log.entries.map((entry) => entry._resourceType)), new Set(['Fetch', 'XHR']));
    assert.equal(har.log.entries.some((entry) => entry.request.url.includes('/asset.png')), false);

    const profile = har.log.entries.find((entry) => entry.request.url.includes('/api/profile'));
    assert.ok(profile);
    assert.equal(profile.request.method, 'GET');
    assert.equal(profile.response.status, 200);
    assert.equal(profile.request.headers.find((header) => header.name.toLowerCase() === 'authorization')?.value, 'Bearer site-secret');
    assert.equal(profile.response.headers.find((header) => header.name.toLowerCase() === 'x-api-key')?.value, 'response-secret');
    assert.equal(profile.request.queryString.find((parameter) => parameter.name === 'access_token')?.value, 'query-secret');
    assert.deepEqual(JSON.parse(profile.response.content.text), {
      id: 7,
      displayName: 'Ada',
      access_token: 'server-secret',
    });

    const update = har.log.entries.find((entry) => entry.request.url.endsWith('/api/update'));
    assert.ok(update);
    assert.equal(update.request.method, 'POST');
    assert.equal(update.response.status, 201);
    assert.deepEqual(JSON.parse(update.request.postData.text), { name: 'Ada', password: 'request-secret' });
    assert.deepEqual(JSON.parse(update.response.content.text), {
      ok: true,
      received: { name: 'Ada', password: 'request-secret' },
      refreshToken: 'refresh-secret',
    });

    const recipeOutput = join(workspace, 'checkout_api_recipe.json');
    const extracted = await runBrowserTools([
      'extract-har', output,
      '--output', recipeOutput,
      '--preset', 'api',
      '--url-pattern', '**/api/**',
      '--json',
    ], env);
    const recipeReport = JSON.parse(extracted.stdout);
    assert.equal(recipeReport.output, recipeOutput);
    assert.equal(recipeReport.request_count, 2);
    assert.equal(statSync(recipeOutput).mode & 0o777, 0o600);

    const recipeText = readFileSync(recipeOutput, 'utf-8');
    assert.equal(recipeText.includes(ownerToken), false, 'recipe must never contain the Browser Tools owner token');
    for (const secret of ['site-secret', 'response-secret', 'request-secret', 'server-secret', 'refresh-secret', 'query-secret']) {
      assert.equal(recipeText.includes(secret), true, `raw recipe should contain debugging evidence: ${secret}`);
    }
    const recipe = JSON.parse(recipeText);
    assert.equal(recipe.kind, 'browser-tools-network-recipe');
    assert.equal(recipe.source_har, output);
    assert.equal(recipe.requests.length, 2);
    assert.deepEqual(recipe.requests.map((request) => request.sequence), [1, 2]);
    assert.deepEqual(new Set(recipe.requests.map((request) => request.resource_type)), new Set(['Fetch', 'XHR']));
    assert.equal(recipe.requests[0].headers.authorization, 'Bearer site-secret');
    assert.deepEqual(recipe.requests[0].query, [
      { name: 'user', value: '7' },
      { name: 'access_token', value: 'query-secret' },
    ]);
    assert.deepEqual(recipe.requests[1].body.json, { name: 'Ada', password: 'request-secret' });
    assert.deepEqual(recipe.requests[1].response.body.json, {
      ok: true,
      received: { name: 'Ada', password: 'request-secret' },
      refreshToken: 'refresh-secret',
    });

    const redactedRecipeOutput = join(workspace, 'checkout_api_redacted_recipe.json');
    await runBrowserTools([
      'extract-har', output,
      '--output', redactedRecipeOutput,
      '--preset', 'api',
      '--url-pattern', '**/api/**',
      '--redact',
    ], env);
    assert.equal(statSync(redactedRecipeOutput).mode & 0o777, 0o600);
    const redactedRecipeText = readFileSync(redactedRecipeOutput, 'utf-8');
    for (const secret of ['site-secret', 'response-secret', 'request-secret', 'server-secret', 'refresh-secret', 'query-secret']) {
      assert.equal(redactedRecipeText.includes(secret), false, `redacted recipe should not contain secret value: ${secret}`);
    }
    const redactedRecipe = JSON.parse(redactedRecipeText);
    assert.equal(redactedRecipe.requests[0].headers.authorization, '<redacted>');
    assert.equal(
      redactedRecipe.requests[0].query.find((parameter) => parameter.name === 'access_token')?.value,
      '<redacted>',
    );
    assert.deepEqual(redactedRecipe.requests[1].body.json, { name: 'Ada', password: '<redacted>' });
  } finally {
    if (recording && browserPort !== null) {
      await runBrowserTools(['record-har', 'stop', '--port', String(browserPort)], env, { allowFailure: true }).catch(() => {});
    }
    if (browserPort !== null) {
      await runBrowserTools(['stop', '--clean', '--port', String(browserPort)], env, { allowFailure: true }).catch(() => {});
    }
    if (serverOpen) await closeServer(server).catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
  }
});
