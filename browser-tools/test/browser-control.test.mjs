import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SQLITE_AVAILABLE = (() => {
  try { return spawnSync('sqlite3', ['--version'], { encoding: 'utf-8' }).status === 0; }
  catch { return false; }
})();
import {
  DEFAULT_PORT,
  CACHE_DIR,
  CHROME_BIN,
  CHROME_SRC,
  FRESH_PROFILE_DIR,
  PROFILE_DST,
  PROFILE_SYNC_STATE_FILE,
  activeChromeProfiles,
  browserToolsConfigFile,
  browserToolsProfilesConfigFile,
  browserToolsRuntimeConfig,
  buildBrowserToolsConfig,
  buildChromeProfilesConfig,
  ensureBrowserToolsConfig,
  ensureChromeProfilesConfig,
  freshProfileDirForPort,
  activePage,
  acquirePortLock,
  chromeLaunchArgs,
  chromeUserAgentForMajor,
  googleCookieDeleteSql,
  stripGoogleIdentityFromProfileCopy,
  fileExists,
  hasFlag,
  managedChromeCommandSafety,
  managedBrowserOwnershipSafety,
  normalizePort,
  optionValue,
  parsePositiveIntegerOption,
  ownerTokenHash,
  parseOwnerId,
  parseOwnerToken,
  parsePort,
  pidFileForPort,
  portLockDirForPort,
  dedicatedPage,
  profileDataDirForPort,
  profileSyncItems,
  profileSyncRsyncCommands,
  profileSyncStateFileForPort,
  pruneChromeClones,
  readProfileSyncState,
  readBrowserToolsConfig,
  readChromeProfilesConfig,
  requiredOptionValue,
  resolveChromeProfileReference,
  resolveStartProfileName,
  resolveTaskProfile,
  setTaskProfiles,
  startChrome,
  stateFileForPort,
  stripBrowserSessionArgs,
  syncChromeProfile,
  timestampedTmpPath,
  validateProfileName,
  waitForChromeReady,
  writeChromeProfilesConfig,
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

test('parsePositiveIntegerOption accepts only present positive integer option values', () => {
  assert.equal(parsePositiveIntegerOption([], '--chars', 5000), 5000);
  assert.equal(parsePositiveIntegerOption(['--chars', '6000'], '--chars', 5000), 6000);

  assert.throws(() => parsePositiveIntegerOption(['--chars'], '--chars', 5000), /Missing --chars value/);
  assert.throws(() => parsePositiveIntegerOption(['--chars', 'abc'], '--chars', 5000), /Invalid --chars value/);
  assert.throws(() => parsePositiveIntegerOption(['--chars', '--port', '9223'], '--chars', 5000), /Missing --chars value/);
  assert.throws(() => parsePositiveIntegerOption(['--chars', '0'], '--chars', 5000), /Invalid --chars value/);
});

test('value option parsers reject missing and option-like values', () => {
  assert.throws(() => parsePort(['--port']), /Missing value after --port/);
  assert.throws(() => parsePort(['--port', '--owner-token', 'token-a']), /Missing value after --port/);
  assert.throws(() => parseOwnerToken(['--owner-token']), /Missing value after --owner-token/);
  assert.throws(() => parseOwnerToken(['--owner-token', '--port', '9333']), /Missing value after --owner-token/);
  assert.throws(() => parseOwnerId(['--owner-id', '--port', '9333']), /Missing value after --owner-id/);
  assert.throws(() => parseOwnerId(['--agent-id']), /Missing value after --agent-id/);
  assert.throws(() => requiredOptionValue(['--profile', '--sync'], '--profile', null), /Missing value after --profile/);
  assert.throws(() => requiredOptionValue(['--config-dir'], '--config-dir', undefined), /Missing value after --config-dir/);
});

test('owner token parsing and hashing define the Browser Tools ownership surface', () => {
  const args = ['--owner-token', 'token-a', '--agent-id', 'agent-a', '--port', '9333', 'document.title'];

  assert.equal(parseOwnerToken(args), 'token-a');
  assert.equal(parseOwnerId(args), 'agent-a');
  assert.equal(ownerTokenHash('token-a'), ownerTokenHash('token-a'));
  assert.notEqual(ownerTokenHash('token-a'), ownerTokenHash('token-b'));
  assert.deepEqual(stripBrowserSessionArgs(args), ['document.title']);
  assert.deepEqual(stripBrowserSessionArgs(['article', '9333', '--owner-token', 'token-a'], { stripPositionalPort: true }), ['article']);
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

test('stopping can reclaim an unowned browser, while adopting and connecting still cannot', () => {
  // Its owner token was generated for a caller that has exited, so no token can address it again.
  const unowned = { managedBy: 'browser-tools', ownerId: null, ownerTokenHash: ownerTokenHash('lost-token') };
  const owned = { managedBy: 'browser-tools', ownerId: 'agent-a', ownerTokenHash: ownerTokenHash('token-a') };

  const reclaim = managedBrowserOwnershipSafety({ state: unowned, ownerToken: null, allowUnowned: true });
  assert.equal(reclaim.ok, true, 'an unowned browser must be stoppable or it leaks forever');
  assert.equal(reclaim.reclaimedUnowned, true, 'reclaiming someone else nobody owns must be reported, not silent');

  assert.equal(
    managedBrowserOwnershipSafety({ state: owned, ownerToken: null, allowUnowned: true }).reason,
    'missing-owner-token',
    'an owned browser still needs its token even when reclaiming is allowed',
  );
  assert.equal(
    managedBrowserOwnershipSafety({ state: unowned, ownerToken: null }).reason,
    'missing-owner-token',
    'adoption and connection never opt in, so an unowned browser cannot be hijacked',
  );
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

test('a corrupt lock.json is treated as stale, not a fatal error', () => {
  const lockDir = portLockDirForPort(65431);
  rmSync(lockDir, { recursive: true, force: true });
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'lock.json'), '{ this is not valid json');
  // Backdate the lock so it is stale by age; a corrupt lock must then be recovered, never throw.
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(lockDir, past, past);
  try {
    const lock = acquirePortLock(65431, { ownerId: 'agent-a', staleMs: 1000 });
    assert.ok(lock, 'a stale corrupt lock should be removed and the port re-acquired');
    assert.equal(typeof lock.release, 'function');
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test('readProfileSyncState treats a corrupt per-port state file as a cache miss', () => {
  const previousCacheDir = process.env.BROWSER_TOOLS_CACHE_DIR;
  const tmp = mkdtempSync(join(tmpdir(), 'sync-state-corrupt-'));
  try {
    process.env.BROWSER_TOOLS_CACHE_DIR = tmp;
    writeFileSync(profileSyncStateFileForPort(9222), '{ truncated');
    // Must not throw; a corrupt generated cache file should read as null so start resyncs.
    assert.equal(readProfileSyncState(9222), null);
  } finally {
    if (previousCacheDir === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previousCacheDir;
    rmSync(tmp, { recursive: true, force: true });
  }
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
    assert.equal(config.directories.chromeSourceDir, sourceDir);
    assert.match(config.directories.cacheDir, /pi-browser-tools$/);
    assert.match(config.browser.chromeBin, /Google Chrome$/);

    ensureBrowserToolsConfig({ configDir, sourceDir });
    assert.equal(existsSync(browserToolsConfigFile(configDir)), true);
    const cached = JSON.parse(readFileSync(browserToolsConfigFile(configDir), 'utf-8'));
    assert.equal(cached.profiles['Profile 1'].account, workAccount);
    assert.equal(cached.profiles['Profile 1'].lastActive, true);
    assert.equal(cached.directories.chromeSourceDir, sourceDir);

    cached.directories.cacheDir = '~/custom-browser-cache';
    cached.directories.artifactDir = '~/custom-browser-artifacts';
    cached.browser.chromeBin = '~/Applications/Chrome Test';
    writeFileSync(browserToolsConfigFile(configDir), JSON.stringify(cached, null, 2), 'utf-8');
    const runtimeConfig = browserToolsRuntimeConfig({ configDir });
    assert.match(runtimeConfig.cacheDir, /custom-browser-cache$/);
    assert.match(runtimeConfig.artifactDir, /custom-browser-artifacts$/);
    assert.match(runtimeConfig.chromeBin, /Applications\/Chrome Test$/);

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

    const taskProfile = setTaskProfiles('finance', ['Work', 'Default'], { configDir, sourceDir });
    assert.deepEqual(taskProfile.profiles, ['Profile 1', 'Default']);
    assert.equal(resolveTaskProfile('finance', { configDir, sourceDir }), 'Profile 1');
    assert.deepEqual(
      resolveStartProfileName({ taskName: 'missing-task', defaultProfileName: 'Default', configDir, sourceDir }),
      { requestedProfileName: 'Default', resolvedProfileName: 'Default', source: 'default' },
    );
    assert.deepEqual(
      resolveStartProfileName({ profileName: 'Work', taskName: 'finance', defaultProfileName: 'Default', configDir, sourceDir }),
      { requestedProfileName: 'Work', resolvedProfileName: 'Profile 1', source: 'explicit' },
    );
    const preserved = ensureBrowserToolsConfig({ configDir, sourceDir, refresh: true });
    assert.equal(preserved.taskProfiles.finance.defaultProfile, 'Profile 1');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Browser Tools config JSON parse errors fail loudly without overwrite', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'browser-config-json-test-'));
  const configDir = join(tmp, '.agents', 'browser-tools');
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(browserToolsConfigFile(configDir), '{ bad json', 'utf-8');

    assert.throws(() => readBrowserToolsConfig({ configDir }), /Failed to parse JSON file .*config\.json/);
    assert.throws(() => ensureBrowserToolsConfig({ configDir, refresh: true }), /Failed to parse JSON file .*config\.json/);
    assert.equal(readFileSync(browserToolsConfigFile(configDir), 'utf-8'), '{ bad json');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('refresh with a custom config dir scans that config source directory by default', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'browser-config-refresh-test-'));
  const customSourceDir = join(tmp, 'Custom Chrome');
  const wrongSourceDir = join(tmp, 'Wrong Chrome');
  const customConfigDir = join(tmp, 'custom-config');
  const wrongConfigDir = join(tmp, 'wrong-config');
  const previousConfigDir = process.env.BROWSER_TOOLS_CONFIG_DIR;
  try {
    mkdirSync(customSourceDir, { recursive: true });
    mkdirSync(wrongSourceDir, { recursive: true });
    writeFileSync(join(customSourceDir, 'Local State'), JSON.stringify({
      profile: { info_cache: { Default: { name: 'Custom Source' } }, last_active_profiles: ['Default'] },
    }), 'utf-8');
    writeFileSync(join(wrongSourceDir, 'Local State'), JSON.stringify({
      profile: { info_cache: { Default: { name: 'Wrong Source' } }, last_active_profiles: ['Default'] },
    }), 'utf-8');

    ensureBrowserToolsConfig({ configDir: wrongConfigDir, sourceDir: wrongSourceDir });
    process.env.BROWSER_TOOLS_CONFIG_DIR = wrongConfigDir;
    ensureBrowserToolsConfig({ configDir: customConfigDir, sourceDir: customSourceDir });

    writeFileSync(join(customSourceDir, 'Local State'), JSON.stringify({
      profile: { info_cache: { Default: { name: 'Custom Refreshed' } }, last_active_profiles: ['Default'] },
    }), 'utf-8');

    const refreshed = ensureBrowserToolsConfig({ configDir: customConfigDir, refresh: true });
    assert.equal(refreshed.profiles.Default.name, 'Custom Refreshed');
    assert.equal(refreshed.directories.chromeSourceDir, customSourceDir);
  } finally {
    if (previousConfigDir === undefined) delete process.env.BROWSER_TOOLS_CONFIG_DIR;
    else process.env.BROWSER_TOOLS_CONFIG_DIR = previousConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('legacy Browser Tools profile config exports stay as compatibility aliases', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'browser-legacy-config-test-'));
  const sourceDir = join(tmp, 'Chrome');
  const configDir = join(tmp, '.agents', 'browser-tools');
  try {
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'Local State'), JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: 'Default' },
        },
        last_active_profiles: ['Default'],
      },
    }), 'utf-8');

    assert.equal(browserToolsProfilesConfigFile(configDir), browserToolsConfigFile(configDir));
    assert.equal(CHROME_SRC.endsWith(join('Google', 'Chrome')), true);
    assert.equal(FRESH_PROFILE_DIR, join(CACHE_DIR, 'chrome-fresh'));
    assert.equal(PROFILE_SYNC_STATE_FILE, join(CACHE_DIR, 'chrome-profile-sync.json'));

    const built = buildChromeProfilesConfig({ sourceDir });
    writeChromeProfilesConfig(built, { configDir });
    assert.deepEqual(readChromeProfilesConfig({ configDir }).profiles.Default, built.profiles.Default);
    assert.equal(ensureChromeProfilesConfig({ configDir, sourceDir }).profiles.Default.lastActive, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('profile sync fails fast when rsync exits non-zero', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'browser-profile-sync-fail-test-'));
  const sourceDir = join(tmp, 'Chrome');
  const destDir = join(tmp, 'chrome-data');
  const cacheDir = join(tmp, 'cache');
  const binDir = join(tmp, 'bin');
  const previousPath = process.env.PATH;
  const previousCacheDir = process.env.BROWSER_TOOLS_CACHE_DIR;
  try {
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(join(sourceDir, 'Default'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(sourceDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Default' } } } }), 'utf-8');
    const rsyncPath = join(binDir, 'rsync');
    writeFileSync(rsyncPath, '#!/bin/sh\nexit 7\n', 'utf-8');
    chmodSync(rsyncPath, 0o755);
    process.env.PATH = `${binDir}:${previousPath}`;
    process.env.BROWSER_TOOLS_CACHE_DIR = cacheDir;

    assert.throws(() => syncChromeProfile('Default', { force: true, port: 65401, sourceDir, destDir }), /rsync failed for Local State: exit status 7/);
    assert.equal(existsSync(profileSyncStateFileForPort(65401)), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCacheDir === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previousCacheDir;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('profile sync fails when requested Chrome profile folder is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'browser-profile-sync-missing-test-'));
  const sourceDir = join(tmp, 'Chrome');
  const destDir = join(tmp, 'chrome-data');
  const cacheDir = join(tmp, 'cache');
  const previousCacheDir = process.env.BROWSER_TOOLS_CACHE_DIR;
  try {
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Default' } } } }), 'utf-8');
    process.env.BROWSER_TOOLS_CACHE_DIR = cacheDir;

    assert.throws(() => profileSyncRsyncCommands('Default', { sourceDir, destDir, checkExists: true }), /Chrome profile folder not found/);
    assert.throws(() => syncChromeProfile('Default', { force: true, port: 65403, sourceDir, destDir }), /Chrome profile folder not found/);
    assert.equal(existsSync(profileSyncStateFileForPort(65403)), false);
  } finally {
    if (previousCacheDir === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previousCacheDir;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('profile sync fails fast when rsync is terminated by signal', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'browser-profile-sync-signal-test-'));
  const sourceDir = join(tmp, 'Chrome');
  const destDir = join(tmp, 'chrome-data');
  const cacheDir = join(tmp, 'cache');
  const binDir = join(tmp, 'bin');
  const previousPath = process.env.PATH;
  const previousCacheDir = process.env.BROWSER_TOOLS_CACHE_DIR;
  try {
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(join(sourceDir, 'Default'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(sourceDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Default' } } } }), 'utf-8');
    const rsyncPath = join(binDir, 'rsync');
    writeFileSync(rsyncPath, '#!/bin/sh\nkill -TERM $$\n', 'utf-8');
    chmodSync(rsyncPath, 0o755);
    process.env.PATH = `${binDir}:${previousPath}`;
    process.env.BROWSER_TOOLS_CACHE_DIR = cacheDir;

    assert.throws(() => syncChromeProfile('Default', { force: true, port: 65402, sourceDir, destDir }), /rsync failed for Local State: terminated by signal SIGTERM/);
    assert.equal(existsSync(profileSyncStateFileForPort(65402)), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCacheDir === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previousCacheDir;
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

test('pruneChromeClones removes stale clone artifacts and preserves non-clone cache files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bt-prune-'));
  const previous = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = tmp;
  try {
    // stale profile clone with full lifecycle + sync-state litter
    mkdirSync(join(tmp, 'chrome-data-9601'));
    writeFileSync(join(tmp, 'chrome-data-9601', 'Local State'), '{}');
    writeFileSync(join(tmp, 'chrome-9601.pid'), '123');
    writeFileSync(join(tmp, 'chrome-9601.json'), '{}');
    writeFileSync(join(tmp, 'chrome-profile-sync-9601.json'), '{}');
    // stale fresh (no-auth) clone
    mkdirSync(join(tmp, 'chrome-fresh-9602'));
    // orphan sync-state json with no matching clone dir
    writeFileSync(join(tmp, 'chrome-profile-sync-9603.json'), '{}');
    // non-clone cache entries that must survive
    writeFileSync(join(tmp, 'ai-chat-browser.json'), '{}');
    mkdirSync(join(tmp, 'ai-chat-conversations'));

    // dry run reports work but deletes nothing
    const dry = pruneChromeClones({ dryRun: true });
    assert.equal(dry.removed.length, 3);
    assert.ok(existsSync(join(tmp, 'chrome-data-9601')));
    assert.ok(existsSync(join(tmp, 'chrome-profile-sync-9603.json')));

    const result = pruneChromeClones();
    assert.equal(result.removed.length, 3);
    assert.ok(!existsSync(join(tmp, 'chrome-data-9601')));
    assert.ok(!existsSync(join(tmp, 'chrome-9601.pid')));
    assert.ok(!existsSync(join(tmp, 'chrome-9601.json')));
    assert.ok(!existsSync(join(tmp, 'chrome-profile-sync-9601.json')));
    assert.ok(!existsSync(join(tmp, 'chrome-fresh-9602')));
    assert.ok(!existsSync(join(tmp, 'chrome-profile-sync-9603.json')));
    // non-clone files preserved
    assert.ok(existsSync(join(tmp, 'ai-chat-browser.json')));
    assert.ok(existsSync(join(tmp, 'ai-chat-conversations')));
  } finally {
    if (previous === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pruneChromeClones keeps the ports listed in keepPorts (protects an in-progress start)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bt-prune-keep-'));
  const previous = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = tmp;
  try {
    mkdirSync(join(tmp, 'chrome-data-9611'));
    mkdirSync(join(tmp, 'chrome-data-9612'));
    const result = pruneChromeClones({ keepPorts: [9611] });
    assert.ok(existsSync(join(tmp, 'chrome-data-9611')), 'kept port must survive');
    assert.ok(!existsSync(join(tmp, 'chrome-data-9612')), 'other stale clone must be removed');
    assert.equal(result.removed.length, 1);
  } finally {
    if (previous === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pruneChromeClones skips a port that has an active start lock', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bt-prune-lock-'));
  const previous = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = tmp;
  try {
    mkdirSync(join(tmp, 'chrome-data-9621')); // a concurrent start's just-synced clone
    mkdirSync(portLockDirForPort(9621));       // that start still holds the port lock, no process yet
    mkdirSync(join(tmp, 'chrome-data-9622')); // an unrelated stale clone
    const result = pruneChromeClones();
    assert.ok(existsSync(join(tmp, 'chrome-data-9621')), 'a locked port clone must survive');
    assert.ok(!existsSync(join(tmp, 'chrome-data-9622')), 'the unlocked stale clone must be removed');
    assert.ok(result.kept.some((entry) => entry.port === 9621 && entry.reason === 'start-locked'));
  } finally {
    if (previous === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('stripGoogleIdentityFromProfileCopy records errors when sqlite3 is unavailable', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'strip-fail-'));
  try {
    const profileDir = join(tmp, 'Default');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'Cookies'), 'not-a-real-db');
    // A failed strip must be observable (drives the abort that protects the source Google session).
    const result = stripGoogleIdentityFromProfileCopy(profileDir, { sqlite3Bin: join(tmp, 'no-such-sqlite3') });
    assert.ok(result.errors.length > 0, 'a missing sqlite3 binary must be recorded as an error');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
  const previousOverrideCommand = `/opt/browser-v1 --remote-debugging-port=9222 --user-data-dir=${PROFILE_DST} --pi-browser-tools-managed=token-1`;

  assert.equal(managedChromeCommandSafety({ pid: 123, port: 9222, state, command: mainChromeCommand }).ok, false);
  assert.equal(managedChromeCommandSafety({ pid: 123, port: 9222, state, command: mainChromeCommand }).reason, 'debug-port-mismatch');
  assert.equal(managedChromeCommandSafety({ pid: 123, port: 9222, state, command: managedCommand }).ok, true);
  assert.equal(
    managedChromeCommandSafety({ pid: 123, port: 9222, state, command: previousOverrideCommand }).ok,
    true,
    'managed lifecycle identity must survive a configured binary change',
  );
});

test('startChrome fails invalid Chrome binary without leaving lifecycle files or lock', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'browser-start-missing-bin-test-'));
  const cacheDir = join(tmp, 'cache');
  const port = 65405;
  const previousChromeBin = process.env.BROWSER_TOOLS_CHROME_BIN;
  const previousCacheDir = process.env.BROWSER_TOOLS_CACHE_DIR;
  try {
    process.env.BROWSER_TOOLS_CHROME_BIN = join(tmp, 'missing-chrome');
    process.env.BROWSER_TOOLS_CACHE_DIR = cacheDir;

    await assert.rejects(() => startChrome({ port, ownerToken: 'token-a', ownerId: 'binary-check' }), /Chrome binary not found/);
    assert.equal(existsSync(pidFileForPort(port)), false);
    assert.equal(existsSync(stateFileForPort(port)), false);
    assert.equal(existsSync(portLockDirForPort(port)), false);
  } finally {
    if (previousChromeBin === undefined) delete process.env.BROWSER_TOOLS_CHROME_BIN;
    else process.env.BROWSER_TOOLS_CHROME_BIN = previousChromeBin;
    if (previousCacheDir === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previousCacheDir;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('startChrome refuses an ownerless start before creating lifecycle files', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'browser-start-ownerless-test-'));
  const cacheDir = join(tmp, 'cache');
  const port = 65406;
  const previousChromeBin = process.env.BROWSER_TOOLS_CHROME_BIN;
  const previousCacheDir = process.env.BROWSER_TOOLS_CACHE_DIR;
  try {
    // A missing binary keeps this test from launching a real browser if the owner check is absent.
    process.env.BROWSER_TOOLS_CHROME_BIN = join(tmp, 'missing-chrome');
    process.env.BROWSER_TOOLS_CACHE_DIR = cacheDir;

    await assert.rejects(() => startChrome({ port, ownerToken: 'token-a' }), /without an owner id/i);
    await assert.rejects(() => startChrome({ port, ownerToken: 'token-a', ownerId: '   ' }), /without an owner id/i);
    assert.equal(existsSync(pidFileForPort(port)), false);
    assert.equal(existsSync(stateFileForPort(port)), false);
    assert.equal(existsSync(portLockDirForPort(port)), false);
  } finally {
    if (previousChromeBin === undefined) delete process.env.BROWSER_TOOLS_CHROME_BIN;
    else process.env.BROWSER_TOOLS_CHROME_BIN = previousChromeBin;
    if (previousCacheDir === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = previousCacheDir;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('chromeLaunchArgs keeps fresh and profile launches separate and marks managed browsers', () => {
  const fresh = chromeLaunchArgs({ port: 9223, managedToken: 'token-1' });
  assert.ok(fresh.includes('--remote-debugging-port=9223'));
  assert.ok(fresh.some((arg) => arg.startsWith('--user-data-dir=')));
  assert.ok(fresh.includes('--pi-browser-tools-managed=token-1'));
  assert.equal(fresh.includes('--disable-extensions'), false);
  assert.ok(fresh.includes('--disable-sync'));
  assert.equal(fresh.some((arg) => arg.startsWith('--profile-directory=')), false);

  assert.equal(fresh.includes('--headless=new'), false);

  const profiled = chromeLaunchArgs({ port: 9224, profileName: 'Work Profile', managedToken: 'token-2' });
  assert.ok(profiled.includes('--remote-debugging-port=9224'));
  assert.ok(profiled.includes(`--user-data-dir=${profileDataDirForPort(9224)}`));
  assert.ok(profiled.includes('--profile-directory=Work Profile'));
  assert.ok(profiled.includes('--pi-browser-tools-managed=token-2'));
  assert.equal(profiled.includes('--disable-extensions'), false);
  assert.ok(profiled.includes('--disable-sync'));
  assert.equal(profiled.includes('--headless=new'), false);
});

test('chromeUserAgentForMajor builds a normal Chrome UA without the headless marker', () => {
  const ua = chromeUserAgentForMajor(150);
  assert.match(ua, /Chrome\/150\.0\.0\.0 Safari\/537\.36$/);
  // The whole point of the override is to not look like headless.
  assert.equal(/Headless/i.test(ua), false);
  // No machine-specific data belongs in the UA template.
  assert.equal(chromeUserAgentForMajor(0), null);
  assert.equal(chromeUserAgentForMajor(null), null);
  assert.equal(chromeUserAgentForMajor('abc'), null);
});

test('chromeLaunchArgs adds new headless only when requested and stays compatible with safety checks', () => {
  const headlessArgs = chromeLaunchArgs({ port: 9225, profileName: 'Work Profile', managedToken: 'token-3', headless: true });
  assert.ok(headlessArgs.includes('--headless=new'));
  // Old --headless is a separate engine that ignores extensions, so it must never appear.
  assert.equal(headlessArgs.includes('--headless'), false);
  assert.equal(headlessArgs.includes('--headless=old'), false);
  assert.ok(headlessArgs.includes('--profile-directory=Work Profile'));

  // When a UA override is supplied (headless launches pass one), it is present browser-wide.
  const ua = chromeUserAgentForMajor(150);
  const maskedArgs = chromeLaunchArgs({ port: 9226, managedToken: 'token-4', headless: true, userAgent: ua });
  assert.ok(maskedArgs.includes(`--user-agent=${ua}`));
  // A windowed launch supplies no override, so it keeps the real Chrome UA untouched.
  const windowedArgs = chromeLaunchArgs({ port: 9227, managedToken: 'token-5' });
  assert.equal(windowedArgs.some((arg) => arg.startsWith('--user-agent=')), false);

  // A headless launch must still pass the managed-process safety gate that stop/connect rely on.
  const state = {
    managedBy: 'browser-tools',
    pid: 321,
    port: 9225,
    userDataDir: profileDataDirForPort(9225),
    managedToken: 'token-3',
    args: headlessArgs,
  };
  const managedCommand = `${CHROME_BIN} ${headlessArgs.join(' ')}`;
  assert.equal(managedChromeCommandSafety({ pid: 321, port: 9225, state, command: managedCommand }).ok, true);
});

test('googleCookieDeleteSql covers the Google ecosystem without matching lookalikes', () => {
  const sql = googleCookieDeleteSql();
  assert.match(sql, /DELETE FROM cookies/i);
  assert.match(sql, /host_key='google\.com'/);
  assert.match(sql, /host_key LIKE '%\.google\.com'/);
  assert.match(sql, /host_key='youtube\.com'/);
  assert.match(sql, /host_key='doubleclick\.net'/);
  assert.match(sql, /host_key='google\.dev'/);
  // Country search domains and the Google-owned .google gTLD, matched by leading-dot patterns only.
  assert.match(sql, /host_key LIKE '%\.google\.__'/);
  assert.match(sql, /host_key LIKE '%\.google\.co\.__'/);
  assert.match(sql, /host_key LIKE '%\.google'/);
  // Every domain must use exact or leading-dot matching, so a dotless suffix (which would catch
  // notgoogle.com) must never appear.
  assert.doesNotMatch(sql, /LIKE '%google\.com'/);
});

test('stripGoogleIdentityFromProfileCopy removes the Google ecosystem while keeping other logins', { skip: SQLITE_AVAILABLE ? false : 'sqlite3 not available' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'strip-google-test-'));
  try {
    const profileDir = join(tmp, 'Default');
    mkdirSync(join(profileDir, 'Network'), { recursive: true });
    const googleHosts = ['.google.com', 'accounts.google.com', '.youtube.com', '.google.se', '.doubleclick.net', 'googleusercontent.com', 'ai.google.dev', 'codeassist.google'];
    const keepHosts = ['.wsj.com', 'x.com', 'notgoogle.com', '.notgoogle.se', 'x.notgoogle'];
    const values = [...googleHosts, ...keepHosts].map((h) => `('${h}','c','x')`).join(',');
    const seed = `CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT); INSERT INTO cookies VALUES ${values};`;
    const cookiesDb = join(profileDir, 'Cookies');
    const networkCookiesDb = join(profileDir, 'Network', 'Cookies');
    assert.equal(spawnSync('sqlite3', [cookiesDb, seed]).status, 0);
    assert.equal(spawnSync('sqlite3', [networkCookiesDb, seed]).status, 0);
    const webDataDb = join(profileDir, 'Web Data');
    assert.equal(spawnSync('sqlite3', [webDataDb, "CREATE TABLE token_service (service TEXT, token TEXT); INSERT INTO token_service VALUES('google','secret');"]).status, 0);

    const result = stripGoogleIdentityFromProfileCopy(profileDir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.cookieDbs.length, 2);
    assert.equal(result.webDataCleared, true);

    for (const db of [cookiesDb, networkCookiesDb]) {
      const hosts = spawnSync('sqlite3', [db, 'SELECT host_key FROM cookies;'], { encoding: 'utf-8' })
        .stdout.trim().split('\n').filter(Boolean);
      assert.deepEqual(hosts.sort(), [...keepHosts].sort(), `only non-Google logins should remain, got ${JSON.stringify(hosts)}`);
      for (const g of googleHosts) assert.equal(hosts.includes(g), false, `${g} should be removed`);
    }
    const tokenCount = spawnSync('sqlite3', [webDataDb, 'SELECT COUNT(*) FROM token_service;'], { encoding: 'utf-8' }).stdout.trim();
    assert.equal(tokenCount, '0');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
