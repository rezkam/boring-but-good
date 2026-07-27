import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

export const DEFAULT_PORT = 9222;
export const CONNECT_PROBE_TIMEOUT_MS = 3000;
export const CHROME_READY_TIMEOUT_MS = 15000;
export const CHROME_READY_PROBE_TIMEOUT_MS = 250;
export const DEFAULT_CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DEFAULT_CHROME_SRC = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
export const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'pi-browser-tools');
export const DEFAULT_ARTIFACT_DIR = tmpdir();

// Legacy path constants are retained for older scripts that imported the pre-config Browser Tools API.
// New runtime code should use browserToolsRuntimeConfig() and path helpers so env and private config overrides are honored.
export const CHROME_BIN = DEFAULT_CHROME_BIN;
export const CHROME_SRC = DEFAULT_CHROME_SRC;
export const CACHE_DIR = DEFAULT_CACHE_DIR;
export const PROFILE_DST = join(CACHE_DIR, 'chrome-data');
export const FRESH_PROFILE_DIR = join(CACHE_DIR, 'chrome-fresh');
export const PROFILE_SYNC_STATE_FILE = join(CACHE_DIR, 'chrome-profile-sync.json');
export const OWNER_TOKEN_ENV = 'BROWSER_TOOLS_OWNER_TOKEN';
export const OWNER_ID_ENV = 'BROWSER_TOOLS_OWNER_ID';
export const OWNER_TOKEN_HASH_ALGORITHM = 'sha256';
export const PORT_LOCK_STALE_MS = 30000;

// Concurrency guardrails. A managed Chrome costs roughly 800 MB across a browser process and its
// helpers, so an unbounded fan-out of `start` calls exhausts memory long before it exhausts ports.
// The cap is deliberately small: agents should reuse or stop a browser, not accumulate them.
export const DEFAULT_MAX_MANAGED_BROWSERS = 5;
export const MAX_BROWSERS_ENV = 'BROWSER_TOOLS_MAX_BROWSERS';
// A managed browser older than this is almost certainly a leftover from a finished agent session.
export const STALE_BROWSER_AGE_MS = 2 * 60 * 60 * 1000;
export const REAP_HINT = 'Run scripts/stop.mjs --reap to sweep managed browsers that no lifecycle file accounts for.';

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

// Compatibility alias for the earlier Chrome profiles config file name.
export function browserToolsProfilesConfigFile(configDir = browserToolsConfigDir()) {
  return browserToolsConfigFile(configDir);
}

