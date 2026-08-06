import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  browserWSEndpoint,
  connectBrowser,
  DEFAULT_PORT,
  managedBrowserOwnershipSafety,
  managedBrowserSafetyForPort,
  normalizePort,
  readManagedStateForPort,
  requiredOptionValue as optionValue,
  hasFlag,
  startChrome,
  stopChrome,
  timestampedTmpPath,
} from '../../../browser-tools/scripts/browser-control.mjs';
import { readCachedResponse, writeCachedResponse } from '../browser-query-cache.mjs';
import { aiChatProviders, getAiChatProvider, listAiChatProviders } from './providers/index.mjs';

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const AI_CHAT_BROWSER_OWNER_ID = 'ai-chat';
export const AI_CHAT_BROWSER_TASK_NAME = 'ai-chat';
export const AI_CHAT_DEFAULT_BROWSER_PROFILE_NAME = 'Default';
export const DEFAULT_CONVERSATION_STORE_DIR = join(homedir(), '.cache', 'pi-browser-tools', 'ai-chat-conversations');
export const DEFAULT_BROWSER_STATE_FILE = join(homedir(), '.cache', 'pi-browser-tools', 'ai-chat-browser.json');
export const PRIVATE_STATE_FILE_MODE = 0o600;

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || String(value).startsWith('--')) throw new Error(`Missing value after ${name}`);
    values.push(value);
  }
  return values;
}

function repeatedOptionValue(args, name) {
  const values = optionValues(args, name);
  if (values.length === 0) return null;
  return values.length === 1 ? values[0] : values;
}

function parsePositiveIntegerOption(args, name, fallback) {
  const value = optionValue(args, name, fallback);
  if (value === fallback) return fallback;

  const normalized = String(value);
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`Invalid ${name} value: "${value}"`);
  }

  return Number.parseInt(normalized, 10);
}

function parseOptionalBooleanOption(args, name) {
  const value = optionValue(args, name, null);
  if (value === null) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${name} value: "${value}". Expected true or false.`);
}

export function parseAiChatArgs(args = process.argv.slice(2)) {
  const providerName = optionValue(args, '--provider', 'grok');
  const promptFile = optionValue(args, '--prompt-file', null);
  const inlinePrompt = optionValue(args, '--prompt', null);
  const modelName = optionValue(args, '--model', 'default');
  const modelTask = optionValue(args, '--task', null);
  const outFile = optionValue(args, '--out', null);
  const timeoutSeconds = parsePositiveIntegerOption(args, '--timeout', DEFAULT_TIMEOUT_SECONDS);
  const conversationTarget = optionValue(args, '--conversation', null);
  const saveConversation = optionValue(args, '--save-conversation', null);
  const attachConversation = optionValue(args, '--attach-conversation', null);
  const sourceFocus = repeatedOptionValue(args, '--source-focus');
  const searchFocus = optionValue(args, '--search-focus', null);
  const timeRange = optionValue(args, '--time-range', null);
  const citationMode = optionValue(args, '--citation-mode', null);
  const language = optionValue(args, '--language', null);
  const timezone = optionValue(args, '--timezone', null);
  const chromeProfile = optionValue(args, '--chrome-profile', null);
  const browserProfileName = optionValue(args, '--browser-profile', null);
  const cookieSource = optionValue(args, '--cookie-source', null);
  const evidencePath = optionValue(args, '--evidence-path', null);
  const files = optionValues(args, '--file');
  const spaceUuid = optionValue(args, '--space-uuid', optionValue(args, '--space', null));
  const verifyModelTimeoutSeconds = parsePositiveIntegerOption(args, '--verify-model-timeout', 90);
  const temporary = parseOptionalBooleanOption(args, '--temporary');
  const saveToLibrary = hasFlag(args, '--save-to-library');
  if (temporary === true && saveToLibrary) {
    throw new Error('--temporary true conflicts with --save-to-library');
  }

  return {
    providerName,
    promptFile: promptFile === true ? null : promptFile,
    inlinePrompt: inlinePrompt === true ? null : inlinePrompt,
    modelName: modelName === true ? 'default' : modelName,
    modelTask: modelTask === true ? null : modelTask,
    thinking: hasFlag(args, '--thinking'),
    outFile: outFile === true ? null : outFile,
    port: normalizePort(optionValue(args, '--port', DEFAULT_PORT)),
    explicitPort: args.includes('--port'),
    browserHeadless: hasFlag(args, '--headless'),
    browserProfileName: browserProfileName === true ? null : browserProfileName,
    includeGoogle: hasFlag(args, '--include-google'),
    timeoutSeconds,
    timeoutExplicit: args.includes('--timeout'),
    jsonOutput: hasFlag(args, '--json'),
    stream: hasFlag(args, '--stream'),
    continueChat: hasFlag(args, '--continue'),
    conversationTarget: conversationTarget === true ? null : conversationTarget,
    saveConversation: saveConversation === true ? null : saveConversation,
    attachConversation: attachConversation === true ? null : attachConversation,
    listModels: hasFlag(args, '--list-models'),
    verifyModels: hasFlag(args, '--verify-models'),
    verifyModelTimeoutSeconds,
    includeConversation: hasFlag(args, '--include-conversation'),
    captureEvidence: hasFlag(args, '--evidence') || hasFlag(args, '--capture-evidence') || typeof evidencePath === 'string',
    evidencePath: evidencePath === true ? null : evidencePath,
    evidenceFullPage: hasFlag(args, '--evidence-full-page'),
    providerOptions: {
      sourceFocus,
      searchFocus: searchFocus === true ? null : searchFocus,
      timeRange: timeRange === true ? null : timeRange,
      citationMode: citationMode === true ? null : citationMode,
      language: language === true ? null : language,
      timezone: timezone === true ? null : timezone,
      incognito: hasFlag(args, '--incognito'),
      temporary,
      saveToLibrary,
      verifySession: hasFlag(args, '--verify-session') || hasFlag(args, '--auth-check'),
      chromeProfile: chromeProfile === true ? null : chromeProfile,
      cookieSource: cookieSource === true ? null : cookieSource,
      files,
      spaceUuid: spaceUuid === true ? null : spaceUuid,
    },
  };
}

export function readPrompt({ promptFile = null, inlinePrompt = null, stdinPath = '/dev/stdin' } = {}) {
  let prompt;
  if (promptFile) {
    prompt = readFileSync(promptFile, 'utf-8').trim();
  } else if (inlinePrompt) {
    prompt = String(inlinePrompt).trim();
  } else {
    prompt = readFileSync(stdinPath, 'utf-8').trim();
  }

  if (!prompt) throw new Error('empty prompt');
  return prompt;
}

function hasPromptInput(options = {}) {
  return typeof options.prompt === 'string' || typeof options.inlinePrompt === 'string' || typeof options.promptFile === 'string';
}

export function resolveAiChatBrowserStateFile(request = {}, deps = {}) {
  return deps.browserStateFile || request.browserStateFile || process.env.AI_CHAT_BROWSER_STATE_FILE || DEFAULT_BROWSER_STATE_FILE;
}

export function readAiChatBrowserState(stateFile = DEFAULT_BROWSER_STATE_FILE, fs = defaultBrowserStateFs) {
  if (!fs.exists(stateFile)) return null;
  try {
    return JSON.parse(fs.readFile(stateFile, 'utf-8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Failed to parse AI Chat browser state ${stateFile}: ${error.message}`);
    throw error;
  }
}

