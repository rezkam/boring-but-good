import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/browser-tools.mjs', import.meta.url));

function runBrowserTools(args, env, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
        `browser-tools ${args.join(' ')} failed with ${signal || `exit ${code}`}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ));
    });
  });
}

test('public headless app launch excludes Chrome from macOS Dock recents', { timeout: 30000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'browser-tools-headless-dock-e2e-'));
  const appDir = join(workspace, 'Fake Chrome.app');
  const chromeBin = join(appDir, 'Contents', 'MacOS', 'Fake Chrome');
  const binDir = join(workspace, 'bin');
  const osascriptBin = join(binDir, 'osascript');
  const launcherArgsFile = join(workspace, 'launcher-args');
  const port = 65423;
  mkdirSync(join(appDir, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(binDir);

  writeFileSync(chromeBin, `#!/usr/bin/env node
import { createServer } from 'node:http';
if (process.argv.includes('--version')) {
  console.log('Google Chrome 151.0.0.0');
  process.exit(0);
}
const portArg = process.argv.find((arg) => arg.startsWith('--remote-debugging-port='));
const port = Number.parseInt(portArg?.split('=')[1] || '', 10);
const server = createServer((request, response) => {
  if (request.url === '/json/version') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ webSocketDebuggerUrl: \`ws://127.0.0.1:\${port}/devtools/browser/test\` }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(port, '127.0.0.1');
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`, { mode: 0o755 });

  writeFileSync(osascriptBin, `#!/bin/sh
printf '%s\\n' "$@" > "$BROWSER_TOOLS_TEST_LAUNCHER_ARGS_FILE"
shift 4
"$BROWSER_TOOLS_CHROME_BIN" "$@" >/dev/null 2>&1 &
printf '%s\\n' "$!"
`, { mode: 0o755 });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    BROWSER_TOOLS_OWNER_TOKEN: randomUUID(),
    BROWSER_TOOLS_CACHE_DIR: join(workspace, 'cache'),
    BROWSER_TOOLS_CONFIG_DIR: join(workspace, 'config'),
    BROWSER_TOOLS_CHROME_BIN: chromeBin,
    BROWSER_TOOLS_TEST_LAUNCHER_ARGS_FILE: launcherArgsFile,
  };
  let started = false;
  try {
    const result = await runBrowserTools(['start', '--headless', '--port', String(port)], env);
    assert.match(result.stdout, /Chrome ready.*headless/);
    started = true;
    assert.ok(existsSync(launcherArgsFile), 'headless macOS app launch must use the native workspace launcher');
    const launcherArgs = readFileSync(launcherArgsFile, 'utf-8').trim().split('\n');
    assert.deepEqual(launcherArgs.slice(0, 2), ['-l', 'JavaScript']);
    assert.equal(basename(launcherArgs[2]), 'mac-headless-launch.jxa');
    assert.equal(launcherArgs[3], appDir);
    assert.match(
      readFileSync(launcherArgs[2], 'utf-8'),
      /NSWorkspaceLaunchWithoutAddingToRecents/,
      'the native launcher must explicitly opt out of Dock recents',
    );
  } finally {
    if (started) {
      await runBrowserTools(['stop', '--clean', '--port', String(port)], env, { allowFailure: true });
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});
