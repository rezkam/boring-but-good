// Guardrails against the managed-Chrome leak: a fan-out of bare `start` calls once left 86 headless
// browsers (853 processes, ~70 GB) alive for days, with their lifecycle files deleted underneath them
// so `stop.mjs` could no longer see them. These tests pin the invariants that make that unreachable:
// process scanning is the source of truth (not lifecycle files), a hard cap bounds concurrency,
// orphans are reapable, and stop never orphans a live browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MAX_MANAGED_BROWSERS,
  assertManagedBrowserCapacity,
  buildBrowserToolsConfig,
  forcedKillStatus,
  isBrowserToolsUserDataDir,
  managedBrowserIdentityMatches,
  findReusableManagedBrowser,
  managedBrowserCapacity,
  managedBrowserReuseDecision,
  managedBrowserStartupWarnings,
  startChrome,
  maxManagedBrowsers,
  orphanedManagedBrowsers,
  ownerTokenHash,
  parseManagedChromeProcesses,
  parseProcessAgeMs,
  portLockDirForPort,
  acquireLaunchLock,
  occupiedManagedSlotPorts,
  pruneChromeClones,
  reapExitCode,
  reapOrphanedChromes,
  staleManagedBrowsers,
  stopChrome,
} from '../scripts/browser-control.mjs';

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CACHE_DIR = '/opt/fake-home/.cache/pi-browser-tools';

function browserLine(pid, etime, port, { dir = `chrome-data-${port}`, token = 'tok-1' } = {}) {
  return `${pid} ${etime} ${CHROME_BIN} --remote-debugging-port=${port} --user-data-dir=${CACHE_DIR}/${dir} --pi-browser-tools-managed=${token}`;
}

function helperLine(pid, etime, port, type = 'renderer') {
  return `${pid} ${etime} ${CHROME_BIN} Helper --type=${type} --remote-debugging-port=${port} --user-data-dir=${CACHE_DIR}/chrome-data-${port} --pi-browser-tools-managed=tok-1`;
}