function privateModeText(mode) {
  if (!Number.isFinite(mode)) return 'unknown';
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function privatePermissionEnforcementError({ label, path, action }) {
  return new Error(`Failed to enforce private permissions on ${label} at ${path}: ${action}. Recovery: make sure the file is owned by the current user and chmod 0600 is allowed, then retry.`);
}

function privatePermissionVerificationError({ label, path, observedMode = null, action = null }) {
  const detail = action || `expected mode 0600, observed ${privateModeText(observedMode)}`;
  return new Error(`Failed to verify private permissions on ${label} at ${path}: ${detail}. Recovery: make sure the file is on a filesystem that supports owner-only permissions, then retry.`);
}

function enforcePrivateFilePermissions(path, fs, label) {
  if (typeof fs.chmod !== 'function') {
    throw privatePermissionEnforcementError({ label, path, action: 'chmod 0600 is not available from the fs dependency' });
  }

  try {
    fs.chmod(path, PRIVATE_STATE_FILE_MODE);
  } catch {
    throw privatePermissionEnforcementError({ label, path, action: 'chmod 0600 failed' });
  }

  if (typeof fs.stat !== 'function') {
    throw privatePermissionVerificationError({ label, path, action: 'stat is not available from the fs dependency' });
  }

  let stats;
  try {
    stats = fs.stat(path);
  } catch {
    throw privatePermissionVerificationError({ label, path, action: 'stat failed' });
  }

  const mode = Number(stats?.mode);
  if (!Number.isFinite(mode) || (mode & 0o777) !== PRIVATE_STATE_FILE_MODE) {
    throw privatePermissionVerificationError({ label, path, observedMode: mode });
  }
}

function writePrivateJsonFile(path, value, fs, label) {
  fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (typeof fs.exists === 'function' && fs.exists(path)) enforcePrivateFilePermissions(path, fs, label);
  fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: PRIVATE_STATE_FILE_MODE });
  enforcePrivateFilePermissions(path, fs, label);
}

export function writeAiChatBrowserState(state, stateFile = DEFAULT_BROWSER_STATE_FILE, fs = defaultBrowserStateFs) {
  writePrivateJsonFile(stateFile, state, fs, 'AI Chat browser state');
  return state;
}

export function clearAiChatBrowserState(stateFile = DEFAULT_BROWSER_STATE_FILE, fs = defaultBrowserStateFs) {
  fs.rm(stateFile, { force: true });
}

function browserToolsDeps(deps = {}) {
  return {
    browserWSEndpoint: deps.browserWSEndpoint || browserWSEndpoint,
    connectBrowser: deps.connectBrowser || connectBrowser,
    managedBrowserOwnershipSafety: deps.managedBrowserOwnershipSafety || managedBrowserOwnershipSafety,
    managedBrowserSafetyForPort: deps.managedBrowserSafetyForPort || managedBrowserSafetyForPort,
    readManagedStateForPort: deps.readManagedStateForPort || readManagedStateForPort,
    startChrome: deps.startChrome || startChrome,
    stopChrome: deps.stopChrome || stopChrome,
  };
}

export function aiChatBrowserRecoveryMessage({ port, reason, ownerId, stateFile } = {}) {
  const ownerText = ownerId ? ` owned by ${ownerId}` : '';
  const stopText = port ? ` with Browser Tools stop --port ${port}` : ' with Browser Tools stop';
  const stateText = stateFile ? ` AI Chat browser state: ${stateFile}.` : '';
  return `Recovery: do not attach to that browser${ownerText}. Use the correct owner token${stopText}, remove stale AI Chat browser state, or choose a different --port. Reason: ${reason || 'unknown'}.${stateText}`;
}

function aiChatBrowserError(message, { port, reason, ownerId, stateFile } = {}) {
  const portText = port ? ` on :${port}` : '';
  return new Error(`${message}${portText}: ${reason || 'unknown'}. ${aiChatBrowserRecoveryMessage({ port, reason, ownerId, stateFile })}`);
}

function browserProfileMismatchReason({ expectedProfileName = 'configured-or-default-profile', actualProfileName }) {
  const actual = actualProfileName || 'fresh-profile';
  return `profile-mismatch expected ${expectedProfileName}, got ${actual}`;
}

export async function validateAiChatBrowserState(state, {
  browserTools = browserToolsDeps(),
  stateFile = DEFAULT_BROWSER_STATE_FILE,
  expectedProfileName = null,
  expectedHeadless = null,
  expectedIncludeGoogle = null,
  requireProfile = false,
} = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { ok: false, stale: true, reason: 'missing-ai-chat-browser-state' };
  }

  let port;
  try {
    port = normalizePort(state.port || DEFAULT_PORT);
  } catch {
    return { ok: false, stale: true, reason: 'invalid-ai-chat-browser-port' };
  }

  const ownerToken = typeof state.ownerToken === 'string' && state.ownerToken.trim() ? state.ownerToken.trim() : null;
  if (!ownerToken) {
    return { ok: false, stale: false, port, reason: 'missing-owner-token' };
  }

  const safety = browserTools.managedBrowserSafetyForPort(port);
  if (!safety.ok) {
    const wsEndpoint = await browserTools.browserWSEndpoint(port);
    if (!wsEndpoint) return { ok: false, stale: true, port, reason: safety.reason || 'stale-managed-state' };
    return { ok: false, stale: false, port, reason: safety.reason || 'missing-managed-state' };
  }

  const managedState = browserTools.readManagedStateForPort(port);
  const ownership = browserTools.managedBrowserOwnershipSafety({ state: managedState, ownerToken });
  if (!ownership.ok) {
    return { ok: false, stale: false, port, reason: ownership.reason, ownerId: ownership.ownerId || managedState?.ownerId || null };
  }
  if (ownership.ownerId !== AI_CHAT_BROWSER_OWNER_ID) {
    return { ok: false, stale: false, port, reason: 'owner-id-mismatch', ownerId: ownership.ownerId || null };
  }

  const actualProfileName = managedState?.profileName || state.profileName || null;
  if (requireProfile && !actualProfileName) {
    return {
      ok: false,
      stale: false,
      port,
      reason: browserProfileMismatchReason({ actualProfileName }),
      ownerId: ownership.ownerId || null,
      profileName: actualProfileName,
      expectedProfileName: expectedProfileName || null,
    };
  }
  if (expectedProfileName && actualProfileName !== expectedProfileName) {
    return {
      ok: false,
      stale: false,
      port,
      reason: browserProfileMismatchReason({ expectedProfileName, actualProfileName }),
      ownerId: ownership.ownerId || null,
      profileName: actualProfileName,
      expectedProfileName,
    };
  }

  const actualHeadless = managedState?.headless ?? state.headless ?? false;
  if (expectedHeadless === true && actualHeadless !== true) {
    return { ok: false, stale: false, port, reason: 'headless-mismatch expected headless browser', ownerId: ownership.ownerId || null };
  }
  const actualIncludeGoogle = managedState?.includeGoogle ?? state.includeGoogle ?? false;
  if (typeof expectedIncludeGoogle === 'boolean' && actualIncludeGoogle !== expectedIncludeGoogle) {
    const expected = expectedIncludeGoogle ? 'included' : 'excluded';
    return { ok: false, stale: false, port, reason: `google-profile-mismatch expected Google identity ${expected}`, ownerId: ownership.ownerId || null };
  }

  const wsEndpoint = await browserTools.browserWSEndpoint(port);
  if (!wsEndpoint) {
    return { ok: false, stale: false, port, reason: 'debug-port-unavailable', ownerId: ownership.ownerId || null };
  }

  return { ok: true, port, ownerToken, ownerId: ownership.ownerId, managedState, stateFile };
}

function browserProtocolTimeoutMs(request) {
  return Math.max(60000, (request.timeoutSeconds * 1000) + 30000);
}

