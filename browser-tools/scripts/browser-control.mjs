import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

export const DEFAULT_PORT = 9222;
export const CONNECT_PROBE_TIMEOUT_MS = 3000;
export const CHROME_READY_TIMEOUT_MS = 15000;
export const CHROME_READY_PROBE_TIMEOUT_MS = 250;
export const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const CHROME_SRC = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
export const CACHE_DIR = join(homedir(), '.cache', 'pi-browser-tools');
export const PROFILE_DST = join(CACHE_DIR, 'chrome-data');
export const FRESH_PROFILE_DIR = join(CACHE_DIR, 'chrome-fresh');
export const PROFILE_SYNC_STATE_FILE = join(CACHE_DIR, 'chrome-profile-sync.json');
export const OWNER_TOKEN_ENV = 'BROWSER_TOOLS_OWNER_TOKEN';
export const OWNER_ID_ENV = 'BROWSER_TOOLS_OWNER_ID';
export const OWNER_TOKEN_HASH_ALGORITHM = 'sha256';
export const PORT_LOCK_STALE_MS = 30000;

export function agentConfigRoot() {
  return process.env.AGENT_CONFIG_DIR || join(homedir(), '.agents');
}

export function browserToolsConfigDir() {
  return process.env.BROWSER_TOOLS_CONFIG_DIR || join(agentConfigRoot(), 'browser-tools');
}

function resolveBrowserToolsConfigDir(configDir = browserToolsConfigDir()) {
  return configDir || browserToolsConfigDir();
}

export function browserToolsConfigFile(configDir = browserToolsConfigDir()) {
  return join(resolveBrowserToolsConfigDir(configDir), 'config.json');
}

export function browserToolsProfilesConfigFile(configDir = browserToolsConfigDir()) {
  return browserToolsConfigFile(configDir);
}

export function profileDataDirForPort(port = DEFAULT_PORT) {
  return join(CACHE_DIR, `chrome-data-${normalizePort(port)}`);
}

export function freshProfileDirForPort(port = DEFAULT_PORT) {
  return join(CACHE_DIR, `chrome-fresh-${normalizePort(port)}`);
}

export function profileSyncStateFileForPort(port = DEFAULT_PORT) {
  return join(CACHE_DIR, `chrome-profile-sync-${normalizePort(port)}.json`);
}

const PROFILE_SYNC_ITEMS = [
  { path: 'Cookies', type: 'file' },
  { path: 'Cookies-journal', type: 'file' },
  { path: 'Network/Cookies', type: 'file' },
  { path: 'Network/Cookies-journal', type: 'file' },
  { path: 'Network/Network Persistent State', type: 'file' },
  { path: 'Account Web Data', type: 'file' },
  { path: 'Account Web Data-journal', type: 'file' },
  { path: 'Safe Browsing Cookies', type: 'file' },
  { path: 'Safe Browsing Cookies-journal', type: 'file' },
  { path: 'Preferences', type: 'file' },
  { path: 'Secure Preferences', type: 'file' },
  { path: 'Local Storage', type: 'dir' },
  { path: 'Session Storage', type: 'dir' },
  { path: 'Storage', type: 'dir' },
  { path: 'TransportSecurity', type: 'file' },
  { path: 'Trust Tokens', type: 'file' },
  { path: 'Extension Cookies', type: 'file' },
  { path: 'Extension Cookies-journal', type: 'file' },
  { path: 'Extensions', type: 'dir' },
  { path: 'Extension State', type: 'dir' },
  { path: 'Extension Rules', type: 'dir' },
  { path: 'Extension Scripts', type: 'dir' },
  { path: 'DNR Extension Rules', type: 'dir' },
  { path: 'Local Extension Settings', type: 'dir' },
  { path: 'Managed Extension Settings', type: 'dir' },
  { path: 'Sync Extension Settings', type: 'dir' },
];

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensureCacheDir() {
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CACHE_DIR, 0o700);
  } catch {
    // Best effort. Existing permissions should not block browser use.
  }
}

function writePrivateFile(file, content) {
  writeFileSync(file, content, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort. The owner token is not written in plain text, but state still belongs to one local agent.
  }
}

export function optionValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return true;
  return value;
}

export function hasFlag(args, name) {
  return args.includes(name);
}

