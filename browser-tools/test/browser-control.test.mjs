import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PORT,
  CHROME_BIN,
  PROFILE_DST,
  activeChromeProfiles,
  browserToolsConfigFile,
  buildBrowserToolsConfig,
  ensureBrowserToolsConfig,
  freshProfileDirForPort,
  activePage,
  acquirePortLock,
  chromeLaunchArgs,
  fileExists,
  hasFlag,
  managedChromeCommandSafety,
  managedBrowserOwnershipSafety,
  normalizePort,
  optionValue,
  ownerTokenHash,
  parseOwnerId,
  parseOwnerToken,
  parsePort,
  portLockDirForPort,
  dedicatedPage,
  profileDataDirForPort,
  profileSyncItems,
  profileSyncRsyncCommands,
  resolveChromeProfileReference,
  resolveTaskProfile,
  setTaskProfiles,
  stripBrowserSessionArgs,
  timestampedTmpPath,
  validateProfileName,
  waitForChromeReady,
} from '../scripts/browser-control.mjs';

test('optionValue, hasFlag, parsePort, and normalizePort define the shared CLI surface', () => {
  const args = ['--profile', 'Work Profile', '--sync', '--port', '9333'];

  assert.equal(optionValue(args, '--profile'), 'Work Profile');
  assert.equal(optionValue(args, '--sync'), true);
  assert.equal(optionValue(args, '--missing', 'fallback'), 'fallback');
  assert.equal(hasFlag(args, '--sync'), true);
  assert.equal(parsePort(args), 9333);
  assert.equal(normalizePort(undefined), DEFAULT_PORT);

  assert.throws(() => normalizePort(0), /Invalid --port value/);
  assert.throws(() => normalizePort(70000), /Invalid --port value/);
  assert.throws(() => normalizePort('abc'), /Invalid --port value/);
});

test('owner token parsing and hashing define the Browser Tools ownership surface', () => {
  const args = ['--owner-token', 'token-a', '--agent-id', 'agent-a', '--port', '9333', 'document.title'];

  assert.equal(parseOwnerToken(args), 'token-a');
  assert.equal(parseOwnerId(args), 'agent-a');
  assert.equal(ownerTokenHash('token-a'), ownerTokenHash('token-a'));
  assert.notEqual(ownerTokenHash('token-a'), ownerTokenHash('token-b'));
  assert.deepEqual(stripBrowserSessionArgs(args), ['document.title']);
  assert.deepEqual(stripBrowserSessionArgs(['stocks', '9333', '--owner-token', 'token-a'], { stripPositionalPort: true }), ['stocks']);
  assert.throws(() => ownerTokenHash(''), /Missing browser owner token/);
});

test('managed browser ownership requires the matching owner token', () => {
  const state = {
    managedBy: 'browser-tools',
    ownerId: 'agent-a',
    ownerTokenHash: ownerTokenHash('token-a'),
  };

  assert.equal(managedBrowserOwnershipSafety({ state, ownerToken: 'token-a' }).ok, true);
  assert.equal(managedBrowserOwnershipSafety({ state, ownerToken: null }).reason, 'missing-owner-token');
  assert.equal(managedBrowserOwnershipSafety({ state, ownerToken: 'token-b' }).reason, 'owner-token-mismatch');
  assert.equal(managedBrowserOwnershipSafety({ state: { managedBy: 'browser-tools' }, ownerToken: 'token-a' }).reason, 'missing-state-owner-token');
});

test('port locks are atomic and releasable', () => {
  const lock = acquirePortLock(65432, { ownerId: 'agent-a', staleMs: 1000 });
  assert.ok(lock, 'first lock should be acquired');
  try {
    assert.equal(acquirePortLock(65432, { ownerId: 'agent-b', staleMs: 1000 }), null);
    assert.equal(fileExists(join(portLockDirForPort(65432), 'lock.json')), true);
  } finally {
    lock.release();
  }

  assert.equal(acquirePortLock(65432, { ownerId: 'agent-b', staleMs: 1000 })?.lockDir, portLockDirForPort(65432));
  rmSync(portLockDirForPort(65432), { recursive: true, force: true });
});

test('per-port user data dirs isolate concurrent managed browsers', () => {
  assert.match(profileDataDirForPort(9222), /chrome-data-9222$/);
  assert.match(profileDataDirForPort(9223), /chrome-data-9223$/);
  assert.notEqual(profileDataDirForPort(9222), profileDataDirForPort(9223));
  assert.match(freshProfileDirForPort(9222), /chrome-fresh-9222$/);
  assert.notEqual(freshProfileDirForPort(9222), freshProfileDirForPort(9223));
});