function withTempCache(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'bt-guardrails-'));
  const previous = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = tmp;
  try {
    return fn(tmp);
  } finally {
    if (previous === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('parseProcessAgeMs understands every ps etime format', () => {
  assert.equal(parseProcessAgeMs('05:10'), ((5 * 60) + 10) * 1000);
  assert.equal(parseProcessAgeMs('01:05:10'), (((1 * 60) + 5) * 60 + 10) * 1000);
  assert.equal(parseProcessAgeMs('02-10:32:50'), ((((2 * 24) + 10) * 60 + 32) * 60 + 50) * 1000);
  assert.equal(parseProcessAgeMs('garbage'), null);
  assert.equal(parseProcessAgeMs(''), null);
});

test('parseManagedChromeProcesses counts browsers, never helper processes', () => {
  // The leak looked like 853 processes because helpers inherit --user-data-dir and the managed
  // token. Counting them would make the cap fire ~10x early and misreport the real browser count.
  const psOutput = [
    browserLine(100, '01:00', 9222),
    helperLine(101, '01:00', 9222, 'renderer'),
    helperLine(102, '01:00', 9222, 'gpu-process'),
    helperLine(103, '01:00', 9222, 'utility'),
    browserLine(200, '02-10:32:50', 9223),
    helperLine(201, '02-10:32:50', 9223),
  ].join('\n');

  const found = parseManagedChromeProcesses(psOutput, { cacheDir: CACHE_DIR, chromeBin: CHROME_BIN });
  assert.deepEqual(found.map((p) => p.pid), [100, 200]);
  assert.deepEqual(found.map((p) => p.port), [9222, 9223]);
  assert.equal(found[0].userDataDir, `${CACHE_DIR}/chrome-data-9222`);
  assert.equal(found[1].ageMs, ((((2 * 24) + 10) * 60 + 32) * 60 + 50) * 1000);
});

test('parseManagedChromeProcesses ignores the real Chrome and any browser outside the cache dir', () => {
  const psOutput = [
    // the user's own Chrome: no managed token, profile under Application Support
    `500 10-00:00:00 ${CHROME_BIN} --user-data-dir=/opt/fake-home/Library/Application Support/Google/Chrome`,
    // a managed-looking token but a user-data-dir outside our cache dir: not ours, never kill it
    `501 01:00 ${CHROME_BIN} --remote-debugging-port=9222 --user-data-dir=/somewhere/else --pi-browser-tools-managed=tok`,
    // no remote-debugging-port: not a managed browser we can address
    `502 01:00 ${CHROME_BIN} --user-data-dir=${CACHE_DIR}/chrome-data-9222 --pi-browser-tools-managed=tok`,
    browserLine(503, '01:00', 9224, { dir: 'chrome-fresh-9224' }),
  ].join('\n');

  const found = parseManagedChromeProcesses(psOutput, { cacheDir: CACHE_DIR, chromeBin: CHROME_BIN });
  assert.deepEqual(found.map((p) => p.pid), [503], 'only the managed fresh-clone browser qualifies');
});

test('parseManagedChromeProcesses keeps browsers launched by a previous binary override', () => {
  const previousBin = '/opt/browser-v1';
  const currentBin = '/opt/browser-v2';
  const line =
    `503 01:00 ${previousBin} --remote-debugging-port=9224 ` +
    `--user-data-dir=${CACHE_DIR}/chrome-fresh-9224 --pi-browser-tools-managed=tok`;

  const found = parseManagedChromeProcesses(line, { cacheDir: CACHE_DIR, chromeBin: currentBin });
  assert.deepEqual(found.map((entry) => entry.pid), [503], 'managed identity must survive a binary override change');
});

test('the managed browser cap defaults to a small number and is configurable', () => {
  assert.equal(DEFAULT_MAX_MANAGED_BROWSERS, 5);

  const previous = process.env.BROWSER_TOOLS_MAX_BROWSERS;
  try {
    delete process.env.BROWSER_TOOLS_MAX_BROWSERS;
    assert.equal(maxManagedBrowsers(), 5);
    process.env.BROWSER_TOOLS_MAX_BROWSERS = '3';
    assert.equal(maxManagedBrowsers(), 3);
    process.env.BROWSER_TOOLS_MAX_BROWSERS = 'not-a-number';
    assert.equal(maxManagedBrowsers(), 5, 'an unparseable override falls back to the safe default');
    process.env.BROWSER_TOOLS_MAX_BROWSERS = '0';
    assert.equal(maxManagedBrowsers(), 5, 'a non-positive override falls back to the safe default');
  } finally {
    if (previous === undefined) delete process.env.BROWSER_TOOLS_MAX_BROWSERS;
    else process.env.BROWSER_TOOLS_MAX_BROWSERS = previous;
  }
});

test('managedBrowserCapacity reports remaining slots, warns near the cap, and blocks at the cap', () => {
  const at = (count) => managedBrowserCapacity({ processes: new Array(count).fill({}), max: 5 });

  assert.deepEqual(
    { ...at(0), processes: undefined },
    { count: 0, max: 5, remaining: 5, atCap: false, approaching: false, processes: undefined },
  );
  assert.equal(at(3).approaching, false, 'three of five is still comfortable');
  assert.equal(at(4).approaching, true, 'the last free slot must warn');
  assert.equal(at(4).atCap, false);
  assert.equal(at(5).atCap, true);
  assert.equal(at(5).remaining, 0);
  // A leak that already blew past the cap must report zero remaining, never a negative.
  assert.equal(at(86).atCap, true);
  assert.equal(at(86).remaining, 0);
});

test('staleManagedBrowsers finds long-lived sessions so start can warn about them', () => {
  const processes = [
    { pid: 1, port: 9222, ageMs: 60 * 1000 },
    { pid: 2, port: 9223, ageMs: 3 * 60 * 60 * 1000 },
    { pid: 3, port: 9224, ageMs: 5 * 24 * 60 * 60 * 1000 },
    { pid: 4, port: 9225, ageMs: null },
  ];
  const stale = staleManagedBrowsers(processes, { maxAgeMs: 2 * 60 * 60 * 1000 });
  assert.deepEqual(stale.map((p) => p.pid), [2, 3]);
  assert.deepEqual(staleManagedBrowsers([], { maxAgeMs: 1000 }), []);
});

test('orphanedManagedBrowsers finds running browsers whose lifecycle files no longer describe them', () => {
  // This is the exact incident shape: 86 live browsers, one surviving state file, so stop.mjs
  // reported "No managed debug Chrome instance found" for every one of them.
  withTempCache((tmp) => {
    const trackedDir = join(tmp, 'chrome-data-9222');
    const trackedToken = 'tok-9222';
    writeFileSync(join(tmp, 'chrome-9222.pid'), '100');
    writeFileSync(join(tmp, 'chrome-9222.json'), JSON.stringify({
      managedBy: 'browser-tools',
      pid: 100,
      port: 9222,
      userDataDir: trackedDir,
      managedToken: trackedToken,
      args: [
        '--remote-debugging-port=9222',
        `--user-data-dir=${trackedDir}`,
        `--pi-browser-tools-managed=${trackedToken}`,
      ],
    }));
    // :9223 is tracked but the state file points at a different pid (recycled/rewritten state)
    writeFileSync(join(tmp, 'chrome-9223.pid'), '999');
    writeFileSync(join(tmp, 'chrome-9223.json'), JSON.stringify({ managedBy: 'browser-tools', pid: 999, port: 9223 }));

    const processes = [
      { pid: 100, port: 9222, ageMs: 1000, userDataDir: trackedDir, managedToken: trackedToken },
      { pid: 200, port: 9223, ageMs: 1000 },
      { pid: 300, port: 9224, ageMs: 1000 },
    ];
    const orphans = orphanedManagedBrowsers(processes);
    assert.deepEqual(
      orphans.map((p) => p.pid),
      [200, 300],
      'a pid mismatch and a missing state file are both orphans; the correctly tracked one is not',
    );
  });
});

test('stopChrome never deletes lifecycle files for a browser that is still running', () => {
  // The orphan-maker: stop used to rm the pid/state files on any safety mismatch, including while
  // the process was alive. That made the browser permanently unaddressable and unkillable by stop.
  withTempCache((tmp) => {
    const pid = process.pid; // a process that is definitely alive but is not managed Chrome
    writeFileSync(join(tmp, 'chrome-9333.pid'), String(pid));
    writeFileSync(join(tmp, 'chrome-9333.json'), JSON.stringify({
      managedBy: 'browser-tools',
      pid,
      port: 9333,
      managedToken: 'tok',
      ownerTokenHash: ownerTokenHash('owner-tok'),
      userDataDir: join(tmp, 'chrome-data-9333'),
      args: [],
    }));

    // Ownership passes, so stop reaches the command-safety check and fails it: the classic path that
    // used to delete both lifecycle files out from under a live process.
    const result = stopChrome({ port: 9333, ownerToken: 'owner-tok' });
    assert.equal(result.status, 'not-managed');
    assert.ok(
      existsSync(join(tmp, 'chrome-9333.pid')) && existsSync(join(tmp, 'chrome-9333.json')),
      'lifecycle files must survive so the live process stays addressable',
    );
    assert.match(String(result.hint || ''), /reap/, 'stop should point at the reaper for this case');
  });
});

test('stopChrome still clears lifecycle files when the process is genuinely gone', () => {
  withTempCache((tmp) => {
    // A pid that cannot be running: state is stale litter and must be reclaimed.
    writeFileSync(join(tmp, 'chrome-9334.pid'), '999999');
    writeFileSync(join(tmp, 'chrome-9334.json'), JSON.stringify({
      managedBy: 'browser-tools',
      pid: 999999,
      port: 9334,
      managedToken: 'tok',
      userDataDir: join(tmp, 'chrome-data-9334'),
      args: [],
    }));
    mkdirSync(join(tmp, 'chrome-data-9334'));

    const result = stopChrome({ port: 9334, clean: true });
    assert.equal(result.status, 'already-gone');
    assert.ok(!existsSync(join(tmp, 'chrome-9334.pid')));
    assert.ok(!existsSync(join(tmp, 'chrome-9334.json')));
    assert.ok(!existsSync(join(tmp, 'chrome-data-9334')), '--clean must reclaim the clone dir');
  });
});

test('stopChrome leaves a half-written lifecycle pair alone while a managed browser holds the port', () => {
  withTempCache((tmp) => {
    // Only the pid file survived. Deleting it used to be safe-looking but strands the live browser.
    writeFileSync(join(tmp, 'chrome-9335.pid'), String(process.pid));
    const result = stopChrome({ port: 9335 });
    assert.equal(result.status, 'not-managed');
    assert.ok(existsSync(join(tmp, 'chrome-9335.pid')), 'a live pid must not be forgotten');
  });
});

test('assertManagedBrowserCapacity blocks a new browser at the cap with a self-explanatory error', () => {
  const under = new Array(4).fill({ pid: 1, port: 9222, ageMs: 1000 });
  assert.doesNotThrow(() => assertManagedBrowserCapacity({ processes: under, max: 5 }));

  // Four stale, one fresh: the message must let a reader see at a glance which slots are junk.
  const at = [
    { pid: 100, port: 9222, ageMs: 58 * 60 * 60 * 1000 },
    { pid: 101, port: 9223, ageMs: 30 * 60 * 60 * 1000 },
    { pid: 102, port: 9224, ageMs: 6 * 60 * 60 * 1000 },
    { pid: 103, port: 9225, ageMs: 3 * 60 * 60 * 1000 },
    { pid: 104, port: 9226, ageMs: 5 * 60 * 1000 },
  ];
  assert.throws(
    () => assertManagedBrowserCapacity({ processes: at, max: 5 }),
    (error) => {
      const m = error.message;
      // What happened, stated as a refusal rather than a bare failure.
      assert.match(m, /Refusing to start another managed Chrome/, 'must say what was refused');
      assert.match(m, /5 of 5/, 'must state the count against the cap');
      // Why the limit exists, so the reader knows this is deliberate and not a malfunction.
      assert.match(m, /memory|MB|swap/i, 'must explain why the limit exists');
      // The evidence: every occupied slot with enough detail to act on it.
      for (const entry of at) {
        assert.ok(m.includes(`:${entry.port}`), `must list port ${entry.port}`);
        assert.ok(m.includes(`PID ${entry.pid}`), `must list PID ${entry.pid}`);
      }
      assert.match(m, /58(\.0)?h/, 'must show how long each browser has been up');
      // The diagnosis: which of them are probably junk.
      assert.match(m, /4 .*(leftover|over 2h)/i, 'must call out how many look like leftovers');
      // The recovery, including the reuse path that avoids needing a slot at all.
      assert.match(m, /--reap/, 'must name the reaper');
      assert.match(m, /--prune/, 'must name prune');
      assert.match(m, /BROWSER_TOOLS_OWNER_TOKEN/, 'must show how to reuse a browser you own');
      assert.match(m, /BROWSER_TOOLS_MAX_BROWSERS/, 'must name the override');
      return true;
    },
  );
});

test('the cap error stays readable when nothing is stale and when the list is long', () => {
  const fresh = [9222, 9223].map((port, i) => ({ pid: 200 + i, port, ageMs: 60 * 1000 }));
  const freshError = (() => { try { assertManagedBrowserCapacity({ processes: fresh, max: 2 }); } catch (e) { return e.message; } })();
  assert.ok(freshError, 'must still throw with no stale browsers');
  assert.doesNotMatch(freshError, /leftover/i, 'must not invent leftovers when every browser is recent');

  const many = Array.from({ length: 12 }, (_, i) => ({ pid: 300 + i, port: 9300 + i, ageMs: 60 * 1000 }));
  const manyError = (() => { try { assertManagedBrowserCapacity({ processes: many, max: 5 }); } catch (e) { return e.message; } })();
  const listed = (manyError.match(/PID \d+/g) || []).length;
  assert.ok(listed <= 10, `must cap the listing, got ${listed} entries`);
  assert.match(manyError, /\d+ more/, 'must say how many were not listed rather than silently truncating');
});

test('the cap error is cleanly formatted in both the stale and all-fresh cases', () => {
  const message = (processes, max) => {
    try { assertManagedBrowserCapacity({ processes, max }); } catch (e) { return e.message; }
    throw new Error('expected the cap to throw');
  };
  const fresh = message([{ pid: 1, port: 9222, ageMs: 60 * 1000 }], 1);
  const stale = message([{ pid: 1, port: 9222, ageMs: 9 * 60 * 60 * 1000 }], 1);

  for (const [label, m] of [['fresh', fresh], ['stale', stale]]) {
    assert.doesNotMatch(m, /\n\s*\n\s*\n/, `${label} message must not contain a double blank line`);
    assert.doesNotMatch(m, /[ \t]+$/m, `${label} message must not have trailing whitespace`);
  }
  assert.match(fresh, /up 1m/, 'sub-hour ages read as minutes, not 0.0h');
  assert.match(stale, /up 9\.0h/);
  assert.match(stale, /likely a leftover/, 'a stale slot must be marked inline');
  assert.doesNotMatch(fresh, /likely a leftover/);
});

test('managedBrowserStartupWarnings warns on the last slot and on leftover old sessions', () => {
  const fresh = [{ pid: 1, port: 9222, ageMs: 60 * 1000 }];
  assert.deepEqual(managedBrowserStartupWarnings({ processes: fresh, max: 5 }), []);

  const nearCap = [9222, 9223, 9224, 9225].map((port, i) => ({ pid: 100 + i, port, ageMs: 60 * 1000 }));
  const capWarnings = managedBrowserStartupWarnings({ processes: nearCap, max: 5 });
  assert.equal(capWarnings.length, 1);
  assert.match(capWarnings[0], /4 of 5/);
  assert.match(capWarnings[0], /1 slot/, 'must say how many slots remain');

  const old = [
    { pid: 1, port: 9222, ageMs: 5 * 24 * 60 * 60 * 1000 },
    { pid: 2, port: 9223, ageMs: 3 * 60 * 60 * 1000 },
  ];
  const staleWarnings = managedBrowserStartupWarnings({ processes: old, max: 5 });
  assert.equal(staleWarnings.length, 1);
  assert.match(staleWarnings[0], /2 managed browser/, 'must count the leftovers');
  assert.match(staleWarnings[0], /9222|9223/, 'must name the ports to inspect');
  assert.match(staleWarnings[0], /stop\.mjs/, 'must name the cleanup command');
  assert.match(staleWarnings[0], /--port <n> --owner-token/, 'tracked browsers need the normal owner-protected stop path');
  assert.match(staleWarnings[0], /untracked/, 'reap and prune must be described as orphan-only recovery');
});

test('managedBrowserReuseDecision is the single gate both explicit and auto-allocated starts share', () => {
  const okSafety = { ok: true };
  const state = {
    managedBy: 'browser-tools',
    ownerTokenHash: ownerTokenHash('tok'),
    includeGoogle: false,
  };

  assert.equal(
    managedBrowserReuseDecision({ safety: okSafety, state, ownerToken: 'tok', includeGoogle: false }).ok,
    true,
    'the owner reusing its own non-Google browser is the case that stops the leak',
  );
  assert.equal(
    managedBrowserReuseDecision({ safety: okSafety, state, ownerToken: null, includeGoogle: false }).reason,
    'missing-owner-token',
    'a tokenless caller must not adopt another agent browser',
  );
  assert.equal(
    managedBrowserReuseDecision({ safety: okSafety, state, ownerToken: 'wrong', includeGoogle: false }).reason,
    'owner-token-mismatch',
  );
  assert.equal(
    managedBrowserReuseDecision({ safety: okSafety, state, ownerToken: 'tok', includeGoogle: true }).reason,
    'google-mode-mismatch',
    'never adopt across Google modes: it risks logging the source profile out',
  );
  assert.equal(
    managedBrowserReuseDecision({ safety: { ok: false, reason: 'not-chrome-process' }, state, ownerToken: 'tok', includeGoogle: false }).reason,
    'not-chrome-process',
  );
});

test('startChrome refuses to launch past the cap instead of allocating another port', async (t) => {
  // Integration guard: with the process table already at the cap, start must fail before it touches
  // Chrome at all. A stub `ps` earlier on PATH stands in for the leaked browsers.
  const tmp = mkdtempSync(join(tmpdir(), 'bt-cap-'));
  const binDir = join(tmp, 'bin');
  mkdirSync(binDir);
  const cacheDir = join(tmp, 'cache');
  mkdirSync(cacheDir);

  const chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const ports = [9222, 9223, 9224, 9225, 9226];
  // Pids far above the system maximum so nothing real is ever signalled by the reaper.
  const pidFor = (port) => 900000 + (port - 9222);
  const lines = ports
    .map((port) => `${pidFor(port)} 02-10:00:00 ${chromeBin} --remote-debugging-port=${port} --user-data-dir=${cacheDir}/chrome-data-${port} --pi-browser-tools-managed=tok`)
    .join('\n');
  writeFileSync(join(binDir, 'ps'), `#!/bin/sh\ncat <<'PSEOF'\n${lines}\nPSEOF\n`, { mode: 0o755 });
  // Tracked, so the pre-launch reap leaves them alone and they genuinely occupy all five slots.
  for (const port of ports) {
    const userDataDir = join(cacheDir, `chrome-data-${port}`);
    writeFileSync(join(cacheDir, `chrome-${port}.pid`), String(pidFor(port)));
    writeFileSync(join(cacheDir, `chrome-${port}.json`), JSON.stringify({
      managedBy: 'browser-tools',
      pid: pidFor(port),
      port,
      userDataDir,
      managedToken: 'tok',
      args: [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--pi-browser-tools-managed=tok',
      ],
    }));
  }

  const env = { PATH: process.env.PATH, BROWSER_TOOLS_CACHE_DIR: process.env.BROWSER_TOOLS_CACHE_DIR };
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.BROWSER_TOOLS_CACHE_DIR = cacheDir;
  t.after(() => {
    process.env.PATH = env.PATH;
    // If this test ever regresses and a real Chrome does launch, kill it here. An earlier version of
    // this test leaked a 274 MB browser that outlived the run, which is the very failure under test.
    spawnSync('pkill', ['-f', `user-data-dir=${cacheDir}`]);
    if (env.BROWSER_TOOLS_CACHE_DIR === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = env.BROWSER_TOOLS_CACHE_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  await assert.rejects(
    () => startChrome({ autoAllocatePort: true }),
    (error) => {
      assert.match(error.message, /5 of 5/);
      return true;
    },
  );
  // No new clone dir: the refusal must not leave a synced profile behind.
  assert.deepEqual(
    readdirSync(cacheDir).filter((n) => /^chrome-(data|fresh)-/.test(n)),
    [],
    'a refused start must not leave a profile clone behind',
  );
  // And no Chrome may actually be running. An earlier version of this test passed only because a
  // leaked browser happened to occupy :9222, masking a real hole in the cap check.
  const running = spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf-8' }).stdout || '';
  assert.ok(
    !running.includes(`--user-data-dir=${cacheDir}`),
    'a refused start must not have launched a browser',
  );
});

test('the pre-launch reap spares tracked browsers and ports held by a concurrent start', () => {
  withTempCache((tmp) => {
    const trackedDir = join(tmp, 'chrome-data-9222');
    const trackedToken = 'tok-9222';
    // tracked: state file agrees with the running pid
    writeFileSync(join(tmp, 'chrome-9222.pid'), '900001');
    writeFileSync(join(tmp, 'chrome-9222.json'), JSON.stringify({
      managedBy: 'browser-tools',
      pid: 900001,
      port: 9222,
      userDataDir: trackedDir,
      managedToken: trackedToken,
      args: [
        '--remote-debugging-port=9222',
        `--user-data-dir=${trackedDir}`,
        `--pi-browser-tools-managed=${trackedToken}`,
      ],
    }));
    // untracked but a start currently holds the port lock: its browser exists before its state file does
    mkdirSync(portLockDirForPort(9223), { recursive: true });

    const processes = [
      { pid: 900001, port: 9222, ageMs: 1000, userDataDir: trackedDir, managedToken: trackedToken },
      { pid: 900002, port: 9223, ageMs: 1000 },
      { pid: 900003, port: 9224, ageMs: 1000 },
    ];
    const orphans = orphanedManagedBrowsers(processes);
    assert.deepEqual(orphans.map((p) => p.pid), [900003], 'only the genuinely untracked, unlocked browser is reapable');

    const dry = reapOrphanedChromes({ dryRun: true, processes });
    assert.deepEqual(dry.reaped.map((p) => p.status), ['would-reap']);
    assert.deepEqual(dry.reaped.map((p) => p.pid), [900003], 'a dry run must not signal anything');
  });
});

test('a stale port lock cannot permanently exempt an orphan from reaping', () => {
  withTempCache((tmp) => {
    const lockDir = portLockDirForPort(9223);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock.json'), JSON.stringify({
      pid: 999999,
      port: 9223,
      createdAt: new Date().toISOString(),
    }));

    const orphan = {
      pid: 900002,
      port: 9223,
      ageMs: 1000,
      userDataDir: join(tmp, 'chrome-data-9223'),
      managedToken: 'tok-9223',
    };
    assert.deepEqual(
      orphanedManagedBrowsers([orphan]).map((entry) => entry.pid),
      [900002],
      'a lock whose owning start is gone must not shield the browser',
    );
    assert.equal(existsSync(lockDir), false, 'the stale lock must be reclaimed for future starts');
  });
});

test('findReusableManagedBrowser locates a browser the caller owns on any port, not just the default', () => {
  // The reuse fix is worthless if it only looks at :9222. A fanned-out session whose first start
  // landed on :9301 must find that browser again, or every later start spawns another one.
  withTempCache((tmp) => {
    const mine = ownerTokenHash('mine');
    const theirs = ownerTokenHash('theirs');
    const write = (port, hash, includeGoogle = false) => {
      writeFileSync(join(tmp, `chrome-${port}.pid`), String(900000 + port));
      writeFileSync(join(tmp, `chrome-${port}.json`), JSON.stringify({
        managedBy: 'browser-tools', pid: 900000 + port, port, ownerTokenHash: hash, includeGoogle,
      }));
    };
    write(9301, theirs);
    write(9302, mine);
    write(9303, mine, true);

    const processes = [9301, 9302, 9303].map((port) => ({ pid: 900000 + port, port, ageMs: 1000 }));

    assert.equal(
      findReusableManagedBrowser({ ownerToken: 'mine', includeGoogle: false, processes })?.port,
      9302,
      'must skip another agent browser and the Google-mode mismatch',
    );
    assert.equal(
      findReusableManagedBrowser({ ownerToken: 'mine', includeGoogle: true, processes })?.port,
      9303,
      'Google-included workflows reuse only a Google-included browser',
    );
    assert.equal(
      findReusableManagedBrowser({ ownerToken: 'nobody', includeGoogle: false, processes }),
      null,
      'an unknown token adopts nothing',
    );
    assert.equal(
      findReusableManagedBrowser({ ownerToken: null, includeGoogle: false, processes }),
      null,
      'a tokenless start never adopts a browser it cannot prove it owns',
    );
  });
});

test('the concurrency guardrails are documented where an agent will actually read them', () => {
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf-8');
  const reference = readFileSync(new URL('../references/browser-control.md', import.meta.url), 'utf-8');

  for (const flag of ['--status', '--reap', '--prune']) {
    assert.ok(skill.includes(`browser-tools stop ${flag}`), `SKILL.md must show stop ${flag}`);
    assert.ok(reference.includes(flag), `browser-control.md must document stop ${flag}`);
  }
  assert.match(reference, /## Concurrency limits/, 'the cap needs its own section, not a footnote');
  assert.match(reference, /BROWSER_TOOLS_MAX_BROWSERS/, 'the override must be discoverable');
  assert.ok(
    reference.includes(String(DEFAULT_MAX_MANAGED_BROWSERS)),
    'the documented cap must state the real default',
  );
  // The reuse rule changed; the old text promised the opposite and would mislead an agent.
  assert.ok(
    !/Starting without an explicit `--port` never reuses another listening browser/.test(reference),
    'the superseded "never reuses" ownership rule must not survive in the docs',
  );
});

test('a cache path containing spaces does not silently disable the inventory', () => {
  // Regression: --user-data-dir=(\S+) truncated at the first space, so startsWith(cacheDir) failed
  // and every managed browser vanished from the inventory. The cap then never fired, --reap found
  // nothing, and --status read 0. Silent, and in the exact direction that recreates the leak.
  const spaced = '/opt/fake home/.cache/pi-browser-tools';
  const line = (port, dir, trailing) =>
    `${100 + port} 01:00 ${CHROME_BIN} --remote-debugging-port=${port} --user-data-dir=${spaced}/${dir} --pi-browser-tools-managed=tok${trailing}`;

  // --user-data-dir in the middle, at the end, and followed by other flags
  const psOutput = [
    line(9222, 'chrome-data-9222', ''),
    `9223 01:00 ${CHROME_BIN} --user-data-dir=${spaced}/chrome-fresh-9223 --remote-debugging-port=9223 --pi-browser-tools-managed=tok --no-first-run`,
    `9224 01:00 ${CHROME_BIN} --remote-debugging-port=9224 --pi-browser-tools-managed=tok --user-data-dir=${spaced}/chrome-data-9224`,
  ].join('\n');

  const found = parseManagedChromeProcesses(psOutput, { cacheDir: spaced, chromeBin: CHROME_BIN });
  assert.equal(found.length, 3, 'every spaced-path browser must be seen');
  assert.deepEqual(found.map((f) => f.userDataDir), [
    `${spaced}/chrome-data-9222`,
    `${spaced}/chrome-fresh-9223`,
    `${spaced}/chrome-data-9224`,
  ], 'the full path must survive, including the space');
  assert.deepEqual(found.map((f) => f.port), [9222, 9223, 9224]);

  // A browser under a different spaced root must still be excluded.
  const foreign = `9225 01:00 ${CHROME_BIN} --remote-debugging-port=9225 --user-data-dir=/opt/other home/x/chrome-data-9225 --pi-browser-tools-managed=tok`;
  assert.equal(parseManagedChromeProcesses(foreign, { cacheDir: spaced, chromeBin: CHROME_BIN }).length, 0);
});

test('occupied slots include a just-launched browser that ps has not listed yet', () => {
  // The cap is only sound if a browser counts the instant its state file exists. Otherwise a second
  // start can read a stale count during the window before the new process appears in ps.
  withTempCache((tmp) => {
    const userDataDir = join(tmp, 'chrome-data-9401');
    const managedToken = 'tok-9401';
    writeFileSync(join(tmp, `chrome-9401.pid`), String(process.pid));
    writeFileSync(join(tmp, `chrome-9401.json`), JSON.stringify({
      managedBy: 'browser-tools',
      pid: process.pid,
      port: 9401,
      userDataDir,
      managedToken,
      args: [
        '--remote-debugging-port=9401',
        `--user-data-dir=${userDataDir}`,
        `--pi-browser-tools-managed=${managedToken}`,
      ],
      startedAt: new Date().toISOString(),
    }));
    // a tracked port whose pid is long dead must NOT hold a slot
    writeFileSync(join(tmp, `chrome-9402.pid`), '999999');
    writeFileSync(join(tmp, `chrome-9402.json`), JSON.stringify({
      managedBy: 'browser-tools', pid: 999999, port: 9402,
    }));

    const ports = occupiedManagedSlotPorts({ processes: [{ pid: 777, port: 9400, ageMs: 1 }] });
    assert.ok(ports.has(9400), 'a running browser holds a slot');
    assert.ok(ports.has(9401), 'a freshly written state file with a live pid holds a slot');
    assert.ok(!ports.has(9402), 'a dead tracked port must not hold a slot');
  });
});

test('a stale state whose PID was recycled by another process does not reserve a slot', () => {
  withTempCache((tmp) => {
    const port = 9403;
    const userDataDir = join(tmp, `chrome-data-${port}`);
    const managedToken = `tok-${port}`;
    writeFileSync(join(tmp, `chrome-${port}.pid`), String(process.pid));
    writeFileSync(join(tmp, `chrome-${port}.json`), JSON.stringify({
      managedBy: 'browser-tools',
      pid: process.pid,
      port,
      userDataDir,
      managedToken,
      args: [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        `--pi-browser-tools-managed=${managedToken}`,
      ],
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    }));

    const ports = occupiedManagedSlotPorts({ processes: [] });
    assert.equal(
      ports.has(port),
      false,
      'an old state must not count merely because an unrelated process now owns its PID',
    );
  });
});

test('the launch lock serialises slot reservation and is released', () => {
  withTempCache(() => {
    const first = acquireLaunchLock();
    assert.ok(first, 'the first caller gets the lock');
    assert.equal(acquireLaunchLock({ waitMs: 0 }), null, 'a second caller is refused while it is held');
    first.release();
    const second = acquireLaunchLock({ waitMs: 0 });
    assert.ok(second, 'the lock is reusable after release');
    second.release();
  });
});

test('a live launch-lock owner never ages out', () => {
  withTempCache((tmp) => {
    const lockDir = join(tmp, 'launch.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock.json'), JSON.stringify({
      pid: process.pid,
      createdAt: new Date(0).toISOString(),
    }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);

    assert.equal(
      acquireLaunchLock({ staleMs: 1, waitMs: 0 }),
      null,
      'age recovery must not replace a lock whose recorded owner is still alive',
    );
    assert.equal(existsSync(lockDir), true, 'the live owner must retain its lock directory');
  });
});

test('the reaper refuses to signal a PID that is no longer a managed browser', () => {
  // PID recycling: the scan saw a managed browser, but by kill time the PID belongs to something
  // else. stopChrome rechecks before SIGKILL; the reaper runs automatically on every start, so it
  // needs at least the same guard.
  withTempCache(() => {
    const victim = spawnSync('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf-8' });
    const pid = Number.parseInt(victim.stdout.trim(), 10);
    assert.ok(Number.isInteger(pid) && pid > 0, 'test needs a live throwaway process');
    try {
      // No state file for :9500, so this looks like an orphan by the lifecycle-file test alone.
      const result = reapOrphanedChromes({ processes: [{ pid, port: 9500, ageMs: 1000 }] });
      assert.equal(result.reaped[0].status, 'skipped-not-managed', 'must refuse, not kill');
      assert.equal(
        spawnSync('/bin/ps', ['-p', String(pid)], { encoding: 'utf-8' }).status,
        0,
        'the unrelated process must still be alive',
      );
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
});

test('a trailing slash on the cache directory does not hide every managed browser', () => {
  // Same silent-disable class as the spaced path: launchChrome builds the dir with join(), which
  // collapses the slash, while a naive `${cacheDir}/chrome-` prefix produces a double slash.
  const bin = CHROME_BIN;
  for (const configured of ['/opt/cache/', '/opt/cache//', '/opt/cache']) {
    const launched = join(configured, 'chrome-data-9222');
    const line = `100 01:00 ${bin} --remote-debugging-port=9222 --user-data-dir=${launched} --pi-browser-tools-managed=tok`;
    const found = parseManagedChromeProcesses(line, { cacheDir: configured, chromeBin: bin });
    assert.equal(found.length, 1, `cacheDir ${JSON.stringify(configured)} must still match`);
    assert.equal(found[0].userDataDir, launched);
  }
  // A sibling directory sharing a prefix must not be swallowed by the normalisation.
  const foreign = `101 01:00 ${bin} --remote-debugging-port=9223 --user-data-dir=/opt/cache-other/chrome-data-9223 --pi-browser-tools-managed=tok`;
  assert.equal(parseManagedChromeProcesses(foreign, { cacheDir: '/opt/cache/', chromeBin: bin }).length, 0);
});

test('dot segments in the cache directory do not hide managed browsers', () => {
  for (const configured of ['/opt/runtime/../cache', './cache']) {
    const launched = join(configured, 'chrome-data-9222');
    const line = `100 01:00 ${CHROME_BIN} --remote-debugging-port=9222 --user-data-dir=${launched} --pi-browser-tools-managed=tok`;
    const found = parseManagedChromeProcesses(line, { cacheDir: configured, chromeBin: CHROME_BIN });
    assert.equal(found.length, 1, `cacheDir ${JSON.stringify(configured)} must match its normalized launch path`);
    assert.equal(found[0].userDataDir, launched);
  }
});

test('isBrowserToolsUserDataDir tolerates a trailing slash on the configured cache dir', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bt-slash-'));
  const previous = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = `${tmp}/`;
  try {
    assert.ok(isBrowserToolsUserDataDir(join(tmp, 'chrome-data-9222')), 'clone dir must be recognised');
    assert.ok(isBrowserToolsUserDataDir(join(tmp, 'chrome-fresh-9223')));
    assert.ok(!isBrowserToolsUserDataDir('/somewhere/else/chrome-data-9222'));
  } finally {
    if (previous === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a config refresh preserves a configured browser cap', () => {
  // Losing maxBrowsers on refresh silently returns the machine to the default cap.
  const built = buildBrowserToolsConfig({
    sourceDir: '/opt/fake-home/Library/Application Support/Google/Chrome',
    existing: { browser: { chromeBin: '/custom/Chrome', maxBrowsers: 12 } },
  });
  assert.equal(built.browser.maxBrowsers, 12, 'an explicit cap must survive --refresh');
  assert.equal(built.browser.chromeBin, '/custom/Chrome');

  const none = buildBrowserToolsConfig({
    sourceDir: '/opt/fake-home/Library/Application Support/Google/Chrome',
    existing: { browser: { chromeBin: '/custom/Chrome' } },
  });
  assert.ok(!('maxBrowsers' in none.browser), 'an unset cap must not be written as null');
});

test('a browser with a half-written lifecycle pair counts as an orphan', () => {
  // stopChrome cannot manage an incomplete pair, so if the orphan predicate spares it too, the
  // browser is unreachable by every path: exactly the dead end this PR exists to remove.
  withTempCache((tmp) => {
    const trackedDir = join(tmp, 'chrome-data-9602');
    const trackedToken = 'tok-9602';
    writeFileSync(join(tmp, 'chrome-9601.json'), JSON.stringify({ managedBy: 'browser-tools', pid: 4242, port: 9601 }));
    // .pid deliberately absent
    writeFileSync(join(tmp, 'chrome-9602.json'), JSON.stringify({
      managedBy: 'browser-tools',
      pid: 4243,
      port: 9602,
      userDataDir: trackedDir,
      managedToken: trackedToken,
      args: [
        '--remote-debugging-port=9602',
        `--user-data-dir=${trackedDir}`,
        `--pi-browser-tools-managed=${trackedToken}`,
      ],
    }));
    writeFileSync(join(tmp, 'chrome-9602.pid'), '4243');

    const processes = [
      { pid: 4242, port: 9601, ageMs: 1000 },
      { pid: 4243, port: 9602, ageMs: 1000, userDataDir: trackedDir, managedToken: trackedToken },
    ];
    const orphans = orphanedManagedBrowsers(processes).map((o) => o.port);
    assert.deepEqual(orphans, [9601], 'the half-tracked browser must be reapable; the fully tracked one must not');
  });
});

test('a disappearing or unreadable PID file cannot abort orphan classification', () => {
  withTempCache((tmp) => {
    const port = 9603;
    const userDataDir = join(tmp, `chrome-data-${port}`);
    const managedToken = `tok-${port}`;
    mkdirSync(join(tmp, `chrome-${port}.pid`));
    writeFileSync(join(tmp, `chrome-${port}.json`), JSON.stringify({
      managedBy: 'browser-tools',
      pid: 4244,
      port,
      userDataDir,
      managedToken,
      args: [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        `--pi-browser-tools-managed=${managedToken}`,
      ],
    }));

    assert.deepEqual(
      orphanedManagedBrowsers([{ pid: 4244, port, ageMs: 1000, userDataDir, managedToken }])
        .map((entry) => entry.port),
      [port],
      'a PID file read failure must make the browser reapable instead of aborting the sweep',
    );
  });
});

test('the reaper compares the full scanned identity, not just "some managed Chrome"', () => {
  // A recycled PID that now belongs to a *different* managed browser previously passed the recheck,
  // so the signal would have killed a healthy browser on another port.
  const scanned = {
    pid: 5000,
    port: 9700,
    userDataDir: '/opt/cache/chrome-data-9700',
    managedToken: 'token-A',
    ageMs: 1000,
  };
  const sameBrowser = { ...scanned };
  const differentPort = { ...scanned, port: 9701, userDataDir: '/opt/cache/chrome-data-9701' };
  const differentToken = { ...scanned, managedToken: 'token-B' };

  assert.equal(managedBrowserIdentityMatches(scanned, sameBrowser), true);
  assert.equal(managedBrowserIdentityMatches(scanned, differentPort), false, 'a different port is a different browser');
  assert.equal(managedBrowserIdentityMatches(scanned, differentToken), false, 'a per-launch token mismatch means the PID was reused');
  assert.equal(managedBrowserIdentityMatches(scanned, null), false);
});

test('parseManagedChromeProcesses exposes the per-launch managed token for identity checks', () => {
  const line = `100 01:00 ${CHROME_BIN} --remote-debugging-port=9222 --user-data-dir=${CACHE_DIR}/chrome-data-9222 --pi-browser-tools-managed=uuid-xyz`;
  const [entry] = parseManagedChromeProcesses(line, { cacheDir: CACHE_DIR, chromeBin: CHROME_BIN });
  assert.equal(entry.managedToken, 'uuid-xyz');
});

test('reuse is refused when the existing browser is not the configuration that was asked for', () => {
  // Adopting a browser with the wrong profile means the automation runs against the wrong account.
  const base = { managedBy: 'browser-tools', ownerTokenHash: ownerTokenHash('tok'), includeGoogle: false };
  const decide = (state, request) =>
    managedBrowserReuseDecision({ safety: { ok: true }, state, ownerToken: 'tok', includeGoogle: false, ...request });

  const work = { ...base, profileName: 'Profile 1', headless: true };
  assert.equal(decide(work, { profileName: 'Profile 1', headless: true }).ok, true, 'identical configuration reuses');

  assert.equal(decide(work, { profileName: 'Profile 2', headless: true }).reason, 'profile-mismatch');
  assert.equal(decide(work, { profileName: null, headless: true }).reason, 'profile-mismatch', 'a fresh start must not adopt a profiled browser');
  assert.equal(
    decide({ ...base, profileName: null, headless: true }, { profileName: 'Profile 1', headless: true }).reason,
    'profile-mismatch',
    'a profiled start must not adopt a fresh browser',
  );
  assert.equal(decide(work, { profileName: 'Profile 1', headless: false }).reason, 'headless-mismatch');
  assert.equal(
    decide(work, { profileName: 'Profile 1', headless: true, forceProfileSync: true }).reason,
    'sync-requested',
    '--sync explicitly asks for fresh credentials, so reuse would defeat it',
  );
});

test('lifecycle state that contradicts the running process counts as an orphan', () => {
  // stopChrome verifies managedToken, userDataDir, port and args, refuses a mismatch, and sends the
  // user to --reap. If the orphan predicate stops at the PID match, --reap disagrees and the browser
  // has no supported cleanup path at all while still holding a slot.
  withTempCache((tmp) => {
    const write = (port, state) => {
      writeFileSync(join(tmp, `chrome-${port}.pid`), String(state.pid));
      writeFileSync(join(tmp, `chrome-${port}.json`), JSON.stringify({
        managedBy: 'browser-tools',
        ...state,
        args: [
          `--remote-debugging-port=${state.port}`,
          `--user-data-dir=${state.userDataDir}`,
          `--pi-browser-tools-managed=${state.managedToken}`,
        ],
      }));
    };
    const scanned = (port, over = {}) => ({
      pid: 7000 + port, port, ageMs: 1000,
      userDataDir: `${tmp}/chrome-data-${port}`, managedToken: `tok-${port}`, ...over,
    });

    write(9801, { pid: 7000 + 9801, port: 9801, userDataDir: `${tmp}/chrome-data-9801`, managedToken: 'tok-9801' });
    write(9802, { pid: 7000 + 9802, port: 9802, userDataDir: `${tmp}/chrome-data-9802`, managedToken: 'STALE-TOKEN' });
    write(9803, { pid: 7000 + 9803, port: 9803, userDataDir: `${tmp}/chrome-data-OTHER`, managedToken: 'tok-9803' });
    write(9804, { pid: 7000 + 9804, port: 6666, userDataDir: `${tmp}/chrome-data-9804`, managedToken: 'tok-9804' });

    const orphans = orphanedManagedBrowsers([scanned(9801), scanned(9802), scanned(9803), scanned(9804)])
      .map((o) => o.port).sort();
    assert.deepEqual(orphans, [9802, 9803, 9804], 'token, data-dir and port contradictions are all orphans');
  });
});

test('lifecycle state that stop cannot validate counts as an orphan', () => {
  withTempCache((tmp) => {
    const write = (port, state) => {
      writeFileSync(join(tmp, `chrome-${port}.pid`), String(state.pid));
      writeFileSync(join(tmp, `chrome-${port}.json`), JSON.stringify({ managedBy: 'browser-tools', ...state }));
    };
    const scanned = (port, token) => ({
      pid: 7000 + port,
      port,
      ageMs: 1000,
      userDataDir: join(tmp, `chrome-data-${port}`),
      managedToken: token,
    });

    const missingToken = scanned(9811, 'tok-9811');
    write(9811, {
      pid: missingToken.pid,
      port: missingToken.port,
      userDataDir: missingToken.userDataDir,
      args: [
        '--remote-debugging-port=9811',
        `--user-data-dir=${missingToken.userDataDir}`,
      ],
    });

    const incompleteArgs = scanned(9812, 'tok-9812');
    write(9812, {
      pid: incompleteArgs.pid,
      port: incompleteArgs.port,
      userDataDir: incompleteArgs.userDataDir,
      managedToken: incompleteArgs.managedToken,
      args: [
        '--remote-debugging-port=9812',
        `--user-data-dir=${incompleteArgs.userDataDir}`,
      ],
    });

    assert.deepEqual(
      orphanedManagedBrowsers([missingToken, incompleteArgs]).map((entry) => entry.port),
      [9811, 9812],
      'missing token and incomplete args must remain reachable through the reaper',
    );
  });
});

test('a config refresh preserves a top-level browser cap too', () => {
  // browserToolsRuntimeConfig honours `{ "maxBrowsers": 12 }` at the top level as a compatibility
  // form, so a refresh that only looks at browser.maxBrowsers silently resets the cap.
  const built = buildBrowserToolsConfig({ sourceDir: '/opt/fake', existing: { maxBrowsers: 12 } });
  assert.equal(built.browser.maxBrowsers, 12, 'the legacy top-level cap must survive --refresh');

  const nested = buildBrowserToolsConfig({
    sourceDir: '/opt/fake',
    existing: { maxBrowsers: 12, browser: { maxBrowsers: 3 } },
  });
  assert.equal(nested.browser.maxBrowsers, 3, 'the nested value wins when both are present');
});

test('a prune dry-run models the reap that a real prune performs first', () => {
  // --prune kills orphans and then reclaims their clones. A dry run that leaves them alive reports
  // those clones as "kept", hiding exactly the removals the real command would do.
  withTempCache((tmp) => {
    mkdirSync(join(tmp, 'chrome-data-9901'));
    const preview = pruneChromeClones({ dryRun: true, assumeStoppedPorts: [9901] });
    assert.ok(
      preview.removed.some((entry) => entry.port === 9901),
      'a port the reap will free must appear as a removal in the preview',
    );
    assert.ok(existsSync(join(tmp, 'chrome-data-9901')), 'a dry run must still delete nothing');
  });
});

test('a real prune never trusts dry-run stopped-port assumptions', () => {
  withTempCache((tmp) => {
    const port = 9902;
    const dataDir = join(tmp, `chrome-data-${port}`);
    const binDir = join(tmp, 'bin');
    mkdirSync(dataDir);
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, 'ps'),
      `#!/bin/sh\nprintf '%s\\n' '4242 /opt/browser-v1 --remote-debugging-port=${port} --user-data-dir=${dataDir} --pi-browser-tools-managed=tok-${port}'\n`,
      { mode: 0o755 },
    );

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath}`;
    try {
      const result = pruneChromeClones({ assumeStoppedPorts: [port] });
      assert.equal(existsSync(dataDir), true, 'a live replacement browser must keep its clone');
      assert.ok(
        result.kept.some((entry) => entry.port === port && entry.reason === 'running'),
        'real prune must rescan live ownership even after a preceding reap',
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });
});

test('stop --reap exits non-zero when a browser could not be reaped', () => {
  // A script that runs `stop --reap` to free a slot must be able to tell that it did not work.
  const stopScript = new URL('../scripts/stop.mjs', import.meta.url).pathname;
  const tmp = mkdtempSync(join(tmpdir(), 'bt-reap-exit-'));
  try {
    const run = (env) => spawnSync(process.execPath, [stopScript, '--reap'], {
      encoding: 'utf-8',
      env: { ...process.env, BROWSER_TOOLS_CACHE_DIR: tmp, ...env },
    });
    const clean = run({});
    assert.equal(clean.status, 0, 'nothing to reap is a success');
    assert.match(clean.stdout, /No untracked managed browsers found/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // The exit-code rule itself, independent of needing a live unkillable process.
  assert.equal(reapExitCode([]), 0);
  assert.equal(reapExitCode([{ status: 'reaped' }, { status: 'already-gone' }]), 0);
  assert.equal(reapExitCode([{ status: 'skipped-not-managed' }]), 0, 'a safety refusal is not a failure');
  assert.equal(reapExitCode([{ status: 'reaped' }, { status: 'failed' }]), 1, 'a failed kill must surface');
});

test('reaping fails when a browser remains alive after SIGKILL', () => {
  assert.equal(forcedKillStatus(true), 'killed');
  const status = forcedKillStatus(false);
  assert.equal(status, 'failed', 'a surviving process still occupies its browser slot');
  assert.equal(reapExitCode([{ status }]), 1, 'the CLI must receive a failing exit status');
});