export async function ensureAiChatBrowserSession(request, deps = {}) {
  if (deps.browser) return { browser: deps.browser, shouldDisconnect: false, request, source: 'injected' };

  const stateFile = resolveAiChatBrowserStateFile(request, deps);
  const stateFs = deps.browserStateFs || defaultBrowserStateFs;
  const browserTools = browserToolsDeps(deps);
  const savedState = readAiChatBrowserState(stateFile, stateFs);

  if (savedState) {
    const validation = await validateAiChatBrowserState(savedState, {
      browserTools,
      stateFile,
      expectedProfileName: request.browserProfileName || null,
      expectedHeadless: request.browserHeadless ? true : null,
      expectedIncludeGoogle: !!request.includeGoogle,
      requireProfile: true,
    });
    if (validation.ok) {
      console.error(`[ai-chat] Reusing owned Browser Tools Chrome on :${validation.port}`);
      try {
        const browser = await browserTools.connectBrowser(validation.port, {
          ownerToken: validation.ownerToken,
          protocolTimeout: browserProtocolTimeoutMs(request),
        });
        return { browser, shouldDisconnect: true, request: { ...request, port: validation.port }, source: 'reused', state: savedState };
      } catch (error) {
        const connectionError = aiChatBrowserError(`Refusing to connect to saved AI Chat browser after validation failed (${error.message})`, {
          port: validation.port,
          reason: 'connect-failed',
          ownerId: validation.ownerId,
          stateFile,
        });
        if (request.closeBrowserAfterRun) {
          await finishAiChatBrowserSessionPreservingError({
            browserSession: { shouldDisconnect: true, request: { ...request, port: validation.port }, state: savedState },
            browser: null,
            provider: { name: request.providerName, closeBrowserAfterRun: true },
            request: { ...request, port: validation.port },
            deps,
          }, connectionError);
        }
        throw connectionError;
      }
    }

    if (validation.stale) {
      console.error(`[ai-chat] Discarding stale AI Chat browser state (${validation.reason}); starting a new owned browser.`);
      clearAiChatBrowserState(stateFile, stateFs);
    } else {
      throw aiChatBrowserError('Refusing to use saved AI Chat browser', {
        port: validation.port,
        reason: validation.reason,
        ownerId: validation.ownerId,
        stateFile,
      });
    }
  }

  console.error('[ai-chat] Starting Browser Tools Chrome owned by ai-chat');
  const started = await browserTools.startChrome({
    port: request.port,
    taskName: AI_CHAT_BROWSER_TASK_NAME,
    ...(request.browserProfileName
      ? { profileName: request.browserProfileName }
      : { defaultProfileName: AI_CHAT_DEFAULT_BROWSER_PROFILE_NAME }),
    ownerId: AI_CHAT_BROWSER_OWNER_ID,
    autoAllocatePort: !request.explicitPort,
    ...(request.browserHeadless ? { headless: true } : {}),
    ...(request.includeGoogle ? { includeGoogle: true } : {}),
  });
  if (!started.ownerToken) {
    throw new Error('Browser Tools did not return an owner token for the AI Chat browser. Recovery: retry, or start Browser Tools manually with an owner token and configure AI Chat state.');
  }

  const state = {
    version: 1,
    ownerId: AI_CHAT_BROWSER_OWNER_ID,
    ownerToken: started.ownerToken,
    port: started.port,
    taskName: AI_CHAT_BROWSER_TASK_NAME,
    profileName: started.profileName || null,
    requestedProfileName: started.requestedProfileName || null,
    headless: !!started.headless,
    includeGoogle: !!(started.includeGoogle ?? request.includeGoogle),
    status: started.status || 'started',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    writeAiChatBrowserState(state, stateFile, stateFs);
    const browser = await browserTools.connectBrowser(started.port, {
      ownerToken: started.ownerToken,
      protocolTimeout: browserProtocolTimeoutMs(request),
    });
    return { browser, shouldDisconnect: true, request: { ...request, port: started.port }, source: started.status || 'started', state };
  } catch (error) {
    if (request.closeBrowserAfterRun) {
      await finishAiChatBrowserSessionPreservingError({
        browserSession: { shouldDisconnect: true, request: { ...request, port: started.port }, state },
        browser: null,
        provider: { name: request.providerName, closeBrowserAfterRun: true },
        request: { ...request, port: started.port },
        deps,
      }, error);
    }
    throw error;
  }
}

async function finishAiChatBrowserSession({ browserSession, browser, provider, request, deps = {} }) {
  if (!browserSession?.shouldDisconnect) return;
  let disconnectError = null;
  try {
    browser?.disconnect();
  } catch (error) {
    disconnectError = error;
  }
  if (!provider?.closeBrowserAfterRun) {
    if (disconnectError) throw disconnectError;
    return;
  }

  const stateFile = resolveAiChatBrowserStateFile(request, deps);
  const stateFs = deps.browserStateFs || defaultBrowserStateFs;
  const ownerToken = browserSession.state?.ownerToken;
  const port = browserSession.request?.port;
  if (!ownerToken || !port) {
    throw new Error(`[${provider.name}] Cannot close the AI Chat browser safely because its owner token or port is missing.`);
  }

  const browserTools = browserToolsDeps(deps);
  const result = browserTools.stopChrome({ port, ownerToken, clean: false });
  const closedStatuses = new Set(['stopped', 'already-gone']);
  let stopStatus = result?.status;
  if (!closedStatuses.has(stopStatus)) {
    const endpoint = await browserTools.browserWSEndpoint(port);
    if (endpoint) {
      throw new Error(`[${provider.name}] Failed to close the AI Chat browser on :${port}: ${result?.reason || result?.error?.message || stopStatus || 'unknown error'}`);
    }
    stopStatus = 'verified-gone';
  }

  writeAiChatBrowserState({
    ...browserSession.state,
    status: 'stopped',
    stopStatus,
    updatedAt: new Date().toISOString(),
  }, stateFile, stateFs);
  if (disconnectError) console.error(`[ai-chat] CDP disconnect failed before browser shutdown: ${disconnectError.message}`);
  console.error(`[ai-chat] Closed owned Browser Tools Chrome on :${port} after ${provider.name}.`);
}

async function finishAiChatBrowserSessionPreservingError(args, operationError = null) {
  try {
    await finishAiChatBrowserSession(args);
  } catch (cleanupError) {
    if (!operationError) throw cleanupError;
    throw new AggregateError(
      [operationError, cleanupError],
      `[${args.provider.name}] ${operationError.message}; browser cleanup failed: ${cleanupError.message}`,
    );
  }
}

export function buildAiChatRequest(options = {}) {
  const prompt = options.listModels
    || (options.attachConversation && !hasPromptInput(options))
    || (options.conversationTarget && !hasPromptInput(options))
    ? ''
    : (options.prompt ?? readPrompt(options));
  const timeoutExplicit = typeof options.timeoutExplicit === 'boolean'
    ? options.timeoutExplicit
    : Object.prototype.hasOwnProperty.call(options, 'timeoutSeconds');
  return {
    providerName: options.providerName || 'grok',
    modelName: options.modelName || 'default',
    modelTask: options.modelTask || null,
    thinking: !!options.thinking,
    outFile: options.outFile || null,
    port: normalizePort(options.port ?? DEFAULT_PORT),
    explicitPort: !!options.explicitPort,
    browserStateFile: options.browserStateFile || null,
    browserHeadless: !!options.browserHeadless,
    browserProfileName: options.browserProfileName || null,
    includeGoogle: !!options.includeGoogle,
    timeoutSeconds: options.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
    timeoutExplicit,
    jsonOutput: !!options.jsonOutput,
    stream: !!options.stream,
    continueChat: !!options.continueChat,
    conversationTarget: options.conversationTarget || null,
    saveConversation: options.saveConversation || null,
    attachConversation: options.attachConversation || null,
    conversationStoreDir: options.conversationStoreDir || DEFAULT_CONVERSATION_STORE_DIR,
    listModels: !!options.listModels,
    verifyModels: !!options.verifyModels,
    verifyModelTimeoutSeconds: options.verifyModelTimeoutSeconds || 90,
    includeConversation: !!options.includeConversation,
    captureEvidence: !!options.captureEvidence,
    evidencePath: options.evidencePath || null,
    evidenceFullPage: !!options.evidenceFullPage,
    providerOptions: options.providerOptions || {},
    prompt,
  };
}