test('private Browser Tools config discovers profiles, active profiles, and task preferences outside the repo', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'browser-config-test-'));
  const sourceDir = join(tmp, 'Chrome');
  const configDir = join(tmp, '.agents', 'browser-tools');
  try {
    mkdirSync(sourceDir, { recursive: true });
    const personalAccount = ['person', 'example.test'].join('@');
    const workAccount = ['work', 'example.test'].join('@');
    writeFileSync(join(sourceDir, 'Local State'), JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: 'Personal', user_name: personalAccount, gaia_name: 'Person' },
          'Profile 1': { name: 'Work', user_name: workAccount, gaia_name: 'Worker' },
        },
        last_active_profiles: ['Profile 1'],
      },
    }), 'utf-8');

    const config = buildBrowserToolsConfig({ sourceDir });
    assert.equal(config.profiles.Default.name, 'Personal');
    assert.equal(config.aliases.Work, 'Profile 1');
    assert.equal(config.aliases[workAccount], 'Profile 1');

    ensureBrowserToolsConfig({ configDir, sourceDir });
    assert.equal(existsSync(browserToolsConfigFile(configDir)), true);
    const cached = JSON.parse(readFileSync(browserToolsConfigFile(configDir), 'utf-8'));
    assert.equal(cached.profiles['Profile 1'].account, workAccount);
    assert.equal(cached.profiles['Profile 1'].lastActive, true);

    const previousConfigDir = process.env.BROWSER_TOOLS_CONFIG_DIR;
    process.env.BROWSER_TOOLS_CONFIG_DIR = configDir;
    try {
      assert.equal(browserToolsConfigFile(null), join(configDir, 'config.json'));
      ensureBrowserToolsConfig({ configDir: null, sourceDir, refresh: true });
      assert.equal(existsSync(browserToolsConfigFile(null)), true);
    } finally {
      if (previousConfigDir === undefined) delete process.env.BROWSER_TOOLS_CONFIG_DIR;
      else process.env.BROWSER_TOOLS_CONFIG_DIR = previousConfigDir;
    }

    assert.deepEqual(activeChromeProfiles({ configDir, sourceDir }).map((profile) => profile.folder), ['Profile 1']);
    assert.equal(resolveChromeProfileReference('Work', { configDir, sourceDir }), 'Profile 1');

    const taskProfile = setTaskProfiles('tradingeconomics', ['Work', 'Default'], { configDir, sourceDir });
    assert.deepEqual(taskProfile.profiles, ['Profile 1', 'Default']);
    assert.equal(resolveTaskProfile('tradingeconomics', { configDir, sourceDir }), 'Profile 1');
    const preserved = ensureBrowserToolsConfig({ configDir, sourceDir, refresh: true });
    assert.equal(preserved.taskProfiles.tradingeconomics.defaultProfile, 'Profile 1');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('profile sync plan is allow-listed to auth and browser state, not whole profile data', () => {
  const commands = profileSyncRsyncCommands('Work Profile', {
    sourceDir: '/chrome-source',
    destDir: '/cache/chrome-data',
  });
  const commandArgs = commands.map((command) => command.args);
  const copiedItems = commands.map((command) => command.item);

  assert.deepEqual(commandArgs[0], ['-a', '/chrome-source/Local State', '/cache/chrome-data/']);
  assert.ok(copiedItems.includes('Cookies'));
  assert.ok(copiedItems.includes('Account Web Data'));
  assert.ok(copiedItems.includes('Safe Browsing Cookies'));
  assert.ok(copiedItems.includes('Local Storage'));
  assert.ok(copiedItems.includes('Session Storage'));
  assert.ok(copiedItems.includes('Preferences'));
  assert.ok(copiedItems.includes('Secure Preferences'));

  const joinedArgs = commandArgs.flat().join('\n');
  assert.match(joinedArgs, /\/chrome-source\/Work Profile\/Cookies/);
  assert.match(joinedArgs, /\/cache\/chrome-data\/Work Profile\/Local Storage/);
  assert.doesNotMatch(joinedArgs, /\/chrome-source\/Work Profile\/$/);
  assert.doesNotMatch(joinedArgs, /Service Worker/);
  assert.doesNotMatch(joinedArgs, /IndexedDB/);
  assert.doesNotMatch(joinedArgs, /Cache/);
  assert.match(joinedArgs, /\/chrome-source\/Work Profile\/Extensions/);
  assert.match(joinedArgs, /\/chrome-source\/Work Profile\/Local Extension Settings/);
  assert.doesNotMatch(joinedArgs, /Reporting and NEL/);

  assert.deepEqual(profileSyncItems().find((item) => item.path === 'Cookies'), { path: 'Cookies', type: 'file' });
  assert.deepEqual(profileSyncItems().find((item) => item.path === 'Trust Tokens'), { path: 'Trust Tokens', type: 'file' });
  assert.equal(validateProfileName('Profile 1'), 'Profile 1');
  assert.throws(() => validateProfileName('../Default'), /Invalid Chrome profile folder name/);
  assert.throws(() => validateProfileName('nested/profile'), /Invalid Chrome profile folder name/);
});