export function expandHomePath(value) {
  if (!value || typeof value !== 'string') return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

export function browserToolsRuntimeConfig({ configDir = browserToolsConfigDir() } = {}) {
  const effectiveConfigDir = resolveBrowserToolsConfigDir(configDir);
  const config = safeReadJson(browserToolsConfigFile(effectiveConfigDir)) || {};
  return {
    configDir: effectiveConfigDir,
    configFile: browserToolsConfigFile(effectiveConfigDir),
    chromeBin: expandHomePath(process.env.BROWSER_TOOLS_CHROME_BIN || config.browser?.chromeBin || config.chromeBin || DEFAULT_CHROME_BIN),
    chromeSourceDir: expandHomePath(process.env.BROWSER_TOOLS_CHROME_SOURCE_DIR || config.directories?.chromeSourceDir || config.sourceDir || DEFAULT_CHROME_SRC),
    cacheDir: expandHomePath(process.env.BROWSER_TOOLS_CACHE_DIR || config.directories?.cacheDir || DEFAULT_CACHE_DIR),
    artifactDir: expandHomePath(process.env.BROWSER_TOOLS_ARTIFACT_DIR || config.directories?.artifactDir || DEFAULT_ARTIFACT_DIR),
    maxBrowsers: config.browser?.maxBrowsers ?? config.maxBrowsers ?? null,
  };
}

export function browserToolsChromeBin(options = {}) {
  return browserToolsRuntimeConfig(options).chromeBin;
}

export function browserToolsChromeSourceDir(options = {}) {
  return browserToolsRuntimeConfig(options).chromeSourceDir;
}

export function browserToolsCacheDir(options = {}) {
  return browserToolsRuntimeConfig(options).cacheDir;
}

export function browserToolsArtifactDir(options = {}) {
  return browserToolsRuntimeConfig(options).artifactDir;
}

export function profileDataDirForPort(port = DEFAULT_PORT) {
  return join(browserToolsCacheDir(), `chrome-data-${normalizePort(port)}`);
}

export function freshProfileDirForPort(port = DEFAULT_PORT) {
  return join(browserToolsCacheDir(), `chrome-fresh-${normalizePort(port)}`);
}

export function profileSyncStateFileForPort(port = DEFAULT_PORT) {
  return join(browserToolsCacheDir(), `chrome-profile-sync-${normalizePort(port)}.json`);
}

const PROFILE_SYNC_ITEMS = [
  { path: 'Cookies', type: 'file' },
  { path: 'Cookies-journal', type: 'file' },
  { path: 'Network/Cookies', type: 'file' },
  { path: 'Network/Cookies-journal', type: 'file' },
  { path: 'Network/Network Persistent State', type: 'file' },
  { path: 'Account Web Data', type: 'file' },
  { path: 'Account Web Data-journal', type: 'file' },
  { path: 'Web Data', type: 'file' },
  { path: 'Web Data-journal', type: 'file' },
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

export function ensureCacheDir(cacheDir = browserToolsCacheDir()) {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(cacheDir, 0o700);
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

export function requiredOptionValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value after ${name}`);
  return value;
}

export function parsePositiveIntegerOption(args, name, fallback) {
  const value = optionValue(args, name, fallback);
  if (value === fallback) return fallback;
  if (value === true) throw new Error(`Missing ${name} value: expected a positive integer`);

  const normalized = String(value).trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`Invalid ${name} value: expected a positive integer, got "${value}"`);
  }

  return Number.parseInt(normalized, 10);
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
  return normalizePort(requiredOptionValue(args, '--port', fallback));
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
  return normalizeOwnerValue(requiredOptionValue(args, '--owner-token', fallback));
}

export function parseOwnerId(args, fallback = process.env[OWNER_ID_ENV] || null) {
  if (args.includes('--owner-id')) return normalizeOwnerValue(requiredOptionValue(args, '--owner-id', fallback));
  return normalizeOwnerValue(requiredOptionValue(args, '--agent-id', fallback));
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
  return join(browserToolsCacheDir(), `chrome-${normalizePort(port)}.pid`);
}

export function stateFileForPort(port) {
  return join(browserToolsCacheDir(), `chrome-${normalizePort(port)}.json`);
}

export function portLockDirForPort(port) {
  return join(browserToolsCacheDir(), `chrome-${normalizePort(port)}.lock`);
}

export function chromePaths(port = DEFAULT_PORT) {
  const runtime = browserToolsRuntimeConfig();
  return {
    chromeBin: runtime.chromeBin,
    chromeSourceDir: runtime.chromeSourceDir,
    cacheDir: runtime.cacheDir,
    artifactDir: runtime.artifactDir,
    configDir: runtime.configDir,
    configFile: runtime.configFile,
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

export function profileCopyReady(profileName, profileDataDir = profileDataDirForPort()) {
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
  const stateFile = port === null ? profileSyncStateFileForPort(DEFAULT_PORT) : profileSyncStateFileForPort(port);
  // This is a generated per-port cache file, not user config. A truncated or corrupt one should be
  // treated as a cache miss (forcing a fresh sync), never abort a launch, so swallow parse errors.
  try {
    return safeReadJson(stateFile);
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
      // A start that crashed mid-write can leave a partial or corrupt lock.json. Treat an unreadable
      // lock as having no metadata rather than throwing, so the age-based staleness check below can
      // still recover the port (and a fresh, possibly mid-write lock is left alone until it ages out).
      let lockState = null;
      try {
        lockState = safeReadJson(join(lockDir, 'lock.json'));
      } catch {
        lockState = null;
      }
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
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse JSON file ${file}: ${error.message}`, { cause: error });
    }
    throw new Error(`Failed to read JSON file ${file}: ${error.message}`, { cause: error });
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

export function discoverChromeProfiles({ sourceDir = browserToolsChromeSourceDir() } = {}) {
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

export function buildBrowserToolsConfig({ sourceDir = browserToolsChromeSourceDir(), existing = null } = {}) {
  const profiles = discoverChromeProfiles({ sourceDir });
  const existingDirectories = existing?.directories || {};
  const existingBrowser = existing?.browser || {};
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceDir,
    directories: {
      chromeSourceDir: existingDirectories.chromeSourceDir || sourceDir,
      cacheDir: existingDirectories.cacheDir || browserToolsCacheDir(),
      artifactDir: existingDirectories.artifactDir || browserToolsArtifactDir(),
    },
    browser: {
      chromeBin: existingBrowser.chromeBin || browserToolsChromeBin(),
    },
    profiles: Object.fromEntries(profiles.map((profile) => [profile.folder, profile])),
    aliases: buildAliases(profiles),
    taskProfiles: existing?.taskProfiles || {},
  };
}

// Compatibility wrappers for the earlier Chrome profiles config API.
// Keep them as direct aliases to the Browser Tools config layer.
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
  writePrivateFile(browserToolsConfigFile(effectiveConfigDir), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function writeChromeProfilesConfig(config, options = {}) {
  return writeBrowserToolsConfig(config, options);
}

export function ensureBrowserToolsConfig({ configDir = browserToolsConfigDir(), sourceDir = undefined, refresh = false } = {}) {
  const effectiveConfigDir = resolveBrowserToolsConfigDir(configDir);
  const existing = readBrowserToolsConfig({ configDir: effectiveConfigDir });
  if (!refresh && existing?.version === 1 && existing.profiles && existing.aliases && existing.taskProfiles && existing.directories && existing.browser) return existing;
  const effectiveSourceDir = sourceDir ?? browserToolsChromeSourceDir({ configDir: effectiveConfigDir });
  return writeBrowserToolsConfig(buildBrowserToolsConfig({ sourceDir: effectiveSourceDir, existing }), { configDir: effectiveConfigDir });
}

export function ensureChromeProfilesConfig(options = {}) {
  return ensureBrowserToolsConfig(options);
}

export function activeChromeProfiles(options = {}) {
  const config = ensureBrowserToolsConfig(options);
  return Object.values(config.profiles || {}).filter((profile) => profile.lastActive);
}

export function resolveChromeProfileReference(profileRef, { configDir = browserToolsConfigDir(), sourceDir = undefined, refresh = false } = {}) {
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

export function setTaskProfiles(taskName, profileRefs, { configDir = browserToolsConfigDir(), sourceDir = undefined } = {}) {
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

export function taskProfileConfig(taskName, { configDir = browserToolsConfigDir(), sourceDir = undefined } = {}) {
  if (!taskName) return null;
  const config = ensureBrowserToolsConfig({ configDir, sourceDir });
  return config.taskProfiles?.[taskName] || null;
}

export function resolveTaskProfile(taskName, options = {}) {
  const entry = taskProfileConfig(taskName, options);
  return entry?.defaultProfile || entry?.profiles?.[0] || null;
}

export function resolveStartProfileName({
  profileName = null,
  taskName = null,
  defaultProfileName = null,
  configDir = browserToolsConfigDir(),
  sourceDir = undefined,
  refresh = false,
} = {}) {
  const taskProfileName = !profileName && taskName ? resolveTaskProfile(taskName, { configDir, sourceDir }) : null;
  const requestedProfileName = profileName || taskProfileName || defaultProfileName || null;
  const resolvedProfileName = requestedProfileName ? resolveChromeProfileReference(requestedProfileName, { configDir, sourceDir, refresh }) : null;
  return {
    requestedProfileName,
    resolvedProfileName,
    source: profileName ? 'explicit' : (taskProfileName ? 'task' : (defaultProfileName ? 'default' : 'fresh')),
  };
}

export function profileSyncItems() {
  return PROFILE_SYNC_ITEMS.map((item) => ({ ...item }));
}

export function profileSyncRsyncCommands(profileName, { sourceDir = browserToolsChromeSourceDir(), destDir = profileDataDirForPort(), checkExists = false } = {}) {
  const safeProfileName = validateProfileName(profileName);
  const sourceProfileDir = join(sourceDir, safeProfileName);
  const destProfileDir = join(destDir, safeProfileName);
  const commands = [];

  if (checkExists) {
    let sourceProfileStat = null;
    try {
      sourceProfileStat = statSync(sourceProfileDir);
    } catch {
      throw new Error(`Chrome profile folder not found: ${sourceProfileDir}`);
    }
    if (!sourceProfileStat.isDirectory()) {
      throw new Error(`Chrome profile folder is not a directory: ${sourceProfileDir}`);
    }
  }

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

export function syncChromeProfile(profileName, { force = false, port = DEFAULT_PORT, sourceDir = browserToolsChromeSourceDir(), destDir = profileDataDirForPort(port), includeGoogle = false } = {}) {
  if (!profileName) return { status: 'skipped', profileDir: null };
  validateProfileName(profileName);
  ensureCacheDir();

  // Reuse a cached copy only when its Google-inclusion matches the request, so switching the flag
  // (or an older copy that predates it) forces a fresh sync instead of leaving the wrong identity in.
  // A copy whose Google strip did not fully succeed is never reused, so the strip is retried (and its
  // warning re-shown) instead of silently serving a clone that still carries the Google session.
  const cachedState = readProfileSyncState(port);
  const cachedMatches = cachedState
    && typeof cachedState.includeGoogle === 'boolean'
    && cachedState.includeGoogle === includeGoogle
    && (includeGoogle || cachedState.googleStripOk === true);
  if (!force && cachedMatches && profileCopyReady(profileName, destDir)) {
    removeChromeProfileLocks(destDir);
    return { status: 'cached', profileDir: destDir, state: cachedState };
  }

  const commands = profileSyncRsyncCommands(profileName, { sourceDir, destDir, checkExists: true });

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const results = [];
  const copiedItems = [];
  for (const command of commands) {
    mkdirSync(command.dest, { recursive: true });
    const result = spawnSync('rsync', command.args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`rsync failed for ${command.item}: terminated by signal ${result.signal}`);
    if (result.status !== 0) throw new Error(`rsync failed for ${command.item}: exit status ${result.status}`);
    results.push(result);
    copiedItems.push(command.item);
  }

  removeChromeProfileLocks(destDir);
  // Default: remove the Google session from the clone so a live copy cannot fork the source profile's
  // rotating Google session token and log the source Chrome out. Opt back in with includeGoogle.
  const googleStrip = includeGoogle ? null : stripGoogleIdentityFromProfileCopy(join(destDir, profileName));
  const googleStripOk = includeGoogle ? true : !(googleStrip?.errors?.length);
  // A default start that could not strip Google would launch a clone still carrying the source Google
  // session, which is exactly the logout risk this excludes. Fail loudly instead of launching it.
  if (!includeGoogle && !googleStripOk) {
    rmSync(destDir, { recursive: true, force: true });
    const detail = googleStrip.errors.map((entry) => entry.error).join('; ');
    throw new Error(
      `Could not strip the Google identity from the clone (${detail}). Refusing to launch, because the source Google session would be at risk. Ensure sqlite3 is available, or pass --include-google if you intend to use Google.`,
    );
  }
  const rsyncStatuses = results.map((result) => result.status);
  const state = {
    profileName,
    profileDir: destDir,
    sourceDir,
    syncedAt: new Date().toISOString(),
    rsyncStatus: rsyncStatuses.length ? Math.max(...rsyncStatuses) : 0,
    rsyncStatuses,
    copiedItems,
    includeGoogle,
    googleStrip,
    googleStripOk,
    syncScope: includeGoogle ? 'auth-minimal' : 'auth-minimal-no-google',
  };
  writePrivateFile(profileSyncStateFileForPort(port), JSON.stringify(state, null, 2));
  return { status: 'synced', profileDir: destDir, state };
}

// Registrable domains for Google account services and Google-owned properties whose cookies carry,
// share, or can re-establish the Google session. Account services (Gmail, Drive, Docs, Photos, Play,
// Cloud, Gemini, and so on) are all subdomains of google.com, so they are covered by that entry.
// Add new Google services here to keep the default exclusion comprehensive.
export const GOOGLE_IDENTITY_DOMAINS = [
  'google.com', 'google.dev', 'youtube.com', 'youtu.be', 'ytimg.com', 'googlevideo.com',
  'googleusercontent.com', 'gstatic.com', 'googleapis.com',
  'gmail.com', 'googlemail.com', 'blogger.com', 'blogspot.com',
  'doubleclick.net', 'google-analytics.com', 'googletagmanager.com',
  'googlesyndication.com', 'googleadservices.com',
  'withgoogle.com', 'google.org', 'android.com', 'goo.gl',
];

// SQL that removes Google-ecosystem cookies from a copied Cookies database. host_key is stored in
// plain text, so this needs no decryption. Each domain matches as an exact host or a leading-dot
// suffix, and the Google country-search patterns require a leading dot, so lookalikes such as
// notgoogle.com or notgoogle.se can never match.
export function googleCookieDeleteSql() {
  const clauses = [];
  for (const domain of GOOGLE_IDENTITY_DOMAINS) {
    const escaped = domain.replace(/'/g, "''");
    clauses.push(`host_key='${escaped}'`);
    clauses.push(`host_key LIKE '%.${escaped}'`);
  }
  // Google country search domains (.google.se, .google.co.uk, .google.com.au).
  clauses.push("host_key LIKE '%.google.__'");
  clauses.push("host_key LIKE '%.google.co.__'");
  clauses.push("host_key LIKE '%.google.com.__'");
  // The .google gTLD is owned entirely by Google (for example blog.google, codeassist.google).
  clauses.push("host_key LIKE '%.google'");
  return `DELETE FROM cookies WHERE ${clauses.join(' OR ')};`;
}

// Remove the Google session from a copied profile so a live clone cannot reconcile with Google and
// fork the source profile's rotating session token (which logs the source Chrome out). Deletes Google
// cookies from the copied Cookies databases and clears the Google OAuth refresh token from Web Data.
// Best effort and non-decrypting: it only touches plain-text columns of the copied databases.
export function stripGoogleIdentityFromProfileCopy(profileDir, { sqlite3Bin = 'sqlite3' } = {}) {
  const result = { cookieDbs: [], webDataCleared: false, errors: [] };
  const runSql = (db, sql) => {
    const r = spawnSync(sqlite3Bin, [db, sql], { encoding: 'utf-8' });
    if (r.error) return r.error.message;
    if (r.status !== 0) return (r.stderr || `sqlite3 exited ${r.status}`).trim();
    return null;
  };
  for (const rel of ['Cookies', join('Network', 'Cookies')]) {
    const db = join(profileDir, rel);
    if (!existsSync(db)) continue;
    const error = runSql(db, googleCookieDeleteSql());
    if (error) result.errors.push({ db, error });
    else result.cookieDbs.push(db);
  }
  const webData = join(profileDir, 'Web Data');
  if (existsSync(webData)) {
    // token_service holds the account OAuth refresh token; dropping it stops the clone re-minting a session.
    const error = runSql(webData, 'DELETE FROM token_service;');
    if (error && !/no such table/i.test(error)) result.errors.push({ db: webData, error });
    else result.webDataCleared = true;
  }
  return result;
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

export function chromeLaunchArgs({ port = DEFAULT_PORT, profileName = null, managedToken = null, userDataDir = null, headless = false, userAgent = null } = {}) {
  const normalizedPort = normalizePort(port);
  const launchUserDataDir = userDataDir || (profileName ? profileDataDirForPort(normalizedPort) : freshProfileDirForPort(normalizedPort));
  const args = [
    `--remote-debugging-port=${normalizedPort}`,
    `--user-data-dir=${launchUserDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
  ];
  // New headless runs the full browser (extensions and the copied profile still load) without opening
  // a window. Old --headless is a separate lightweight engine that ignores extensions, so keep =new.
  if (headless) args.push('--headless=new');
  // A headless launch otherwise advertises a "HeadlessChrome" User-Agent. When the copied profile is
  // signed in to Google, that headless fingerprint trips Google's session-theft protection and logs the
  // source profile out, while a windowed launch (normal Chrome UA) does not. Present the normal UA so a
  // headless clone matches a windowed one. Applied browser-wide so account reconcile requests use it too.
  if (userAgent) args.push(`--user-agent=${userAgent}`);
  if (managedToken) args.push(`--pi-browser-tools-managed=${managedToken}`);
  if (profileName) args.push(`--profile-directory=${profileName}`);
  return args;
}

export function detectChromeMajorVersion(chromeBin = browserToolsChromeBin()) {
  try {
    const result = spawnSync(chromeBin, ['--version'], { encoding: 'utf-8' });
    if (result.status !== 0 || !result.stdout) return null;
    const match = result.stdout.match(/(\d+)\.\d+\.\d+\.\d+/);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

// Build the normal reduced Chrome User-Agent for a major version. Chrome freezes the platform token,
// so this matches what a windowed macOS Chrome sends. It carries no machine-specific data.
export function chromeUserAgentForMajor(major) {
  if (!Number.isInteger(major) || major < 1) return null;
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function headlessUserAgent(chromeBin = browserToolsChromeBin()) {
  return chromeUserAgentForMajor(detectChromeMajorVersion(chromeBin));
}

export function managedBrowserForUserDataDir(userDataDir) {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8' });
  if (result.error || result.status !== 0) return null;
  const chromeBin = browserToolsChromeBin();

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    if (!command.includes(chromeBin)) continue;
    if (!command.includes(`--user-data-dir=${userDataDir}`)) continue;
    if (!command.includes('--pi-browser-tools-managed=')) continue;
    const portMatch = command.match(/--remote-debugging-port=(\d+)/);
    if (!portMatch) continue;
    return { pid, port: normalizePort(portMatch[1]), command };
  }

  return null;
}

// Convert a ps etime field ("MM:SS", "HH:MM:SS", or "DD-HH:MM:SS") to milliseconds.
export function parseProcessAgeMs(etime) {
  const raw = String(etime ?? '').trim();
  const match = raw.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total = ((Number(days || 0) * 24 + Number(hours || 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
  return total * 1000;
}

// Parse `ps -axo pid=,etime=,command=` output into the managed *browser* processes only.
//
// Pure so the filtering rules stay testable without spawning Chrome. Two exclusions matter:
// renderer/GPU/utility helpers inherit --user-data-dir and the managed token from their parent, so
// counting them would inflate the browser count roughly tenfold; and a user-data-dir outside our
// cache dir is somebody else's Chrome, which we must never count or kill.
// Extract --user-data-dir from a Chrome command line. Chrome does not quote this argument, and the
// path is user-configurable, so it can legitimately contain spaces ("/Volumes/My Drive/..."). Read
// to the next " --" rather than to the next space: a \S+ capture truncates the path, the cache-dir
// test then fails, and the browser silently disappears from the inventory.
export function parseUserDataDirArg(command) {
  const match = String(command ?? '').match(/--user-data-dir=(.+?)(?=\s--|$)/);
  return match ? match[1].trim() : null;
}

// Decide whether one ps line is a managed browser, and describe it. Shared by the inventory scan and
// by the pre-signal recheck in the reaper, so both apply exactly the same definition.
export function managedChromeProcessFromCommand({ pid, etime = null, command, cacheDir = browserToolsCacheDir(), chromeBin = browserToolsChromeBin() }) {
  if (!command || !command.includes(chromeBin)) return null;
  if (/--type=/.test(command)) return null;
  if (!command.includes('--pi-browser-tools-managed=')) return null;
  const portMatch = command.match(/--remote-debugging-port=(\d+)/);
  if (!portMatch) return null;
  const userDataDir = parseUserDataDirArg(command);
  if (!userDataDir || !userDataDir.startsWith(`${cacheDir}/chrome-`)) return null;
  return {
    pid: Number.parseInt(String(pid), 10),
    port: normalizePort(portMatch[1]),
    ageMs: parseProcessAgeMs(etime),
    userDataDir,
    command,
  };
}

export function parseManagedChromeProcesses(psOutput, { cacheDir = browserToolsCacheDir(), chromeBin = browserToolsChromeBin() } = {}) {
  const found = [];
  for (const line of String(psOutput ?? '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, pidText, etime, command] = match;
    const entry = managedChromeProcessFromCommand({ pid: pidText, etime, command, cacheDir, chromeBin });
    if (entry) found.push(entry);
  }
  return found;
}

// Is this PID, right now, still one of our managed browsers? Used immediately before sending a
// signal so a recycled PID cannot be hit.
export function verifyManagedChromePid(pid, { cacheDir = browserToolsCacheDir(), chromeBin = browserToolsChromeBin() } = {}) {
  const command = commandForPid(pid);
  if (!command) return null;
  return managedChromeProcessFromCommand({ pid, command, cacheDir, chromeBin });
}

// The live inventory of managed browsers. This reads the process table rather than the lifecycle
// files on purpose: the files can be deleted while a browser keeps running, which is precisely how
// a previous leak became invisible to `stop`. Processes cannot lie about existing.
export function listManagedChromeProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf-8' });
  if (result.error || result.status !== 0) return [];
  return parseManagedChromeProcesses(result.stdout);
}

export function maxManagedBrowsers(options = {}) {
  const raw = process.env[MAX_BROWSERS_ENV] ?? browserToolsRuntimeConfig(options).maxBrowsers;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_MANAGED_BROWSERS;
  return parsed;
}

export function launchLockDir() {
  return join(browserToolsCacheDir(), 'launch.lock');
}

// A single cache-wide lock, distinct from the per-port locks. Per-port locks cannot bound total
// concurrency: two starts racing for different ports never contend, so both can pass a 4-of-5 check
// and both launch. Slot reservation has to serialise on one lock.
export function acquireLaunchLock({ staleMs = PORT_LOCK_STALE_MS, waitMs = 30000, pollMs = 50 } = {}) {
  ensureCacheDir();
  const lockDir = launchLockDir();
  const deadline = Date.now() + Math.max(0, waitMs);

  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writePrivateFile(join(lockDir, 'lock.json'), JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }, null, 2));
      return { lockDir, release() { rmSync(lockDir, { recursive: true, force: true }); } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let lockState = null;
      try {
        lockState = safeReadJson(join(lockDir, 'lock.json'));
      } catch {
        lockState = null;
      }
      let stale = false;
      if (lockState?.pid && !processExists(Number(lockState.pid))) stale = true;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > staleMs) stale = true;
      } catch {
        stale = true;
      }
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) return null;
      sleepSync(pollMs);
    }
  }
}

// Ports that currently hold a slot. A running process holds one, and so does a browser whose state
// file exists with a live PID: launchChrome writes that file synchronously at spawn, but the process
// takes a moment to appear in ps, and a concurrent start must not read the gap as a free slot.
export function occupiedManagedSlotPorts({ processes = listManagedChromeProcesses() } = {}) {
  const ports = new Set(processes.map((entry) => entry.port));
  let entries = [];
  try {
    entries = readdirSync(browserToolsCacheDir(), { withFileTypes: true });
  } catch {
    return ports;
  }
  for (const entry of entries) {
    const match = entry.name.match(/^chrome-(\d+)\.json$/);
    if (!match || !entry.isFile()) continue;
    const port = Number.parseInt(match[1], 10);
    if (ports.has(port)) continue;
    const state = readManagedState(stateFileForPort(port));
    if (!state || state.managedBy !== 'browser-tools') continue;
    if (Number.isInteger(Number(state.pid)) && processExists(Number(state.pid))) ports.add(port);
  }
  return ports;
}

export function managedBrowserCapacity({ processes = listManagedChromeProcesses(), max = maxManagedBrowsers() } = {}) {
  const count = processes.length;
  return {
    count,
    max,
    remaining: Math.max(0, max - count),
    atCap: count >= max,
    // Warn on the last free slot so the cap is never a surprise.
    approaching: count > 0 && count === max - 1,
    processes,
  };
}

export function staleManagedBrowsers(processes = listManagedChromeProcesses(), { maxAgeMs = STALE_BROWSER_AGE_MS } = {}) {
  return processes.filter((entry) => Number.isFinite(entry.ageMs) && entry.ageMs >= maxAgeMs);
}

// A managed browser whose lifecycle files no longer describe it. `stop --port N` cannot reach these,
// so they would otherwise accumulate forever.
export function orphanedManagedBrowsers(processes = listManagedChromeProcesses()) {
  return processes.filter((entry) => {
    // A concurrent start holds the port lock from before the spawn until the readiness probe passes,
    // so there is a window where its browser is live but not yet written to a state file. Never reap
    // inside that window or we would kill a healthy browser out from under another agent.
    if (existsSync(portLockDirForPort(entry.port))) return false;
    const state = readManagedState(stateFileForPort(entry.port));
    if (!state || state.managedBy !== 'browser-tools') return true;
    return Number(state.pid) !== Number(entry.pid);
  });
}

// Kill managed browsers that no lifecycle file accounts for, then drop their leftover clone dirs.
// Safe by construction: every target came from parseManagedChromeProcesses, so it carries our
// managed token and a user-data-dir inside our cache dir.
export function reapOrphanedChromes({ dryRun = false, processes = listManagedChromeProcesses() } = {}) {
  const orphans = orphanedManagedBrowsers(processes);
  const reaped = [];
  for (const orphan of orphans) {
    if (dryRun) {
      reaped.push({ ...orphan, status: 'would-reap' });
      continue;
    }
    // Recheck before every signal. The PID came from a scan taken moments ago; if that process has
    // since exited and the PID been recycled, an unguarded kill lands on something unrelated.
    // stopChrome already does this between SIGTERM and SIGKILL, and this path runs automatically on
    // every start, so it must be at least as careful.
    if (!verifyManagedChromePid(orphan.pid)) {
      reaped.push({ ...orphan, status: processExists(orphan.pid) ? 'skipped-not-managed' : 'already-gone' });
      continue;
    }
    let status = 'reaped';
    try {
      process.kill(orphan.pid, 'SIGTERM');
      if (!waitForProcessExit(orphan.pid, 2000)) {
        if (!verifyManagedChromePid(orphan.pid)) {
          reaped.push({ ...orphan, status: 'skipped-not-managed' });
          continue;
        }
        process.kill(orphan.pid, 'SIGKILL');
        waitForProcessExit(orphan.pid, 1000);
        status = 'killed';
      }
    } catch (e) {
      status = e.code === 'ESRCH' ? 'already-gone' : 'failed';
    }
    reaped.push({ ...orphan, status });
  }
  return { reaped, dryRun };
}

function describePorts(processes, limit = 8) {
  const ports = processes.map((entry) => `:${entry.port}`);
  if (ports.length <= limit) return ports.join(', ');
  return `${ports.slice(0, limit).join(', ')} and ${ports.length - limit} more`;
}

// Hard stop before a new launch. Refusing is better than allocating yet another port: an unbounded
// fan-out of starts is exactly what filled memory and swap on a previous run.
export function formatBrowserAge(ageMs) {
  if (!Number.isFinite(ageMs)) return 'unknown age';
  const hours = ageMs / 3600000;
  if (hours < 1) return `${Math.max(1, Math.round(ageMs / 60000))}m`;
  return `${hours.toFixed(1)}h`;
}

// One inventory line per occupied slot. The age and the leftover marker are the whole point: they
// turn "you are at the limit" into "these four are junk from finished sessions, clear them".
function describeBrowserInventory(processes, { limit = 10, staleMaxAgeMs = STALE_BROWSER_AGE_MS } = {}) {
  const lines = processes.slice(0, limit).map((entry) => {
    const stale = Number.isFinite(entry.ageMs) && entry.ageMs >= staleMaxAgeMs;
    const pid = Number.isInteger(Number(entry.pid)) ? `PID ${entry.pid}` : 'PID unknown';
    return `    :${entry.port}  ${pid}  up ${formatBrowserAge(entry.ageMs)}${stale ? '   <- idle over 2h, likely a leftover' : ''}`;
  });
  if (processes.length > limit) lines.push(`    ... and ${processes.length - limit} more`);
  return lines.join('\n');
}

export function assertManagedBrowserCapacity({ processes = listManagedChromeProcesses(), max = maxManagedBrowsers() } = {}) {
  const capacity = managedBrowserCapacity({ processes, max });
  if (!capacity.atCap) return capacity;
  const stale = staleManagedBrowsers(processes);
  const staleLine = stale.length
    ? `\n  ${stale.length} of these ${stale.length === 1 ? 'has' : 'have'} been running over 2h and ${stale.length === 1 ? 'is' : 'are'} probably left over from a finished session.\n`
    : '';
  throw new Error(
    `Refusing to start another managed Chrome: ${capacity.count} of ${max} browser slots are in use.\n\n` +
    `  This is a deliberate limit, not a browser failure. Each managed Chrome costs roughly\n` +
    `  800 MB across its process tree, so starts that are never stopped will exhaust memory\n` +
    `  and swap. The limit stops a runaway fan-out from taking the machine down.\n\n` +
    `  Currently running (${capacity.count} of ${max}):\n` +
    `${describeBrowserInventory(processes)}\n` +
    staleLine +
    `\n  To continue, do one of these:\n` +
    `    scripts/stop.mjs --status              see this list again at any time\n` +
    `    scripts/stop.mjs --reap --dry-run      preview browsers no lifecycle file tracks\n` +
    `    scripts/stop.mjs --prune               reap those, then drop their unused clones\n` +
    `    scripts/stop.mjs --port <n> --owner-token "$${OWNER_TOKEN_ENV}"    stop one you own\n\n` +
    `  Best fix if these are yours: export ${OWNER_TOKEN_ENV} from the first start, and later\n` +
    `  starts reuse that browser instead of needing a new slot at all.\n\n` +
    `  If you genuinely need more at once: ${MAX_BROWSERS_ENV}=<n>`,
  );
}

// Non-fatal notices printed before a launch: one for the last free slot, one for browsers old enough
// to be leftovers from a finished session.
export function managedBrowserStartupWarnings({
  processes = listManagedChromeProcesses(),
  max = maxManagedBrowsers(),
  staleMaxAgeMs = STALE_BROWSER_AGE_MS,
} = {}) {
  const warnings = [];
  const capacity = managedBrowserCapacity({ processes, max });
  if (capacity.approaching) {
    warnings.push(
      `${capacity.count} of ${max} managed Chrome browsers are running (${describePorts(processes)}); ` +
      `${capacity.remaining} slot left before starts are refused. Stop what you no longer need.`,
    );
  }
  const stale = staleManagedBrowsers(processes, { maxAgeMs: staleMaxAgeMs });
  if (stale.length) {
    const hours = Math.floor(staleMaxAgeMs / (60 * 60 * 1000));
    warnings.push(
      `${stale.length} managed browser${stale.length === 1 ? '' : 's'} ${stale.length === 1 ? 'has' : 'have'} been running over ${hours}h ` +
      `(${describePorts(stale)}), likely left over from a finished session. ` +
      `Review with scripts/stop.mjs --reap --dry-run, then clear with scripts/stop.mjs --prune.`,
    );
  }
  return warnings;
}

// The one gate deciding whether an already-running managed browser may be adopted. Both the explicit
// --port path and the auto-allocated path go through this: they used to diverge, and the
// auto-allocated path skipped reuse entirely, so every bare `start` spawned another browser.
export function managedBrowserReuseDecision({ safety, state, ownerToken, includeGoogle = false }) {
  if (!safety?.ok) return { ok: false, reason: safety?.reason || 'missing-managed-state' };
  const ownership = managedBrowserOwnershipSafety({ state, ownerToken });
  if (!ownership.ok) return { ok: false, reason: ownership.reason, ownerId: ownership.ownerId };
  // Never adopt across Google modes: a stripped start must not inherit a Google-included browser
  // (logout risk for the source profile), and a Google workflow must not inherit a stripped one.
  if (Boolean(state?.includeGoogle) !== Boolean(includeGoogle)) {
    return { ok: false, reason: 'google-mode-mismatch', ownerId: ownership.ownerId };
  }
  return { ok: true, ownerId: ownership.ownerId, state };
}

// Find a live managed browser the caller can prove it owns, on any port. An auto-allocated start
// begins at DEFAULT_PORT, so without this a session whose browser landed on :9301 would look at
// :9222, find nothing, and launch a second browser on every subsequent start.
export function findReusableManagedBrowser({ ownerToken, includeGoogle = false, processes = listManagedChromeProcesses() } = {}) {
  if (!normalizeOwnerValue(ownerToken)) return null;
  for (const entry of processes) {
    const state = readManagedState(stateFileForPort(entry.port));
    if (!state || Number(state.pid) !== Number(entry.pid)) continue;
    const decision = managedBrowserReuseDecision({ safety: { ok: true }, state, ownerToken, includeGoogle });
    if (decision.ok) return { ...entry, state };
  }
  return null;
}

function chromeBinCandidates(chromeBin) {
  if (String(chromeBin).includes('/')) return [chromeBin];
  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  return pathDirs.length ? pathDirs.map((dir) => join(dir, chromeBin)) : [chromeBin];
}

function assertChromeBinaryLaunchable(chromeBin) {
  const candidates = chromeBinCandidates(chromeBin);
  let exists = false;
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      exists = true;
      if (!stat.isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return;
    } catch {
      // Try the next PATH candidate or report a single actionable error below.
    }
  }

  const problem = exists ? 'Chrome binary is not executable' : 'Chrome binary not found';
  throw new Error(`${problem}: ${chromeBin}. Set BROWSER_TOOLS_CHROME_BIN or browser.chromeBin in Browser Tools config.`);
}

export function launchChrome({ port = DEFAULT_PORT, profileName = null, userDataDir = null, ownerToken = null, ownerId = null, headless = false, includeGoogle = false } = {}) {
  ensureCacheDir();
  const normalizedPort = normalizePort(port);
  const launchUserDataDir = userDataDir || (profileName ? profileDataDirForPort(normalizedPort) : freshProfileDirForPort(normalizedPort));
  const managedToken = randomUUID();
  const effectiveOwnerToken = normalizeOwnerValue(ownerToken) || generateOwnerToken();
  const chromeBin = browserToolsChromeBin();
  const userAgent = headless ? headlessUserAgent(chromeBin) : null;
  const args = chromeLaunchArgs({ port: normalizedPort, profileName, managedToken, userDataDir: launchUserDataDir, headless, userAgent });
  assertChromeBinaryLaunchable(chromeBin);
  const pidFile = pidFileForPort(normalizedPort);
  const stateFile = stateFileForPort(normalizedPort);
  const proc = spawn(chromeBin, args, {
    detached: true,
    stdio: 'ignore',
  });
  proc.once('error', (error) => {
    rmSync(pidFile, { force: true });
    rmSync(stateFile, { force: true });
    console.error(`[browser-control] Chrome spawn failed: ${error.message}`);
  });
  if (!Number.isInteger(proc.pid)) {
    throw new Error(`Chrome failed to start: no child process PID for ${chromeBin}`);
  }
  writePrivateFile(pidFile, String(proc.pid));
  writePrivateFile(stateFile, JSON.stringify({
    managedBy: 'browser-tools',
    pid: proc.pid,
    port: normalizedPort,
    profileName: profileName || null,
    userDataDir: launchUserDataDir,
    headless: Boolean(headless),
    includeGoogle: Boolean(includeGoogle),
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
  defaultProfileName = null,
  forceProfileSync = false,
  autoAllocatePort = false,
  ownerToken = null,
  ownerId = null,
  headless = false,
  includeGoogle = false,
} = {}) {
  let normalizedPort = normalizePort(port);
  const providedOwnerToken = normalizeOwnerValue(ownerToken);
  const effectiveOwnerToken = providedOwnerToken || generateOwnerToken();
  const normalizedOwnerId = normalizeOwnerValue(ownerId);
  const { requestedProfileName, resolvedProfileName } = resolveStartProfileName({ profileName, taskName, defaultProfileName });
  ensureCacheDir();

  // Clean up before counting, so the cap reflects browsers that are actually reachable. Orphans are
  // browsers no lifecycle file tracks: nothing can address or stop them, so they are pure garbage.
  const reaped = reapOrphanedChromes();
  if (reaped.reaped.length) {
    console.error(`⟳ Reaped ${reaped.reaped.length} untracked managed browser${reaped.reaped.length === 1 ? '' : 's'} (${describePorts(reaped.reaped)})`);
    try {
      pruneChromeClones({ keepPorts: [normalizedPort] });
    } catch {
      // Best-effort disk cleanup must never block a launch.
    }
  }

  const liveBrowsers = listManagedChromeProcesses();
  for (const warning of managedBrowserStartupWarnings({ processes: liveBrowsers })) {
    console.error(`⚠ ${warning}`);
  }
  // Prefer returning a browser the caller already owns over adding another. For an auto-allocated
  // start that means searching every port, since the caller's browser may not be on DEFAULT_PORT.
  // This is the single biggest source of the leak: every bare start used to mean one more Chrome.
  let reusable = null;
  if (providedOwnerToken) {
    const candidates = autoAllocatePort ? liveBrowsers : liveBrowsers.filter((entry) => entry.port === normalizedPort);
    const found = findReusableManagedBrowser({ ownerToken: providedOwnerToken, includeGoogle, processes: candidates });
    if (found && await browserWSEndpoint(found.port)) {
      reusable = found;
      normalizedPort = found.port;
    }
  }

  // Only a genuine reuse is exempt from the cap. A browser merely occupying the port we would start
  // from is not reusable, so it must not buy a free pass past the limit.
  if (!reusable) assertManagedBrowserCapacity({ processes: liveBrowsers });

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
        const state = readManagedStateForPort(normalizedPort);
        const reuse = managedBrowserReuseDecision({ safety, state, ownerToken: providedOwnerToken, includeGoogle });
        // Reuse first, on both paths. An auto-allocated start used to skip this entirely and walk to
        // the next free port, so a session that called start twice got two browsers instead of one.
        if (reuse.ok) {
          return {
            status: 'reused',
            port: normalizedPort,
            headless: Boolean(state?.headless),
            includeGoogle: Boolean(state?.includeGoogle),
            ownerToken: effectiveOwnerToken,
            ownerId: reuse.ownerId,
            ownerTokenGenerated: false,
          };
        }
        if (!autoAllocatePort) {
          if (!safety.ok) {
            throw new Error(
              `Chrome DevTools is already listening on :${normalizedPort}, but it is not a Browser Tools managed browser (${safety.reason}). Use a different --port or stop that browser manually.`,
            );
          }
          if (reuse.reason === 'google-mode-mismatch') {
            throw new Error(
              `Chrome on :${normalizedPort} is running with Google ${state?.includeGoogle ? 'included' : 'excluded'}, but this start requested Google ${includeGoogle ? 'included' : 'excluded'}. Stop it with scripts/stop.mjs --clean and start again.`,
            );
          }
          throw new Error(
            `Chrome DevTools on :${normalizedPort} is owned by another Browser Tools agent (${reuse.reason}). Use a different --port or provide the correct --owner-token.`,
          );
        }
        // Cannot adopt it, so this really will be a new browser: it must fit under the cap.
        assertManagedBrowserCapacity();
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

      // Sweep clones left behind by browsers that are no longer running, keeping this port's copy
      // so an in-progress reuse is never deleted. Best-effort: cleanup must not block a launch.
      try {
        pruneChromeClones({ keepPorts: [normalizedPort] });
      } catch {
        // Ignore cleanup failures.
      }

      let profileSync = null;
      if (resolvedProfileName) {
        const cachedState = readProfileSyncState(normalizedPort);
        const googleMatches = cachedState && typeof cachedState.includeGoogle === 'boolean' && cachedState.includeGoogle === includeGoogle;
        const willSync = forceProfileSync || !profileCopyReady(resolvedProfileName, userDataDir) || !googleMatches;
        if (willSync) console.error(`⟳ Syncing Chrome profile auth state${includeGoogle ? ' (including Google)' : ' (Google identity excluded)'}...`);
        profileSync = syncChromeProfile(resolvedProfileName, { force: forceProfileSync, port: normalizedPort, destDir: userDataDir, includeGoogle });
        if (profileSync.status === 'cached') {
          console.error(`✓ Using cached profile copy at ${userDataDir} (use --sync to refresh; if a logged-in site appears logged out, stop with --clean and restart with --sync)`);
        } else if (profileSync.status === 'synced') {
          console.error(`✓ Profile synced to ${userDataDir}`);
          if (!includeGoogle) {
            // A failed strip aborts the sync above, so reaching here means the strip succeeded.
            console.error('✓ Google identity excluded from the clone (source Google session protected; pass --include-google for Google workflows)');
          }
        }
      }
      // Reserve the slot and spawn under one cache-wide lock. The earlier check is only advisory:
      // it runs before profile sync, which can take seconds, so on its own it lets two concurrent
      // starts both observe 4 of 5 and both launch. This recount is the binding one, and it holds
      // until launchChrome has written the state file that makes the new browser visible to others.
      const launchLock = acquireLaunchLock();
      if (!launchLock) {
        throw new Error(
          'Timed out waiting for the Browser Tools launch lock. Another start is reserving a browser slot; retry shortly.',
        );
      }
      let proc;
      try {
        const live = listManagedChromeProcesses();
        const occupied = occupiedManagedSlotPorts({ processes: live });
        occupied.delete(normalizedPort);
        assertManagedBrowserCapacity({
          processes: [...occupied].map((p) =>
            live.find((entry) => entry.port === p)
            || { pid: readManagedState(stateFileForPort(p))?.pid ?? null, port: p, ageMs: null }),
        });
        proc = launchChrome({
          port: normalizedPort,
          profileName: resolvedProfileName,
          userDataDir,
          ownerToken: effectiveOwnerToken,
          ownerId: normalizedOwnerId,
          headless,
          includeGoogle,
        });
      } finally {
        launchLock.release();
      }
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
        headless: Boolean(headless),
        includeGoogle: Boolean(includeGoogle),
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
    // A surviving pid file for a live process is the only handle we have on that browser. Deleting
    // it strands the process where neither stop nor a future start can see it, so keep it and let
    // the reaper deal with the process itself.
    const strandedPid = hasPidFile ? Number.parseInt(readFileSync(paths.pidFile, 'utf-8').trim(), 10) : NaN;
    if (Number.isInteger(strandedPid) && processExists(strandedPid)) {
      return {
        status: 'not-managed',
        port: normalizedPort,
        pid: strandedPid,
        cleaned: false,
        reason: 'incomplete-managed-state',
        hint: REAP_HINT,
      };
    }
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
      rmSync(profileSyncStateFileForPort(normalizedPort), { force: true });
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
    // The process failed a safety check but is still running. Forgetting its lifecycle files here is
    // what previously turned mismatched browsers into permanent orphans, so keep them.
    if (processExists(pid)) {
      return {
        status: 'not-managed',
        port: normalizedPort,
        pid,
        cleaned: false,
        reason: safety.reason,
        command: safety.command,
        hint: REAP_HINT,
      };
    }
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
    rmSync(profileSyncStateFileForPort(normalizedPort), { force: true });
    cleaned = true;
  }

  return { status, port: normalizedPort, pid, cleaned, error };
}

// Sweep cached profile clones that are not currently in use by a running managed Chrome.
// Removes the clone data dir plus its per-port sync-state and lifecycle files. A clone whose
// user-data-dir is still owned by a live managed Chrome is kept. Never touches non-clone cache
// entries (for example ai-chat data), because every path comes from the per-port helpers.
export function pruneChromeClones({ dryRun = false, keepPorts = [] } = {}) {
  const cacheDir = browserToolsCacheDir();
  const keep = new Set(keepPorts.map((value) => Number.parseInt(value, 10)));
  const removed = [];
  const kept = [];
  let entries;
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return { removed, kept, dryRun, cacheDir };
  }

  const ports = new Set();
  for (const entry of entries) {
    let match = entry.name.match(/^chrome-(?:data|fresh)-(\d+)$/);
    if (match && entry.isDirectory()) { ports.add(Number.parseInt(match[1], 10)); continue; }
    match = entry.name.match(/^chrome-profile-sync-(\d+)\.json$/);
    if (match && entry.isFile()) { ports.add(Number.parseInt(match[1], 10)); continue; }
    match = entry.name.match(/^chrome-(\d+)\.(?:pid|json)$/);
    if (match && entry.isFile()) ports.add(Number.parseInt(match[1], 10));
  }

  for (const port of [...ports].sort((a, b) => a - b)) {
    if (keep.has(port)) {
      kept.push({ port, reason: 'kept-port' });
      continue;
    }
    // A concurrent start holds a port lock between profile sync and process spawn, so it has no
    // running process yet. Skip locked ports so we never delete another start's just-synced clone.
    if (existsSync(portLockDirForPort(port))) {
      kept.push({ port, reason: 'start-locked' });
      continue;
    }
    const dataDir = profileDataDirForPort(port);
    const freshDir = freshProfileDirForPort(port);
    // Both a stale profiled clone and a live fresh clone can share a port, so check each candidate
    // dir for a live owner. Removing either dir while one is in use would corrupt a running browser.
    const runningData = existsSync(dataDir) ? managedBrowserForUserDataDir(dataDir) : null;
    const runningFresh = existsSync(freshDir) ? managedBrowserForUserDataDir(freshDir) : null;
    const running = runningData || runningFresh;
    if (running) {
      kept.push({ port, reason: 'running', pid: running.pid, dir: runningData ? dataDir : freshDir });
      continue;
    }
    const targets = [dataDir, freshDir, pidFileForPort(port), stateFileForPort(port), profileSyncStateFileForPort(port)]
      .filter((path) => existsSync(path));
    if (!targets.length) continue;
    if (!dryRun) for (const path of targets) rmSync(path, { recursive: true, force: true });
    removed.push({ port, paths: targets });
  }

  return { removed, kept, dryRun, cacheDir };
}

function readManagedState(stateFile) {
  // Generated lifecycle state, not user config. A crash-truncated file must read as null so stop and
  // stale-state cleanup can remove it and recover the port, rather than aborting on a parse error.
  try {
    return safeReadJson(stateFile);
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
  const cacheDir = browserToolsCacheDir();
  return userDataDir === PROFILE_DST ||
    userDataDir === FRESH_PROFILE_DIR ||
    userDataDir === profileDataDirForPort(DEFAULT_PORT) ||
    userDataDir === freshProfileDirForPort(DEFAULT_PORT) ||
    userDataDir.startsWith(`${cacheDir}/chrome-data-`) ||
    userDataDir.startsWith(`${cacheDir}/chrome-fresh-`);
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
  const isChrome = command.includes('Google Chrome') || command.includes(browserToolsChromeBin()) || command.includes(CHROME_BIN);

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
  const artifactDir = browserToolsArtifactDir();
  mkdirSync(artifactDir, { recursive: true });
  return join(artifactDir, `${safePrefix}-${timestamp}.${safeExtension}`);
}

export function fileExists(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
