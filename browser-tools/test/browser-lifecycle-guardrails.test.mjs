// Guardrails against the managed-Chrome leak: a fan-out of bare `start` calls once left 86 headless
// browsers (853 processes, ~70 GB) alive for days, with their lifecycle files deleted underneath them
// so `stop.mjs` could no longer see them. These tests pin the invariants that make that unreachable:
// process scanning is the source of truth (not lifecycle files), a hard cap bounds concurrency,
// orphans are reapable, and stop never orphans a live browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MAX_MANAGED_BROWSERS,
  assertManagedBrowserCapacity,
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
    writeFileSync(join(tmp, 'chrome-9222.pid'), '100');
    writeFileSync(join(tmp, 'chrome-9222.json'), JSON.stringify({ managedBy: 'browser-tools', pid: 100, port: 9222 }));
    // :9223 is tracked but the state file points at a different pid (recycled/rewritten state)
    writeFileSync(join(tmp, 'chrome-9223.pid'), '999');
    writeFileSync(join(tmp, 'chrome-9223.json'), JSON.stringify({ managedBy: 'browser-tools', pid: 999, port: 9223 }));

    const processes = [
      { pid: 100, port: 9222, ageMs: 1000 },
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

test('assertManagedBrowserCapacity blocks a new browser at the cap with an actionable message', () => {
  const under = new Array(4).fill({ pid: 1, port: 9222, ageMs: 1000 });
  assert.doesNotThrow(() => assertManagedBrowserCapacity({ processes: under, max: 5 }));

  const at = [9222, 9223, 9224, 9225, 9226].map((port, i) => ({ pid: 100 + i, port, ageMs: 3 * 60 * 60 * 1000 }));
  assert.throws(
    () => assertManagedBrowserCapacity({ processes: at, max: 5 }),
    (error) => {
      assert.match(error.message, /5 of 5/, 'must state the count against the cap');
      assert.match(error.message, /--reap|stop\.mjs/, 'must name the recovery command');
      assert.match(error.message, /9222/, 'must list the ports holding the slots');
      return true;
    },
  );
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
    writeFileSync(join(cacheDir, `chrome-${port}.pid`), String(pidFor(port)));
    writeFileSync(join(cacheDir, `chrome-${port}.json`), JSON.stringify({
      managedBy: 'browser-tools', pid: pidFor(port), port,
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
    // tracked: state file agrees with the running pid
    writeFileSync(join(tmp, 'chrome-9222.pid'), '900001');
    writeFileSync(join(tmp, 'chrome-9222.json'), JSON.stringify({ managedBy: 'browser-tools', pid: 900001, port: 9222 }));
    // untracked but a start currently holds the port lock: its browser exists before its state file does
    mkdirSync(portLockDirForPort(9223), { recursive: true });

    const processes = [
      { pid: 900001, port: 9222, ageMs: 1000 },
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