test('managedChromeCommandSafety refuses main Chrome and accepts only exact managed state', () => {
  const state = {
    managedBy: 'browser-tools',
    pid: 123,
    port: 9222,
    userDataDir: PROFILE_DST,
    managedToken: 'token-1',
    args: [
      '--remote-debugging-port=9222',
      `--user-data-dir=${PROFILE_DST}`,
      '--pi-browser-tools-managed=token-1',
    ],
  };
  const mainChromeCommand = `${CHROME_BIN} --flag-switches-begin`;
  const managedCommand = `${CHROME_BIN} --remote-debugging-port=9222 --user-data-dir=${PROFILE_DST} --pi-browser-tools-managed=token-1`;

  assert.equal(managedChromeCommandSafety({ pid: 123, port: 9222, state, command: mainChromeCommand }).ok, false);
  assert.equal(managedChromeCommandSafety({ pid: 123, port: 9222, state, command: mainChromeCommand }).reason, 'debug-port-mismatch');
  assert.equal(managedChromeCommandSafety({ pid: 123, port: 9222, state, command: managedCommand }).ok, true);
});

test('chromeLaunchArgs keeps fresh and profile launches separate and marks managed browsers', () => {
  const fresh = chromeLaunchArgs({ port: 9223, managedToken: 'token-1' });
  assert.ok(fresh.includes('--remote-debugging-port=9223'));
  assert.ok(fresh.some((arg) => arg.startsWith('--user-data-dir=')));
  assert.ok(fresh.includes('--pi-browser-tools-managed=token-1'));
  assert.equal(fresh.includes('--disable-extensions'), false);
  assert.ok(fresh.includes('--disable-sync'));
  assert.equal(fresh.some((arg) => arg.startsWith('--profile-directory=')), false);

  const profiled = chromeLaunchArgs({ port: 9224, profileName: 'Work Profile', managedToken: 'token-2' });
  assert.ok(profiled.includes('--remote-debugging-port=9224'));
  assert.ok(profiled.includes(`--user-data-dir=${profileDataDirForPort(9224)}`));
  assert.ok(profiled.includes('--profile-directory=Work Profile'));
  assert.ok(profiled.includes('--pi-browser-tools-managed=token-2'));
  assert.equal(profiled.includes('--disable-extensions'), false);
  assert.ok(profiled.includes('--disable-sync'));
});

test('activePage and dedicatedPage concentrate page selection behavior', async () => {
  const created = [];
  const existing = [
    { url: () => 'https://first.example.test' },
    { url: () => 'https://target.example.test/path' },
  ];
  const browser = {
    pages: async () => existing,
    newPage: async () => {
      const page = {
        visited: [],
        url: () => 'about:blank',
        goto: async (url) => page.visited.push(url),
      };
      created.push(page);
      return page;
    },
  };

  assert.equal(await activePage(browser), existing[1]);
  assert.equal(await dedicatedPage(browser, (url) => url.includes('target')), existing[1]);

  const page = await dedicatedPage(browser, (url) => url.includes('missing'), 'https://created.example.test');
  assert.equal(page, created[0]);
  assert.deepEqual(page.visited, ['https://created.example.test']);
});

test('timestampedTmpPath and fileExists support screenshot and artifact behavior without browser side effects', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'browser-control-test-'));
  try {
    const file = join(tmp, 'artifact.txt');
    writeFileSync(file, 'hello', 'utf-8');
    assert.equal(fileExists(file), true);
    assert.equal(fileExists(join(tmp, 'missing.txt')), false);

    const screenshotPath = timestampedTmpPath('bad prefix / spaces', '.png');
    assert.match(screenshotPath, /bad-prefix---spaces-.*\.png$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('waitForChromeReady respects the hard timeout', async () => {
  const startedAt = Date.now();
  const ready = await waitForChromeReady(65528, {
    timeoutMs: 75,
    intervalMs: 10,
    probeTimeoutMs: 10,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(ready, false);
  assert.ok(elapsedMs < 1000, `expected a short hard timeout, got ${elapsedMs}ms`);
});