export function buildCacheInput(request) {
  return {
    provider: request.providerName,
    requested_model: request.modelName,
    model_task: request.modelTask,
    thinking: request.thinking,
    stream: !!request.stream,
    continue_chat: request.continueChat,
    conversation_target: request.conversationTarget,
    save_conversation: request.saveConversation,
    attach_conversation: request.attachConversation,
    json_output: request.jsonOutput,
    include_conversation: request.includeConversation,
    provider_options: request.providerOptions || {},
    prompt: request.prompt,
  };
}

function providerName(provider) {
  return typeof provider === 'string' ? provider : provider?.name;
}

function isPerplexityProvider(provider) {
  return String(providerName(provider) || '').toLowerCase() === 'perplexity';
}

const SECRET_PROVIDER_STATE_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth_token',
  'authorization',
  'cookie',
  'id_token',
  'password',
  'read_write_token',
  'refresh_token',
  'secret',
  'session_token',
]);

function normalizedProviderStateKey(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isSecretProviderStateKey(key) {
  return SECRET_PROVIDER_STATE_KEYS.has(normalizedProviderStateKey(key));
}

function secretPresenceKey(key) {
  return `has_${normalizedProviderStateKey(key) || 'secret'}`;
}

function sanitizeProviderStateValue(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => sanitizeProviderStateValue(item));
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretProviderStateKey(key)) {
      safe[secretPresenceKey(key)] = Boolean(item);
    } else {
      safe[key] = sanitizeProviderStateValue(item);
    }
  }
  return safe;
}

export function sanitizeProviderStateForOutput(provider, providerState) {
  if (!providerState || typeof providerState !== 'object' || Array.isArray(providerState)) return providerState || null;
  const safeState = sanitizeProviderStateValue(providerState);
  if (isPerplexityProvider(provider) && Object.prototype.hasOwnProperty.call(providerState, 'read_write_token')) {
    safeState.has_read_write_token = Boolean(providerState.read_write_token || safeState.has_read_write_token);
  }
  return safeState;
}

const SAFE_ATTACHMENT_METADATA_KEYS = new Set([
  'filename',
  'mime_type',
  'size_bytes',
  'is_image',
  'source',
  'status',
  'url_present',
]);

function normalizeAttachmentMetadataKey(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function sanitizeAttachmentMetadata(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const safe = {};
      for (const [key, value] of Object.entries(item)) {
        const normalizedKey = normalizeAttachmentMetadataKey(key);
        if (SAFE_ATTACHMENT_METADATA_KEYS.has(normalizedKey)) safe[normalizedKey] = value;
      }
      return safe;
    })
    .filter(item => Object.keys(item).length > 0);
}

function providerStateHasSecret(providerState) {
  return !!providerState && typeof providerState === 'object' && !Array.isArray(providerState) && Object.keys(providerState).some(isSecretProviderStateKey);
}

function privateProviderStateForConversation(provider, result) {
  if (result?.privateProviderState) return result.privateProviderState;
  const providerState = result?.providerState || null;
  if (providerStateHasSecret(providerState)) return providerState;
  if (isPerplexityProvider(provider) && providerState?.read_write_token) return providerState;
  return null;
}

function isSecretUrlParam(name) {
  return /(token|secret|session|auth|password|api[_-]?key|apikey)/i.test(String(name || ''));
}

export function sanitizeConversationUrlForOutput(url) {
  if (!url || typeof url !== 'string') return url || null;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSecretUrlParam(key)) parsed.searchParams.set(key, '[redacted]');
    }
    return parsed.href;
  } catch {
    return url;
  }
}

function attachPrivateProviderState(result, privateProviderState) {
  if (!privateProviderState) return result;
  Object.defineProperty(result, 'privateProviderState', {
    value: privateProviderState,
    enumerable: false,
    configurable: true,
  });
  return result;
}

function publicProviderResult(result) {
  return { ...result };
}

export function buildMetadata({ request, provider, result, fallbackFrom, fallbackTrail, conversation }) {
  const text = result.text || '';
  const safeFinalUrl = sanitizeConversationUrlForOutput(result.finalUrl || null);
  const safeConversationUrl = sanitizeConversationUrlForOutput(result.finalUrl || conversation?.url || null);
  const previousMessages = Array.isArray(conversation?.record?.messages) ? conversation.record.messages : [];
  const searchResults = result.searchResults || [];
  const attachments = sanitizeAttachmentMetadata(result.attachments || result.providerState?.attachments || []);
  const providerIsPerplexity = isPerplexityProvider(provider);
  const providerState = sanitizeProviderStateForOutput(provider, result.providerState || null);
  const modelFallbackFrom = result.modelFallbackFrom || providerState?.model_fallback_from || fallbackFrom || null;
  const modelFallbackReason = result.modelFallbackReason || providerState?.model_fallback_reason || (fallbackFrom ? 'rate_limited' : null);
  const conversationMessages = [
    ...previousMessages,
    ...(request.prompt ? [{ role: 'user', content: request.prompt }] : []),
    { role: 'assistant', content: text },
  ];
  return {
    provider: provider.name,
    model: result.modelUsed,
    selected_model: result.modelUsed,
    requested_model: request.modelName,
    model_task: request.modelTask || null,
    fallback_from: fallbackFrom || null,
    fallback_attempts: fallbackTrail,
    model_fallback_from: modelFallbackFrom,
    model_fallback_reason: modelFallbackReason,
    prompt_chars: request.prompt.length,
    response_chars: text.length,
    complete: !!result.done,
    rate_limited: !!result.rateLimited,
    final_url: safeFinalUrl,
    conversation_id: conversation?.id || request.saveConversation || null,
    conversation_url: safeConversationUrl,
    provider_state: providerState,
    search_results: searchResults,
    ...(providerIsPerplexity ? { sources: searchResults } : {}),
    ...(attachments.length ? { attachments } : {}),
    evidence_path: result.evidencePath || null,
    evidence_url: result.evidenceUrl || null,
    conversation_messages: request.includeConversation ? conversationMessages : undefined,
    conversation_message_count: conversationMessages.length,
    captured_at: new Date().toISOString(),
    continue_chat: request.continueChat,
    prompt: request.prompt,
    cache_hit: false,
  };
}

export function buildOutput({ request, metadata, text }) {
  if (request.jsonOutput) {
    return {
      extension: 'json',
      text: JSON.stringify({ ...metadata, response: text }, null, 2),
    };
  }

  return { extension: 'md', text };
}

function writePrivateArtifact(path, text, encoding = 'utf-8') {
  if (existsSync(path)) chmodSync(path, PRIVATE_STATE_FILE_MODE);
  writeFileSync(path, text, { encoding, mode: PRIVATE_STATE_FILE_MODE });
  chmodSync(path, PRIVATE_STATE_FILE_MODE);
}

export function saveSidecarArtifacts(baseOutFile, metadata, rawText) {
  if (!baseOutFile) return;
  try {
    writePrivateArtifact(`${baseOutFile}.meta.json`, JSON.stringify(metadata, null, 2));
  } catch (e) {
    console.error(`[artifact] Failed to write metadata sidecar: ${e.message}`);
  }

  if (typeof rawText === 'string' && rawText.trim()) {
    try {
      writePrivateArtifact(`${baseOutFile}.raw.txt`, rawText);
    } catch (e) {
      console.error(`[artifact] Failed to write raw sidecar: ${e.message}`);
    }
  }
}

export function emitOutput({ request, outputText, metadata, rawText, io = defaultIo }) {
  if (request.outFile) {
    io.writeFile(request.outFile, outputText, 'utf-8');
    saveSidecarArtifacts(request.outFile, metadata, rawText);
    return;
  }
  io.stdout(outputText);
}