export function normalizePort(value = DEFAULT_PORT) {
  const port = Number.parseInt(String(value ?? DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${value}`);
  }
  return port;
}

export function parsePort(args, fallback = DEFAULT_PORT) {
  return normalizePort(optionValue(args, '--port', fallback));
}

function normalizeOwnerValue(value) {
  if (value === undefined || value === null || value === true) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function generateOwnerToken() {
  return randomUUID();
}

export function ownerTokenHash(ownerToken) {
  const token = normalizeOwnerValue(ownerToken);
  if (!token) throw new Error('Missing browser owner token');
  return createHash(OWNER_TOKEN_HASH_ALGORITHM).update(token, 'utf8').digest('hex');
}

export function parseOwnerToken(args, fallback = process.env[OWNER_TOKEN_ENV] || null) {
  return normalizeOwnerValue(optionValue(args, '--owner-token', fallback));
}

export function parseOwnerId(args, fallback = process.env[OWNER_ID_ENV] || null) {
  return normalizeOwnerValue(optionValue(args, '--owner-id', optionValue(args, '--agent-id', fallback)));
}

export function stripBrowserSessionArgs(args, { stripPort = true, stripPositionalPort = false } = {}) {
  const stripped = [];
  const optionsWithValues = new Set(['--owner-token', '--owner-id', '--agent-id']);
  if (stripPort) optionsWithValues.add('--port');

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (optionsWithValues.has(arg)) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1;
      continue;
    }
    if (stripPositionalPort && /^\d{4,5}$/.test(arg)) continue;
    stripped.push(arg);
  }

  return stripped;
}

function buildOwnerState({ ownerToken, ownerId = null }) {
  return {
    ownerId: normalizeOwnerValue(ownerId),
    ownerTokenHash: ownerTokenHash(ownerToken),
    ownerTokenHashAlgorithm: OWNER_TOKEN_HASH_ALGORITHM,
  };
}

export function managedBrowserOwnershipSafety({ state, ownerToken }) {
  if (!state || state.managedBy !== 'browser-tools') {
    return { ok: false, reason: 'missing-managed-state' };
  }
  if (!state.ownerTokenHash) {
    return { ok: false, reason: 'missing-state-owner-token', ownerId: state.ownerId || null };
  }
  const token = normalizeOwnerValue(ownerToken);
  if (!token) {
    return { ok: false, reason: 'missing-owner-token', ownerId: state.ownerId || null };
  }
  if (ownerTokenHash(token) !== state.ownerTokenHash) {
    return { ok: false, reason: 'owner-token-mismatch', ownerId: state.ownerId || null };
  }
  return { ok: true, ownerId: state.ownerId || null };
}

export function pidFileForPort(port) {
  return join(CACHE_DIR, `chrome-${normalizePort(port)}.pid`);
}

export function stateFileForPort(port) {
  return join(CACHE_DIR, `chrome-${normalizePort(port)}.json`);
}

export function portLockDirForPort(port) {
  return join(CACHE_DIR, `chrome-${normalizePort(port)}.lock`);
}

export function chromePaths(port = DEFAULT_PORT) {
  return {
    chromeBin: CHROME_BIN,
    chromeSourceDir: CHROME_SRC,
    cacheDir: CACHE_DIR,
    profileDataDir: profileDataDirForPort(port),
    freshProfileDir: freshProfileDirForPort(port),
    pidFile: pidFileForPort(port),
    stateFile: stateFileForPort(port),
  };
}

export async function browserWSEndpoint(port = DEFAULT_PORT, timeoutMs = CONNECT_PROBE_TIMEOUT_MS) {
  const normalizedPort = normalizePort(port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://localhost:${normalizedPort}/json/version`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForChromeReady(
  port = DEFAULT_PORT,
  { timeoutMs = CHROME_READY_TIMEOUT_MS, intervalMs = 250, probeTimeoutMs = CHROME_READY_PROBE_TIMEOUT_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    if (await browserWSEndpoint(port, Math.min(probeTimeoutMs, remainingMs))) return true;
    const sleepMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return false;
}

export function profileCopyReady(profileName, profileDataDir = PROFILE_DST) {
  if (!profileName) return false;
  const profileDir = join(profileDataDir, profileName);
  return existsSync(profileDataDir) &&
    existsSync(join(profileDataDir, 'Local State')) &&
    existsSync(profileDir) &&
    profileAuthStateReady(profileDir);
}

export function profileAuthStateReady(profileDir) {
  return existsSync(join(profileDir, 'Cookies')) ||
    existsSync(join(profileDir, 'Network', 'Cookies')) ||
    existsSync(join(profileDir, 'Local Storage'));
}

export function readProfileSyncState(port = null) {
  try {
    const stateFile = port === null ? PROFILE_SYNC_STATE_FILE : profileSyncStateFileForPort(port);
    return JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch {
    return null;
  }
}

export function readManagedStateForPort(port = DEFAULT_PORT) {
  return readManagedState(stateFileForPort(port));
}

export function cleanupStaleManagedStateForPort(port = DEFAULT_PORT) {
  const normalizedPort = normalizePort(port);
  const paths = chromePaths(normalizedPort);
  if (!existsSync(paths.pidFile) && !existsSync(paths.stateFile)) return false;

  if (!existsSync(paths.pidFile) || !existsSync(paths.stateFile)) {
    rmSync(paths.pidFile, { force: true });
    rmSync(paths.stateFile, { force: true });
    return true;
  }

  const pid = Number.parseInt(readFileSync(paths.pidFile, 'utf-8').trim(), 10);
  if (!Number.isInteger(pid) || !processExists(pid)) {
    rmSync(paths.pidFile, { force: true });
    rmSync(paths.stateFile, { force: true });
    return true;
  }

  return false;
}

export function acquirePortLock(port = DEFAULT_PORT, { ownerId = null, staleMs = PORT_LOCK_STALE_MS } = {}) {
  const normalizedPort = normalizePort(port);
  ensureCacheDir();
  const lockDir = portLockDirForPort(normalizedPort);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writePrivateFile(join(lockDir, 'lock.json'), JSON.stringify({
        pid: process.pid,
        port: normalizedPort,
        ownerId: normalizeOwnerValue(ownerId),
        createdAt: new Date().toISOString(),
      }, null, 2));
      return {
        port: normalizedPort,
        lockDir,
        release() {
          rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const lockState = safeReadJson(join(lockDir, 'lock.json'));
      let stale = false;
      if (lockState?.pid && !processExists(Number(lockState.pid))) stale = true;
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > staleMs) stale = true;
      } catch {
        stale = true;
      }
      if (!stale) return null;
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  return null;
}

export function managedBrowserSafetyForPort(port = DEFAULT_PORT) {
  const normalizedPort = normalizePort(port);
  const paths = chromePaths(normalizedPort);
  if (!existsSync(paths.stateFile) || !existsSync(paths.pidFile)) {
    return { ok: false, reason: 'missing-managed-state' };
  }

  const pid = Number.parseInt(readFileSync(paths.pidFile, 'utf-8').trim(), 10);
  if (!Number.isInteger(pid)) return { ok: false, reason: 'invalid-managed-pid' };
  return verifyManagedChromeProcess({ pid, port: normalizedPort, state: readManagedState(paths.stateFile) });
}

export function validateProfileName(profileName) {
  if (!profileName || typeof profileName !== 'string') throw new Error('Missing Chrome profile folder name');
  if (profileName.includes('/') || profileName.includes('\\') || profileName === '.' || profileName === '..') {
    throw new Error(`Invalid Chrome profile folder name: ${profileName}`);
  }
  return profileName;
}

function safeReadJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function profileEntry(folder, info = {}) {
  return {
    folder,
    name: info.name || folder,
    account: info.user_name || null,
    gaiaName: info.gaia_name || null,
    lastUsed: Boolean(info.active_time),
    lastActive: false,
  };
}

export function discoverChromeProfiles({ sourceDir = CHROME_SRC } = {}) {
  const localState = safeReadJson(join(sourceDir, 'Local State'));
  const infoCache = localState?.profile?.info_cache || {};
  const lastActiveProfiles = new Set(localState?.profile?.last_active_profiles || []);
  const profiles = Object.entries(infoCache)
    .map(([folder, info]) => ({ ...profileEntry(folder, info), lastActive: lastActiveProfiles.has(folder) }))
    .sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }));

  if (profiles.length) return profiles;
  if (!existsSync(sourceDir)) return [];

  return readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((folder) => folder === 'Default' || /^Profile \d+$/.test(folder))
    .filter((folder) => existsSync(join(sourceDir, folder, 'Preferences')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((folder) => profileEntry(folder));
}

function buildAliases(profiles) {
  const aliasCandidates = new Map();
  for (const profile of profiles) {
    for (const alias of [profile.folder, profile.name, profile.account, profile.gaiaName].filter(Boolean)) {
      const key = String(alias).trim();
      if (!key) continue;
      if (!aliasCandidates.has(key)) aliasCandidates.set(key, new Set());
      aliasCandidates.get(key).add(profile.folder);
    }
  }

  const aliases = {};
  for (const [alias, folders] of aliasCandidates.entries()) {
    if (folders.size === 1) aliases[alias] = [...folders][0];
  }
  return aliases;
}

export function buildBrowserToolsConfig({ sourceDir = CHROME_SRC, existing = null } = {}) {
  const profiles = discoverChromeProfiles({ sourceDir });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceDir,
    profiles: Object.fromEntries(profiles.map((profile) => [profile.folder, profile])),
    aliases: buildAliases(profiles),
    taskProfiles: existing?.taskProfiles || {},
  };
}

export function buildChromeProfilesConfig(options = {}) {
  return buildBrowserToolsConfig(options);
}

export function readBrowserToolsConfig({ configDir = browserToolsConfigDir() } = {}) {
  return safeReadJson(browserToolsConfigFile(resolveBrowserToolsConfigDir(configDir)));
}

export function readChromeProfilesConfig(options = {}) {
  return readBrowserToolsConfig(options);
}

export function writeBrowserToolsConfig(config, { configDir = browserToolsConfigDir() } = {}) {
  const effectiveConfigDir = resolveBrowserToolsConfigDir(configDir);
  mkdirSync(effectiveConfigDir, { recursive: true });
  writeFileSync(browserToolsConfigFile(effectiveConfigDir), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function writeChromeProfilesConfig(config, options = {}) {
  return writeBrowserToolsConfig(config, options);
}

export function ensureBrowserToolsConfig({ configDir = browserToolsConfigDir(), sourceDir = CHROME_SRC, refresh = false } = {}) {
  const effectiveConfigDir = resolveBrowserToolsConfigDir(configDir);
  const existing = readBrowserToolsConfig({ configDir: effectiveConfigDir });
  if (!refresh && existing?.version === 1 && existing.profiles && existing.aliases && existing.taskProfiles) return existing;
  return writeBrowserToolsConfig(buildBrowserToolsConfig({ sourceDir, existing }), { configDir: effectiveConfigDir });
}

export function ensureChromeProfilesConfig(options = {}) {
  return ensureBrowserToolsConfig(options);
}

export function activeChromeProfiles(options = {}) {
  const config = ensureBrowserToolsConfig(options);
  return Object.values(config.profiles || {}).filter((profile) => profile.lastActive);
}

export function resolveChromeProfileReference(profileRef, { configDir = browserToolsConfigDir(), sourceDir = CHROME_SRC, refresh = false } = {}) {
  validateProfileName(profileRef);
  const config = ensureBrowserToolsConfig({ configDir, sourceDir, refresh });
  const profiles = config.profiles || {};
  const aliases = config.aliases || {};
  if (profiles[profileRef]) return validateProfileName(profileRef);
  if (aliases[profileRef]) return validateProfileName(aliases[profileRef]);

  const wanted = profileRef.toLowerCase();
  const matches = Object.values(profiles).filter((profile) => [
    profile.folder,
    profile.name,
    profile.account,
    profile.gaiaName,
  ].filter(Boolean).some((value) => String(value).toLowerCase() === wanted));

  const folders = [...new Set(matches.map((profile) => profile.folder))];
  if (folders.length === 1) return validateProfileName(folders[0]);
  if (folders.length > 1) throw new Error(`Ambiguous Chrome profile reference: ${profileRef}. Use the Chrome profile folder name.`);

  return validateProfileName(profileRef);
}

export function setTaskProfiles(taskName, profileRefs, { configDir = browserToolsConfigDir(), sourceDir = CHROME_SRC } = {}) {
  if (!taskName || typeof taskName !== 'string') throw new Error('Missing task name');
  const profiles = profileRefs.map((profileRef) => resolveChromeProfileReference(profileRef, { configDir, sourceDir }));
  if (!profiles.length) throw new Error('At least one --profile is required');
  const config = ensureBrowserToolsConfig({ configDir, sourceDir });
  config.taskProfiles = config.taskProfiles || {};
  config.taskProfiles[taskName] = {
    profiles,
    defaultProfile: profiles[0],
    updatedAt: new Date().toISOString(),
  };
  writeBrowserToolsConfig(config, { configDir });
  return config.taskProfiles[taskName];
}

export function taskProfileConfig(taskName, { configDir = browserToolsConfigDir(), sourceDir = CHROME_SRC } = {}) {
  if (!taskName) return null;
  const config = ensureBrowserToolsConfig({ configDir, sourceDir });
  return config.taskProfiles?.[taskName] || null;
}

export function resolveTaskProfile(taskName, options = {}) {
  const entry = taskProfileConfig(taskName, options);
  return entry?.defaultProfile || entry?.profiles?.[0] || null;
}

export function profileSyncItems() {
  return PROFILE_SYNC_ITEMS.map((item) => ({ ...item }));
}

export function profileSyncRsyncCommands(profileName, { sourceDir = CHROME_SRC, destDir = PROFILE_DST, checkExists = false } = {}) {
  const safeProfileName = validateProfileName(profileName);
  const sourceProfileDir = join(sourceDir, safeProfileName);
  const destProfileDir = join(destDir, safeProfileName);
  const commands = [];

  const localStateSource = join(sourceDir, 'Local State');
  if (!checkExists || existsSync(localStateSource)) {
    commands.push({ args: ['-a', localStateSource, `${destDir}/`], dest: destDir, item: 'Local State' });
  }

  for (const item of PROFILE_SYNC_ITEMS) {
    const sourcePath = join(sourceProfileDir, item.path);
    if (checkExists && !existsSync(sourcePath)) continue;

    const destPath = join(destProfileDir, item.path);
    if (item.type === 'dir') {
      commands.push({ args: ['-a', '--delete', `${sourcePath}/`, `${destPath}/`], dest: destPath, item: item.path });
    } else {
      commands.push({ args: ['-a', sourcePath, `${dirname(destPath)}/`], dest: dirname(destPath), item: item.path });
    }
  }

  return commands;
}

export function syncChromeProfile(profileName, { force = false, port = DEFAULT_PORT, destDir = profileDataDirForPort(port) } = {}) {
  if (!profileName) return { status: 'skipped', profileDir: null };
  validateProfileName(profileName);
  ensureCacheDir();

  if (!force && profileCopyReady(profileName, destDir)) {
    removeChromeProfileLocks(destDir);
    return { status: 'cached', profileDir: destDir, state: readProfileSyncState(port) };
  }

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  const commands = profileSyncRsyncCommands(profileName, { destDir, checkExists: true });
  const results = [];
  const copiedItems = [];
  for (const command of commands) {
    mkdirSync(command.dest, { recursive: true });
    const result = spawnSync('rsync', command.args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    results.push(result);
    copiedItems.push(command.item);
    if (result.status && result.status !== 0) {
      console.error(`[browser-control] Profile sync step returned ${result.status}; continuing with copied profile`);
    }
  }

  removeChromeProfileLocks(destDir);
  const rsyncStatuses = results.map((result) => result.status || 0);
  const state = {
    profileName,
    profileDir: destDir,
    sourceDir: CHROME_SRC,
    syncedAt: new Date().toISOString(),
    rsyncStatus: rsyncStatuses.length ? Math.max(...rsyncStatuses) : 0,
    rsyncStatuses,
    copiedItems,
    syncScope: 'auth-minimal',
  };
  writePrivateFile(profileSyncStateFileForPort(port), JSON.stringify(state, null, 2));
  return { status: 'synced', profileDir: destDir, state };
}

export function removeChromeProfileLocks(profileDir) {
  if (!existsSync(profileDir)) return;
  const lockNames = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie']);
  const stack = [profileDir];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (lockNames.has(entry.name)) {
        rmSync(entryPath, { force: true });
        continue;
      }
      if (entry.isDirectory()) stack.push(entryPath);
    }
  }
}

export function chromeLaunchArgs({ port = DEFAULT_PORT, profileName = null, managedToken = null, userDataDir = null } = {}) {
  const normalizedPort = normalizePort(port);
  const launchUserDataDir = userDataDir || (profileName ? profileDataDirForPort(normalizedPort) : freshProfileDirForPort(normalizedPort));
  const args = [
    `--remote-debugging-port=${normalizedPort}`,
    `--user-data-dir=${launchUserDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
  ];
  if (managedToken) args.push(`--pi-browser-tools-managed=${managedToken}`);
  if (profileName) args.push(`--profile-directory=${profileName}`);
  return args;
}

export function managedBrowserForUserDataDir(userDataDir) {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8' });
  if (result.error || result.status !== 0) return null;

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    if (!command.includes(CHROME_BIN)) continue;
    if (!command.includes(`--user-data-dir=${userDataDir}`)) continue;
    if (!command.includes('--pi-browser-tools-managed=')) continue;
    const portMatch = command.match(/--remote-debugging-port=(\d+)/);
    if (!portMatch) continue;
    return { pid, port: normalizePort(portMatch[1]), command };
  }

  return null;
}

export function launchChrome({ port = DEFAULT_PORT, profileName = null, userDataDir = null, ownerToken = null, ownerId = null } = {}) {
  ensureCacheDir();
  const normalizedPort = normalizePort(port);
  const launchUserDataDir = userDataDir || (profileName ? profileDataDirForPort(normalizedPort) : freshProfileDirForPort(normalizedPort));
  const managedToken = randomUUID();
  const effectiveOwnerToken = normalizeOwnerValue(ownerToken) || generateOwnerToken();
  const args = chromeLaunchArgs({ port: normalizedPort, profileName, managedToken, userDataDir: launchUserDataDir });
  const proc = spawn(CHROME_BIN, args, {
    detached: true,
    stdio: 'ignore',
  });
  writePrivateFile(pidFileForPort(normalizedPort), String(proc.pid));
  writePrivateFile(stateFileForPort(normalizedPort), JSON.stringify({
    managedBy: 'browser-tools',
    pid: proc.pid,
    port: normalizedPort,
    profileName: profileName || null,
    userDataDir: launchUserDataDir,
    managedToken,
    ...buildOwnerState({ ownerToken: effectiveOwnerToken, ownerId }),
    args,
    startedAt: new Date().toISOString(),
  }, null, 2));
  proc.unref();
  return proc;
}

export async function findAvailablePort(startPort = DEFAULT_PORT, { maxAttempts = 100 } = {}) {
  let port = normalizePort(startPort);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (existsSync(portLockDirForPort(port))) {
      port = normalizePort(port + 1);
      continue;
    }
    cleanupStaleManagedStateForPort(port);
    if (
      !(await browserWSEndpoint(port)) &&
      !existsSync(stateFileForPort(port)) &&
      !existsSync(pidFileForPort(port))
    ) return port;
    port = normalizePort(port + 1);
  }
  throw new Error(`No available Chrome debug port found starting at ${startPort}`);
}

export async function startChrome({
  port = DEFAULT_PORT,
  profileName = null,
  taskName = null,
  forceProfileSync = false,
  autoAllocatePort = false,
  ownerToken = null,
  ownerId = null,
} = {}) {
  let normalizedPort = normalizePort(port);
  const providedOwnerToken = normalizeOwnerValue(ownerToken);
  const effectiveOwnerToken = providedOwnerToken || generateOwnerToken();
  const normalizedOwnerId = normalizeOwnerValue(ownerId);
  const taskProfileName = !profileName && taskName ? resolveTaskProfile(taskName) : null;
  const requestedProfileName = profileName || taskProfileName;
  const resolvedProfileName = requestedProfileName ? resolveChromeProfileReference(requestedProfileName) : null;
  ensureCacheDir();

  while (true) {
    const portLock = acquirePortLock(normalizedPort, { ownerId: normalizedOwnerId });
    if (!portLock) {
      if (!autoAllocatePort) throw new Error(`Port :${normalizedPort} is locked by another Browser Tools start operation. Use a different --port or retry.`);
      normalizedPort = await findAvailablePort(normalizedPort + 1);
      continue;
    }

    try {
      cleanupStaleManagedStateForPort(normalizedPort);

      if (await browserWSEndpoint(normalizedPort)) {
        const safety = managedBrowserSafetyForPort(normalizedPort);
        if (!autoAllocatePort) {
          if (!safety.ok) {
            throw new Error(
              `Chrome DevTools is already listening on :${normalizedPort}, but it is not a Browser Tools managed browser (${safety.reason}). Use a different --port or stop that browser manually.`,
            );
          }
          const state = readManagedStateForPort(normalizedPort);
          const ownership = managedBrowserOwnershipSafety({ state, ownerToken: providedOwnerToken });
          if (!ownership.ok) {
            throw new Error(
              `Chrome DevTools on :${normalizedPort} is owned by another Browser Tools agent (${ownership.reason}). Use a different --port or provide the correct --owner-token.`,
            );
          }
          return {
            status: 'reused',
            port: normalizedPort,
            ownerToken: effectiveOwnerToken,
            ownerId: ownership.ownerId,
            ownerTokenGenerated: false,
          };
        }
        normalizedPort = await findAvailablePort(normalizedPort + 1);
        continue;
      }

      const paths = chromePaths(normalizedPort);
      if (existsSync(paths.pidFile) || existsSync(paths.stateFile)) {
        const safety = managedBrowserSafetyForPort(normalizedPort);
        if (!autoAllocatePort) {
          throw new Error(
            `Browser Tools state already exists for :${normalizedPort}, but CDP is not responding (${safety.reason}). Use the owning token with scripts/stop.mjs --port ${normalizedPort} or choose a different --port.`,
          );
        }
        normalizedPort = await findAvailablePort(normalizedPort + 1);
        continue;
      }

      const userDataDir = resolvedProfileName ? profileDataDirForPort(normalizedPort) : freshProfileDirForPort(normalizedPort);
      const existingManagedBrowser = managedBrowserForUserDataDir(userDataDir);
      if (existingManagedBrowser) {
        if (existingManagedBrowser.port === normalizedPort) {
          throw new Error(
            `Managed Chrome PID ${existingManagedBrowser.pid} owns :${normalizedPort}, but CDP is not responding. Run scripts/stop.mjs --port ${normalizedPort} with the owner token and retry.`,
          );
        }
        throw new Error(
          `Profile data dir is already in use by managed Chrome PID ${existingManagedBrowser.pid} on :${existingManagedBrowser.port}. Use --port ${existingManagedBrowser.port} with the owner token or stop it first.`,
        );
      }

      let profileSync = null;
      if (resolvedProfileName) {
        const willSync = forceProfileSync || !profileCopyReady(resolvedProfileName, userDataDir);
        if (willSync) console.error('⟳ Syncing Chrome profile auth state...');
        profileSync = syncChromeProfile(resolvedProfileName, { force: forceProfileSync, port: normalizedPort, destDir: userDataDir });
        if (profileSync.status === 'cached') {
          console.error(`✓ Using cached profile copy at ${userDataDir} (use --sync to refresh; if a logged-in site appears logged out, stop with --clean and restart with --sync)`);
        } else if (profileSync.status === 'synced') {
          console.error(`✓ Profile synced to ${userDataDir}`);
        }
      }
      const proc = launchChrome({
        port: normalizedPort,
        profileName: resolvedProfileName,
        userDataDir,
        ownerToken: effectiveOwnerToken,
        ownerId: normalizedOwnerId,
      });
      const ready = await waitForChromeReady(normalizedPort, { timeoutMs: CHROME_READY_TIMEOUT_MS });
      if (!ready) {
        stopChrome({ port: normalizedPort, ownerToken: effectiveOwnerToken, ignorePortLock: true });
        throw new Error(`Failed to connect to Chrome after ${Math.round(CHROME_READY_TIMEOUT_MS / 1000)}s`);
      }
      return {
        status: 'started',
        port: normalizedPort,
        pid: proc.pid,
        profileName: resolvedProfileName,
        requestedProfileName,
        taskName,
        profileSync,
        ownerToken: effectiveOwnerToken,
        ownerId: normalizedOwnerId,
        ownerTokenGenerated: !providedOwnerToken,
      };
    } finally {
      portLock.release();
    }
  }
}

export function stopChrome({ port = DEFAULT_PORT, clean = false, dryRun = false, ownerToken = null, ignorePortLock = false } = {}) {
  const normalizedPort = normalizePort(port);
  const paths = chromePaths(normalizedPort);

  if (!ignorePortLock && existsSync(portLockDirForPort(normalizedPort))) {
    return { status: 'locked', port: normalizedPort, cleaned: false, reason: 'port-start-lock-present' };
  }

  const hasPidFile = existsSync(paths.pidFile);
  const hasStateFile = existsSync(paths.stateFile);
  if (!hasPidFile && !hasStateFile) {
    return { status: 'missing', port: normalizedPort, cleaned: false };
  }
  if (!hasPidFile || !hasStateFile) {
    rmSync(paths.pidFile, { force: true });
    rmSync(paths.stateFile, { force: true });
    return { status: 'not-managed', port: normalizedPort, cleaned: false, reason: 'incomplete-managed-state' };
  }

  const pid = Number.parseInt(readFileSync(paths.pidFile, 'utf-8').trim(), 10);
  const state = readManagedState(paths.stateFile);
  const safety = verifyManagedChromeProcess({ pid, port: normalizedPort, state });
  if (!safety.ok && safety.reason === 'process-not-found') {
    rmSync(paths.pidFile, { force: true });
    rmSync(paths.stateFile, { force: true });
    let cleaned = false;
    if (clean && isBrowserToolsUserDataDir(state?.userDataDir)) {
      rmSync(state.userDataDir, { recursive: true, force: true });
      cleaned = true;
    }
    return { status: 'already-gone', port: normalizedPort, pid, cleaned };
  }

  const ownership = managedBrowserOwnershipSafety({ state, ownerToken });
  if (!ownership.ok) {
    return {
      status: 'not-owned',
      port: normalizedPort,
      pid,
      cleaned: false,
      reason: ownership.reason,
      ownerId: ownership.ownerId,
      command: safety.command,
    };
  }

  if (!safety.ok) {
    rmSync(paths.pidFile, { force: true });
    rmSync(paths.stateFile, { force: true });
    return {
      status: 'not-managed',
      port: normalizedPort,
      pid,
      cleaned: false,
      reason: safety.reason,
      command: safety.command,
    };
  }

  if (dryRun) {
    return { status: 'would-stop', port: normalizedPort, pid, cleaned: false, command: safety.command, ownerId: ownership.ownerId };
  }

  let status = 'stopped';
  let error = null;

  try {
    process.kill(pid, 'SIGTERM');
    if (!waitForProcessExit(pid, 2000)) {
      const killSafety = verifyManagedChromeProcess({ pid, port: normalizedPort, state });
      if (killSafety.ok) {
        process.kill(pid, 'SIGKILL');
        waitForProcessExit(pid, 1000);
        status = 'killed';
      } else {
        status = 'failed';
        error = new Error(`Refusing SIGKILL after failed safety recheck: ${killSafety.reason}`);
      }
    }
  } catch (e) {
    if (e.code === 'ESRCH') status = 'already-gone';
    else {
      status = 'failed';
      error = e;
    }
  }

  rmSync(paths.pidFile, { force: true });
  rmSync(paths.stateFile, { force: true });
  let cleaned = false;
  if (clean && isBrowserToolsUserDataDir(state?.userDataDir)) {
    rmSync(state.userDataDir, { recursive: true, force: true });
    cleaned = true;
  }

  return { status, port: normalizedPort, pid, cleaned, error };
}

function readManagedState(stateFile) {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch {
    return null;
  }
}

function commandForPid(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
  if (result.error || result.status !== 0) return null;
  const command = result.stdout.trim();
  return command || null;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    sleepSync(100);
  }
  return !processExists(pid);
}

function verifyManagedChromeProcess({ pid, port, state }) {
  const command = commandForPid(pid);
  if (!command) return { ok: false, reason: 'process-not-found' };
  return managedChromeCommandSafety({ pid, port, state, command });
}

export function isBrowserToolsUserDataDir(userDataDir) {
  if (!userDataDir || typeof userDataDir !== 'string') return false;
  return userDataDir === PROFILE_DST ||
    userDataDir === FRESH_PROFILE_DIR ||
    userDataDir.startsWith(`${CACHE_DIR}/chrome-data-`) ||
    userDataDir.startsWith(`${CACHE_DIR}/chrome-fresh-`);
}

export function managedChromeCommandSafety({ pid, port, state, command }) {
  if (!state || state.managedBy !== 'browser-tools') {
    return { ok: false, reason: 'missing-managed-state', command };
  }
  if (Number(state.pid) !== Number(pid) || Number(state.port) !== Number(port)) {
    return { ok: false, reason: 'state-mismatch', command };
  }
  if (!state.managedToken) {
    return { ok: false, reason: 'missing-managed-token', command };
  }
  if (!isBrowserToolsUserDataDir(state.userDataDir)) {
    return { ok: false, reason: 'state-user-data-dir-mismatch', command };
  }

  const expectedDebugPort = `--remote-debugging-port=${port}`;
  const expectedToken = `--pi-browser-tools-managed=${state.managedToken}`;
  const expectedUserDataDir = `--user-data-dir=${state.userDataDir}`;
  const expectedArgs = Array.isArray(state.args) ? state.args : [];
  const isChrome = command.includes('Google Chrome') || command.includes(CHROME_BIN);

  if (!isChrome) return { ok: false, reason: 'not-chrome-process', command };
  if (!command.includes(expectedDebugPort)) return { ok: false, reason: 'debug-port-mismatch', command };
  if (!command.includes(expectedUserDataDir)) return { ok: false, reason: 'user-data-dir-mismatch', command };
  if (!command.includes(expectedToken)) return { ok: false, reason: 'managed-token-mismatch', command };
  if (!expectedArgs.includes(expectedDebugPort)) return { ok: false, reason: 'state-debug-port-missing', command };
  if (!expectedArgs.includes(expectedUserDataDir)) return { ok: false, reason: 'state-user-data-dir-missing', command };
  if (!expectedArgs.includes(expectedToken)) return { ok: false, reason: 'state-managed-token-missing', command };

  return { ok: true, command };
}

export async function connectBrowser(port = DEFAULT_PORT, options = {}) {
  const normalizedPort = normalizePort(port);
  const { ownerToken = parseOwnerToken(process.argv.slice(2)), ...puppeteerOptions } = options;
  const safety = managedBrowserSafetyForPort(normalizedPort);
  if (!safety.ok) {
    throw new Error(`Refusing to connect to unmanaged Chrome on :${normalizedPort}: ${safety.reason}`);
  }
  const state = readManagedStateForPort(normalizedPort);
  const ownership = managedBrowserOwnershipSafety({ state, ownerToken });
  if (!ownership.ok) {
    throw new Error(`Refusing to connect to Browser Tools Chrome on :${normalizedPort}: ${ownership.reason}`);
  }
  return puppeteer.connect({
    browserURL: `http://localhost:${normalizedPort}`,
    defaultViewport: null,
    ...puppeteerOptions,
  });
}

export async function withBrowser(port, callback, options = {}) {
  const browser = await connectBrowser(port, options);
  try {
    return await callback(browser);
  } finally {
    browser.disconnect();
  }
}

export async function activePage(browser) {
  const pages = await browser.pages();
  const page = pages.at(-1);
  if (!page) throw new Error('No active tab found');
  return page;
}

export async function dedicatedPage(browser, urlMatcher, createUrl = null) {
  const pages = await browser.pages();
  let page = pages.find((candidate) => urlMatcher(candidate.url()));
  if (!page) {
    page = await browser.newPage({ background: true });
    if (createUrl) await page.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  }
  return page;
}

export function timestampedTmpPath(prefix, extension) {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]/g, '-');
  const safeExtension = extension.replace(/^\./, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(tmpdir(), `${safePrefix}-${timestamp}.${safeExtension}`);
}

export function fileExists(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