export function conversationRecordPath({ providerName, id, storeDir = DEFAULT_CONVERSATION_STORE_DIR }) {
  const safeProvider = String(providerName || 'unknown').replace(/[^a-z0-9._-]+/gi, '_');
  const safeId = String(id || '').replace(/[^a-z0-9._-]+/gi, '_');
  if (!safeId) throw new Error('conversation id cannot be empty');
  return join(storeDir, safeProvider, `${safeId}.json`);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function normalizeHostname(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return normalized || null;
}

export function trustedConversationHostnamesForProvider(provider = {}) {
  const configured = [
    ...(Array.isArray(provider.trustedConversationHostnames) ? provider.trustedConversationHostnames : []),
    ...(Array.isArray(provider.conversationHostnames) ? provider.conversationHostnames : []),
  ];
  if (configured.length === 0 && provider.url) {
    try {
      configured.push(new URL(provider.url).hostname);
    } catch {}
  }
  return [...new Set(configured.map(normalizeHostname).filter(Boolean))];
}

export function validateConversationUrlForProvider(provider, url, { optionName = 'conversation URL' } = {}) {
  const selectedProvider = providerName(provider) || 'unknown';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[${selectedProvider}] Invalid ${optionName} for selected provider ${selectedProvider}: URL could not be parsed. Use a saved local conversation id, a provider backend id, or a ${selectedProvider} conversation URL.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[${selectedProvider}] Invalid ${optionName} for selected provider ${selectedProvider}: only http and https URLs are supported. Use a saved local conversation id, a provider backend id, or a ${selectedProvider} conversation URL.`);
  }

  const hostname = normalizeHostname(parsed.hostname);
  const trustedHostnames = trustedConversationHostnamesForProvider(provider);
  if (trustedHostnames.length === 0) {
    throw new Error(`[${selectedProvider}] Cannot validate ${optionName} for selected provider ${selectedProvider}: no trusted conversation hosts are configured. Use a saved local conversation id or a provider backend id instead.`);
  }
  if (!trustedHostnames.includes(hostname)) {
    throw new Error(`[${selectedProvider}] Refusing ${optionName} for selected provider ${selectedProvider}: host "${hostname || 'unknown'}" is not trusted. Use a saved local conversation id, a provider backend id, or a ${selectedProvider} conversation URL on one of: ${trustedHostnames.join(', ')}.`);
  }

  return url;
}

export function resolveConversationAttachment(provider, target) {
  const value = String(target || '').trim();
  if (!value) throw new Error('conversation attachment cannot be empty');

  const resolved = provider.resolveConversationAttachment?.({ target: value }) || null;
  const type = resolved?.type || (isHttpUrl(value) ? 'url' : 'provider_id');
  const url = resolved?.url || (type === 'url' ? value : null);
  const providerId = resolved?.providerId || resolved?.provider_id || (type === 'provider_id' ? value : null);
  const providerState = resolved?.privateProviderState || resolved?.providerState || resolved?.provider_state || (providerId ? { provider_backend_id: providerId } : null);

  return {
    type,
    value,
    url,
    provider_id: providerId,
    provider_state: providerState,
    source: resolved?.source || 'attached',
  };
}

export function attachConversationReference(request, provider, fs = defaultFs) {
  if (!request.attachConversation) return null;
  if (request.conversationTarget) throw new Error('Use either --conversation or --attach-conversation, not both');
  if (!request.saveConversation) throw new Error('--attach-conversation requires --save-conversation <local-id>');

  const attachment = resolveConversationAttachment(provider, request.attachConversation);
  if (attachment.url) validateConversationUrlForProvider(provider, attachment.url, { optionName: '--attach-conversation' });
  const path = conversationRecordPath({ providerName: provider.name, id: request.saveConversation, storeDir: request.conversationStoreDir });
  const capturedAt = new Date().toISOString();
  const record = {
    version: 1,
    kind: 'ai-chat-conversation',
    id: request.saveConversation,
    provider: provider.name,
    requested_model: request.modelName,
    model: null,
    final_url: attachment.url || null,
    conversation_url: attachment.url || null,
    provider_id: attachment.provider_id || null,
    provider_state: attachment.provider_state || null,
    attachment: {
      type: attachment.type,
      source: attachment.source,
      attached_at: capturedAt,
    },
    messages: [],
    captured_at: capturedAt,
    updated_at: capturedAt,
    response_chars: 0,
  };

  writePrivateJsonFile(path, record, fs, 'AI Chat conversation record');
  return { path, record, conversation: { id: request.saveConversation, url: record.final_url || record.conversation_url || null, source: path, record } };
}

export function resolveConversationReference(request, fs = defaultFs, provider = null) {
  const target = request.conversationTarget;
  if (!target) return null;
  if (isHttpUrl(target)) {
    if (provider) validateConversationUrlForProvider(provider, target, { optionName: '--conversation' });
    const attachment = provider ? resolveConversationAttachment(provider, target) : null;
    return {
      id: null,
      url: attachment?.url || target,
      providerState: attachment?.provider_state || null,
      source: 'url',
    };
  }

  const path = conversationRecordPath({ providerName: request.providerName, id: target, storeDir: request.conversationStoreDir });
  if (!fs.exists(path)) throw new Error(`Conversation not found: ${target}`);
  const record = JSON.parse(fs.readFile(path, 'utf-8'));
  if (!record.final_url && !record.conversation_url && !record.provider_state) throw new Error(`Conversation record has no URL or provider state: ${target}`);
  return { id: target, url: record.final_url || record.conversation_url || null, source: path, record };
}

function providerStateForConversationRecord(provider, result, conversation = null) {
  const previousProviderState = conversation?.record?.provider_state || null;
  let recordProviderState = result.privateProviderState || privateProviderStateForConversation(provider, result) || result.providerState || previousProviderState || null;
  if (previousProviderState?.read_write_token && recordProviderState?.has_read_write_token && !recordProviderState.read_write_token) {
    recordProviderState = { ...recordProviderState, read_write_token: previousProviderState.read_write_token };
  }
  return recordProviderState;
}

export function saveConversationReference(request, provider, result, metadata, fs = defaultFs, conversation = null) {
  const conversationId = request.saveConversation || conversation?.id;
  if (!conversationId) return null;
  const path = conversationRecordPath({ providerName: provider.name, id: conversationId, storeDir: request.conversationStoreDir });
  const previousMessages = Array.isArray(conversation?.record?.messages) ? conversation.record.messages : [];
  const recordProviderState = providerStateForConversationRecord(provider, result, conversation);
  const finalUrl = result.finalUrl || conversation?.record?.final_url || conversation?.url || null;
  const record = {
    version: conversation?.record?.version || 1,
    kind: conversation?.record?.kind || 'ai-chat-conversation',
    id: conversationId,
    provider: provider.name,
    requested_model: request.modelName,
    model: result.modelUsed,
    final_url: finalUrl,
    conversation_url: finalUrl,
    provider_id: conversation?.record?.provider_id || null,
    provider_state: recordProviderState,
    messages: [
      ...previousMessages,
      ...(request.prompt ? [{ role: 'user', content: request.prompt, captured_at: metadata.captured_at }] : []),
      { role: 'assistant', content: result.text || '', captured_at: metadata.captured_at },
    ],
    captured_at: conversation?.record?.captured_at || metadata.captured_at,
    updated_at: metadata.captured_at,
    response_chars: metadata.response_chars,
  };
  writePrivateJsonFile(path, record, fs, 'AI Chat conversation record');
  return { path, record };
}

export async function openConversationPage({ browser, provider, url }) {
  validateConversationUrlForProvider(provider, url);
  const pages = await browser.pages();
  let page = pages.find((candidate) => candidate.url() === url);
  if (!page) {
    const providerHost = provider.url ? new URL(provider.url).hostname.replace(/^www\./, '') : null;
    page = pages.find((candidate) => {
      try {
        return providerHost && new URL(candidate.url()).hostname.replace(/^www\./, '') === providerHost;
      } catch {
        return false;
      }
    }) || null;
  }
  if (!page) page = await browser.newPage({ background: true });
  const waitUntil = provider.preflight ? 'domcontentloaded' : 'networkidle2';
  if (page.url() !== url) await page.goto(url, { waitUntil, timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 2000));
  return page;
}

export function sameEvidenceUrl(candidateUrl, targetUrl) {
  if (!candidateUrl || !targetUrl) return false;
  if (candidateUrl === targetUrl) return true;
  try {
    const candidate = new URL(candidateUrl);
    const target = new URL(targetUrl);
    candidate.hash = '';
    target.hash = '';
    return candidate.href === target.href;
  } catch {
    return false;
  }
}

export async function selectEvidencePage({ browser, targetUrl }) {
  if (!browser) throw new Error('[evidence] Browser is required to capture screenshot evidence.');
  if (!targetUrl) throw new Error('[evidence] Final URL is required to capture screenshot evidence.');

  const pages = await browser.pages();
  const existingPage = pages.find((candidate) => sameEvidenceUrl(candidate.url(), targetUrl));
  if (existingPage) return existingPage;

  if (!/^https?:\/\//i.test(targetUrl)) {
    throw new Error(`[evidence] No browser page matched final URL: ${targetUrl}`);
  }

  if (!browser.newPage) {
    throw new Error(`[evidence] No browser page matched final URL and this browser cannot open one: ${targetUrl}`);
  }

  const page = await browser.newPage({ background: true });
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 1000));
  return page;
}

export async function captureEvidenceScreenshot({ browser, provider, result, request, fs = defaultFs } = {}) {
  if (!request?.captureEvidence) return null;

  const targetUrl = result?.finalUrl || result?.pageUrl || null;
  if (!browser) {
    return {
      skipped: true,
      reason: 'browser-unavailable',
      warning: '[evidence] Skipped screenshot evidence: browser is not available for this provider transport.',
      targetUrl,
    };
  }
  if (!targetUrl) {
    return {
      skipped: true,
      reason: 'missing-final-url',
      warning: '[evidence] Skipped screenshot evidence: provider result did not include a final URL.',
      targetUrl,
    };
  }

  const path = request.evidencePath || timestampedTmpPath(`ai-chat-${provider?.name || 'provider'}-evidence`, 'png');
  fs.mkdir(dirname(path), { recursive: true });
  const page = await selectEvidencePage({ browser, targetUrl });
  await page.screenshot({ path, fullPage: !!request.evidenceFullPage });
  return { path, url: page.url(), targetUrl };
}

export function cachedResponseText({ request, cached }) {
  if (typeof cached.rawText === 'string' && cached.rawText.trim()) return cached.rawText;
  if (request.jsonOutput && typeof cached.output === 'string') {
    try {
      const parsed = JSON.parse(cached.output);
      if (typeof parsed.response === 'string') return parsed.response;
    } catch {
      // Fall through to the cached output when older cache entries are not JSON.
    }
  }
  return cached.output || '';
}

export function buildCachedResponse({ request, cached, conversation = null }) {
  const cachedMetadata = cached.entry?.metadata || {};
  const cachedProvider = cachedMetadata.provider || request.providerName;
  const cachedSearchResults = cachedMetadata.search_results || cachedMetadata.sources || [];
  const metadata = {
    ...cachedMetadata,
    selected_model: cachedMetadata.selected_model || cachedMetadata.model || null,
    final_url: sanitizeConversationUrlForOutput(cachedMetadata.final_url || null),
    conversation_url: sanitizeConversationUrlForOutput(cachedMetadata.conversation_url || null),
    provider_state: sanitizeProviderStateForOutput(cachedProvider, cachedMetadata.provider_state || null),
    search_results: cachedSearchResults,
    ...(isPerplexityProvider(cachedProvider) ? { sources: cachedSearchResults } : {}),
    cache_hit: true,
    cache_key: cached.key,
    cached_at: cached.entry?.created_at,
  };
  if (!metadata.captured_at) metadata.captured_at = cached.entry?.created_at || new Date().toISOString();
  if (request.saveConversation || conversation?.id) metadata.conversation_id = request.saveConversation || conversation.id;

  const text = cachedResponseText({ request, cached });
  if (metadata.response_chars === undefined || metadata.response_chars === null) metadata.response_chars = text.length;

  const result = {
    text,
    rawText: cached.rawText || text,
    done: metadata.complete !== false,
    rateLimited: !!metadata.rate_limited,
    placeholderRejected: false,
    modelUsed: metadata.model || metadata.requested_model || request.modelName,
    finalUrl: cachedMetadata.final_url || cachedMetadata.conversation_url || cached.entry?.page_url || null,
    providerState: metadata.provider_state || null,
    searchResults: cachedSearchResults,
    evidencePath: metadata.evidence_path || null,
    evidenceUrl: metadata.evidence_url || null,
  };

  return {
    metadata,
    result: attachPrivateProviderState(result, privateProviderStateForConversation(cachedProvider, { providerState: cachedMetadata.provider_state })),
  };
}

export function emitCachedResponse({ request, cached, io = defaultIo, metadata = null, result = null }) {
  const response = metadata && result ? { metadata, result } : buildCachedResponse({ request, cached });
  const outputText = request.jsonOutput
    ? buildOutput({ request, metadata: response.metadata, text: response.result.text }).text
    : cached.output;

  emitOutput({
    request,
    outputText,
    metadata: response.metadata,
    rawText: response.result.rawText || response.result.text,
    io,
  });

  return { source: 'cache', metadata: response.metadata, result: publicProviderResult(response.result), output: outputText };
}

export async function runPromptAttempt({ browser, provider, request, selectedModel, conversation = null }) {
  let attemptContext = null;
  let page = null;

  if (provider.run) {
    if (request?.conversationTarget && isHttpUrl(request.conversationTarget)) {
      validateConversationUrlForProvider(provider, request.conversationTarget, { optionName: '--conversation' });
    }
    console.error(`[${provider.name}] Running provider transport: ${provider.transport || 'direct'}`);
    const result = await provider.run({ browser, request, selectedModel, conversation });
    const normalized = normalizeProviderResult({ result, page: null, provider, request, selectedModel });
    if (normalized.rateLimited) {
      console.error(`[${provider.name}] Rate limit detected for model: ${selectedModel}`);
    } else if (normalized.placeholderRejected) {
      console.error(`[${provider.name}] WARNING: Rejected placeholder-only response (${normalized.text.length} chars)`);
    } else {
      const suffix = normalized.done ? '' : ' (partial, timed out)';
      console.error(`[${provider.name}] Response complete: ${normalized.text.length} chars${suffix}`);
    }
    return normalized;
  }

  try {
    const conversationUrl = conversation?.url || provider.conversationUrlFromState?.({ conversation, request }) || null;
    if (conversationUrl) {
      validateConversationUrlForProvider(provider, conversationUrl);
      console.error(`[${provider.name}] Opening conversation: ${sanitizeConversationUrlForOutput(conversationUrl)}`);
      page = await openConversationPage({ browser, provider, url: conversationUrl });
    } else {
      if (request?.conversationTarget && isHttpUrl(request.conversationTarget)) {
        validateConversationUrlForProvider(provider, request.conversationTarget, { optionName: '--conversation' });
      }
      console.error(`[${provider.name}] Finding page...`);
      page = await provider.findPage({ browser, continueChat: request.continueChat, request });
    }
    console.error(`[${provider.name}] Page ready: ${page.url()}`);
    await provider.preflight?.({ browser, page, request, selectedModel, conversation });

    attemptContext = await provider.createAttemptContext?.({ browser, page, request, selectedModel, conversation }) || null;

    if (selectedModel !== 'default') {
      console.error(`[${provider.name}] Setting model: ${selectedModel}`);
      await provider.setModel({ page, model: selectedModel, thinking: request.thinking, request, selectedModel });
    }

    const preSubmitLen = await page.evaluate(() => document.body.innerText.length);

    await provider.clearInput({ page, request });
    console.error(`[${provider.name}] Typing ${request.prompt.length} chars...`);
    await provider.typePrompt({ page, prompt: request.prompt, request });

    const allPagesBefore = await browser.pages();
    const existingConversationUrls = new Set(
      allPagesBefore.map((candidate) => candidate.url()).filter((url) => url.includes('conversation=')),
    );

    await provider.beforeSubmit?.({ browser, page, request, selectedModel, attemptContext });
    await provider.submit({ page, request, selectedModel });
    console.error(`[${provider.name}] Submitted. Waiting for response (timeout: ${request.timeoutSeconds}s)...`);

    const result = await provider.waitForResponse({
      browser,
      page,
      promptSnippet: request.prompt.substring(0, 80),
      timeoutMs: request.timeoutSeconds * 1000,
      preSubmitLen,
      existingConversationUrls,
      attemptContext,
      networkTracker: attemptContext?.networkTracker || null,
      prompt: request.prompt,
      selectedModel,
      request,
    });

    let normalized = normalizeProviderResult({ result, page, provider, request, selectedModel });

    if (!normalized.rateLimited && !normalized.text.trim() && provider.recoverResponse) {
      normalized = normalizeProviderResult({
        result: await provider.recoverResponse({ browser, page, request, prompt: request.prompt, result: normalized, selectedModel }),
        page,
        provider,
        request,
        selectedModel,
      });
    }

    process.stderr.write('\n');
    if (normalized.rateLimited) {
      console.error(`[${provider.name}] Rate limit detected for model: ${selectedModel}`);
    } else if (normalized.placeholderRejected) {
      console.error(`[${provider.name}] WARNING: Rejected placeholder-only response (${normalized.text.length} chars)`);
    } else if (!normalized.text || (normalized.text.length < 10 && !normalized.done)) {
      console.error(`[${provider.name}] WARNING: Response appears empty or too short (${normalized.text.length} chars)`);
    } else {
      const suffix = normalized.done ? '' : ' (partial, timed out)';
      console.error(`[${provider.name}] Response complete: ${normalized.text.length} chars${suffix}`);
    }
    console.error(`[${provider.name}] Final URL: ${normalized.finalUrl}`);

    return normalized;
  } finally {
    await provider.disposeAttemptContext?.({ browser, page, request, selectedModel, attemptContext });
  }
}

export function normalizeProviderResult({ result, page, provider, request, selectedModel }) {
  const text = result?.text || '';
  const rawText = result?.rawText || text;
  const finalUrl = result?.finalUrl || result?.pageUrl || page?.url?.() || null;
  const rateLimited = !!result?.rateLimited || !!provider.isRateLimited?.({ text, rawText, result, request, selectedModel });
  const placeholderRejected = !rateLimited && !!provider.isPlaceholderResponse?.({ text, rawText, result, request, selectedModel });
  const providerState = sanitizeProviderStateForOutput(provider, result?.providerState || null);
  const normalized = {
    text,
    done: !placeholderRejected && !!result?.done,
    rawText,
    finalUrl,
    rateLimited,
    placeholderRejected,
    modelUsed: result?.modelUsed || selectedModel,
    providerState,
    searchResults: result?.searchResults || [],
    attachments: sanitizeAttachmentMetadata(result?.attachments || providerState?.attachments || []),
    evidencePath: result?.evidencePath || null,
    evidenceUrl: result?.evidenceUrl || null,
  };

  return attachPrivateProviderState(normalized, privateProviderStateForConversation(provider, result));
}

function savedConversationModel(conversation = null) {
  const record = conversation?.record || null;
  const providerState = record?.provider_state || conversation?.providerState || conversation?.provider_state || null;
  return providerState?.selected_model || providerState?.model || record?.model || record?.requested_model || null;
}

export function resolveInitialModel(provider, request, conversation = null) {
  if (request.modelName && request.modelName !== 'default') return request.modelName;
  if (request.modelTask && provider.taskModels?.[request.modelTask]) return provider.taskModels[request.modelTask];
  const conversationModel = savedConversationModel(conversation);
  if (conversationModel) return conversationModel;
  return provider.defaultModel || request.modelName || 'default';
}

export async function runWithFallbacks({ browser, provider, request, conversation = null }) {
  const initialModel = resolveInitialModel(provider, request, conversation);
  const fallbackTrail = [initialModel];
  let fallbackFrom = null;
  let result = await runPromptAttempt({ browser, provider, request, selectedModel: initialModel, conversation });

  if (result.rateLimited) {
    const rejectedModel = initialModel;
    const rejectedModelUsed = result.modelUsed || rejectedModel;
    const fallbackModels = provider.fallbackModels?.({
      requestedModel: request.modelName,
      initialModel,
      selectedModel: initialModel,
      rejectedModel,
      rejectedModelUsed,
      request,
      result,
    }) || [];
    for (const fallbackModel of fallbackModels) {
      fallbackFrom = fallbackFrom || rejectedModel;
      fallbackTrail.push(fallbackModel);
      console.error(`[${provider.name}] Quota banner detected on ${result.modelUsed || rejectedModel}; retrying with ${fallbackModel}...`);
      result = await runPromptAttempt({ browser, provider, request, selectedModel: fallbackModel, conversation });
      if (!result.rateLimited) break;
    }
  }

  return { result, fallbackFrom, fallbackTrail };
}

function requestHasFileAttachments(request = {}) {
  const files = request.providerOptions?.files || request.providerOptions?.attachments || request.providerOptions?.file || [];
  if (Array.isArray(files)) return files.length > 0;
  return !!files;
}

function requestBypassesCache(request = {}) {
  return !!request.stream || !!request.providerOptions?.incognito || requestHasFileAttachments(request);
}

function browserRequestForProvider(request, provider) {
  return {
    ...request,
    ...(provider?.preferredBrowserHeadless ? { browserHeadless: true } : {}),
    closeBrowserAfterRun: !!provider?.closeBrowserAfterRun,
  };
}

export async function runAiChat(request, deps = {}) {
  const provider = deps.provider || deps.providers?.[request.providerName] || getAiChatProvider(request.providerName);
  if (!provider) {
    throw new Error(`Unknown provider: ${request.providerName}. Available: ${listAiChatProviders().join(', ')}`);
  }

  const cache = deps.cache || defaultCache;
  const io = deps.io || defaultIo;
  const fs = deps.fs || defaultFs;

  if (request.listModels) {
    let browser = null;
    let browserSession = null;
    let activeRequest = request;
    let operationError = null;
    try {
      const needsBrowser = typeof provider.listModelsRequiresBrowser === 'function'
        ? provider.listModelsRequiresBrowser({ request })
        : !!provider.listModelsRequiresBrowser;
      if (needsBrowser) {
        browserSession = await ensureAiChatBrowserSession(browserRequestForProvider(request, provider), deps);
        browser = browserSession.browser;
        activeRequest = browserSession.request;
      }
      const listResult = await (provider.listModels?.({ browser, request: activeRequest }) || []);
      const models = Array.isArray(listResult) ? listResult : (listResult.models || []);
      const extra = Array.isArray(listResult) ? {} : Object.fromEntries(Object.entries(listResult).filter(([key]) => key !== 'models'));
      const output = JSON.stringify({
        provider: provider.name,
        default_model: provider.defaultModel || null,
        task_models: provider.taskModels || null,
        history_policy: provider.historyPolicy || null,
        verify_models: activeRequest.verifyModels,
        verify_model_timeout_seconds: activeRequest.verifyModelTimeoutSeconds,
        ...extra,
        models,
        count: models.length,
        captured_at: new Date().toISOString(),
      }, null, 2);
      emitOutput({ request: { ...activeRequest, outFile: activeRequest.outFile || null }, outputText: output, metadata: { provider: provider.name, model_count: models.length, captured_at: new Date().toISOString() }, rawText: output, io });
      return { source: 'models', provider, models, output };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      await finishAiChatBrowserSessionPreservingError({ browserSession, browser, provider, request: activeRequest, deps }, operationError);
    }
  }

  const attachedConversation = request.attachConversation ? attachConversationReference(request, provider, fs) : null;
  if (request.conversationTarget && isHttpUrl(request.conversationTarget)) {
    validateConversationUrlForProvider(provider, request.conversationTarget, { optionName: '--conversation' });
  }
  const conversation = deps.conversation || attachedConversation?.conversation || resolveConversationReference(request, fs, provider);

  if (request.attachConversation && !request.prompt) {
    const metadata = {
      provider: provider.name,
      model: null,
      requested_model: request.modelName,
      model_task: request.modelTask || null,
      prompt_chars: 0,
      response_chars: 0,
      complete: true,
      rate_limited: false,
      final_url: sanitizeConversationUrlForOutput(conversation?.record?.final_url || null),
      conversation_id: request.saveConversation,
      conversation_url: sanitizeConversationUrlForOutput(conversation?.record?.conversation_url || null),
      provider_state: sanitizeProviderStateForOutput(provider, conversation?.record?.provider_state || null),
      conversation_record_path: attachedConversation.path,
      attached: true,
      captured_at: conversation?.record?.captured_at || new Date().toISOString(),
      cache_hit: false,
    };
    const outputText = request.jsonOutput
      ? JSON.stringify({ ...metadata, response: '' }, null, 2)
      : `Attached ${provider.name} conversation ${request.saveConversation}`;
    emitOutput({ request, outputText, metadata, rawText: '', io });
    return { source: 'conversation-attachment', provider, metadata, result: { text: '', done: true }, output: outputText };
  }

  if (!request.prompt && conversation && !provider.recheckConversation) {
    throw new Error(`[${provider.name}] --conversation without --prompt is only supported when the provider can recheck a saved request. Add --prompt to continue this conversation.`);
  }

  const cacheInput = buildCacheInput(request);
  const useCache = !request.captureEvidence && !!request.prompt && !requestBypassesCache(request);
  const cached = useCache ? cache.read('ai-chat', cacheInput) : null;
  if (cached) {
    const cachedResponse = buildCachedResponse({ request, cached, conversation });
    const savedConversation = saveConversationReference(request, provider, cachedResponse.result, cachedResponse.metadata, fs, conversation);
    if (savedConversation) cachedResponse.metadata.conversation_record_path = savedConversation.path;
    return emitCachedResponse({ request, cached, io, ...cachedResponse });
  }

  const needsBrowser = provider.runRequiresBrowser
    ? provider.runRequiresBrowser({ request })
    : true;
  let browserSession = null;
  let browser = null;
  let activeRequest = request;
  let operationError = null;
  if (needsBrowser) {
    browserSession = await ensureAiChatBrowserSession(browserRequestForProvider(request, provider), deps);
    browser = browserSession.browser;
    activeRequest = browserSession.request;
  }

  try {
    if (!activeRequest.prompt && conversation && provider.recheckConversation) {
      const selectedModel = resolveInitialModel(provider, activeRequest, conversation);
      console.error(`[${provider.name}] Rechecking saved conversation: ${conversation.id || sanitizeConversationUrlForOutput(conversation.url) || 'provider-state'}`);
      const result = normalizeProviderResult({
        result: await provider.recheckConversation({ browser, request: activeRequest, selectedModel, conversation }),
        page: null,
        provider,
        request: activeRequest,
        selectedModel,
      });
      const metadata = buildMetadata({ request: activeRequest, provider, result, fallbackFrom: null, fallbackTrail: [selectedModel], conversation });
      metadata.recheck = true;
      const evidence = await captureEvidenceScreenshot({ browser, provider, result, request: activeRequest, fs });
      if (evidence?.skipped) {
        metadata.evidence_skipped_reason = evidence.reason;
        metadata.evidence_warning = evidence.warning;
        metadata.evidence_target_url = evidence.targetUrl;
        result.evidenceWarning = evidence.warning;
        console.error(evidence.warning);
      } else if (evidence) {
        metadata.evidence_path = evidence.path;
        metadata.evidence_url = evidence.url;
        metadata.evidence_target_url = evidence.targetUrl;
        result.evidencePath = evidence.path;
        result.evidenceUrl = evidence.url;
      }
      const savedConversation = saveConversationReference(activeRequest, provider, result, metadata, fs, conversation);
      if (savedConversation) metadata.conversation_record_path = savedConversation.path;
      const finalOutput = buildOutput({ request: activeRequest, metadata, text: result.text });
      emitOutput({ request: activeRequest, outputText: finalOutput.text, metadata, rawText: result.rawText, io });
      if (activeRequest.outFile) console.error(`[${provider.name}] Saved to ${activeRequest.outFile}`);
      return { source: 'recheck', provider, result: publicProviderResult(result), metadata, output: finalOutput.text };
    }

    const { result, fallbackFrom, fallbackTrail } = await runWithFallbacks({ browser, provider, request: activeRequest, conversation });
    const metadata = buildMetadata({ request: activeRequest, provider, result, fallbackFrom, fallbackTrail, conversation });
    const evidence = await captureEvidenceScreenshot({ browser, provider, result, request: activeRequest, fs });
    if (evidence?.skipped) {
      metadata.evidence_skipped_reason = evidence.reason;
      metadata.evidence_warning = evidence.warning;
      metadata.evidence_target_url = evidence.targetUrl;
      result.evidenceWarning = evidence.warning;
      console.error(evidence.warning);
    } else if (evidence) {
      metadata.evidence_path = evidence.path;
      metadata.evidence_url = evidence.url;
      metadata.evidence_target_url = evidence.targetUrl;
      result.evidencePath = evidence.path;
      result.evidenceUrl = evidence.url;
    }
    const output = buildOutput({ request: activeRequest, metadata, text: result.text });

    if (useCache && result.done && !result.rateLimited && !result.placeholderRejected && result.text.trim()) {
      const cacheWrite = cache.write('ai-chat', cacheInput, {
        output: output.text,
        rawText: result.rawText,
        pageUrl: metadata.final_url || metadata.conversation_url || null,
        metadata,
        extension: output.extension,
      });
      if (cacheWrite) metadata.cache_key = cacheWrite.key;
    }

    const savedConversation = saveConversationReference(activeRequest, provider, result, metadata, fs, conversation);
    if (savedConversation) metadata.conversation_record_path = savedConversation.path;

    const finalOutput = buildOutput({ request: activeRequest, metadata, text: result.text });
    emitOutput({ request: activeRequest, outputText: finalOutput.text, metadata, rawText: result.rawText, io });
    if (activeRequest.outFile) console.error(`[${provider.name}] Saved to ${activeRequest.outFile}`);

    return { source: 'live', provider, result: publicProviderResult(result), metadata, output: finalOutput.text };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    await finishAiChatBrowserSessionPreservingError({ browserSession, browser, provider, request: activeRequest, deps }, operationError);
  }
}

export const defaultIo = {
  stdout(text) {
    console.log(text);
  },
  writeFile(path, text, encoding = 'utf-8') {
    writePrivateArtifact(path, text, encoding);
  },
};

export const defaultCache = {
  read: readCachedResponse,
  write: writeCachedResponse,
};

export const defaultFs = {
  exists: existsSync,
  mkdir: mkdirSync,
  readFile: readFileSync,
  writeFile: writeFileSync,
  chmod: chmodSync,
  stat: statSync,
};

export const defaultBrowserStateFs = {
  exists: existsSync,
  mkdir: mkdirSync,
  readFile: readFileSync,
  writeFile: writeFileSync,
  chmod: chmodSync,
  stat: statSync,
  rm: rmSync,
};

export { aiChatProviders };
