import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectBrowser, DEFAULT_PORT, normalizePort, optionValue, hasFlag, timestampedTmpPath } from '../../../browser-tools/scripts/browser-control.mjs';
import { readCachedResponse, writeCachedResponse } from '../browser-query-cache.mjs';
import { aiChatProviders, getAiChatProvider, listAiChatProviders } from './providers/index.mjs';

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const DEFAULT_CONVERSATION_STORE_DIR = join(homedir(), '.cache', 'pi-browser-tools', 'ai-chat-conversations');

export function parseAiChatArgs(args = process.argv.slice(2)) {
  const providerName = optionValue(args, '--provider', 'grok');
  const promptFile = optionValue(args, '--prompt-file', null);
  const inlinePrompt = optionValue(args, '--prompt', null);
  const modelName = optionValue(args, '--model', 'default');
  const modelTask = optionValue(args, '--task', null);
  const outFile = optionValue(args, '--out', null);
  const timeoutSeconds = Number.parseInt(String(optionValue(args, '--timeout', DEFAULT_TIMEOUT_SECONDS)), 10);
  const conversationTarget = optionValue(args, '--conversation', null);
  const saveConversation = optionValue(args, '--save-conversation', null);
  const sourceFocus = optionValue(args, '--source-focus', null);
  const searchFocus = optionValue(args, '--search-focus', null);
  const timeRange = optionValue(args, '--time-range', null);
  const citationMode = optionValue(args, '--citation-mode', null);
  const language = optionValue(args, '--language', null);
  const timezone = optionValue(args, '--timezone', null);
  const chromeProfile = optionValue(args, '--chrome-profile', null);
  const cookieSource = optionValue(args, '--cookie-source', null);
  const evidencePath = optionValue(args, '--evidence-path', null);
  const verifyModelTimeoutSeconds = Number.parseInt(String(optionValue(args, '--verify-model-timeout', 90)), 10);

  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new Error(`Invalid --timeout value: ${optionValue(args, '--timeout', DEFAULT_TIMEOUT_SECONDS)}`);
  }
  if (!Number.isInteger(verifyModelTimeoutSeconds) || verifyModelTimeoutSeconds < 1) {
    throw new Error(`Invalid --verify-model-timeout value: ${optionValue(args, '--verify-model-timeout', 90)}`);
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
    timeoutSeconds,
    jsonOutput: hasFlag(args, '--json'),
    continueChat: hasFlag(args, '--continue'),
    conversationTarget: conversationTarget === true ? null : conversationTarget,
    saveConversation: saveConversation === true ? null : saveConversation,
    listModels: hasFlag(args, '--list-models'),
    verifyModels: hasFlag(args, '--verify-models'),
    verifyModelTimeoutSeconds,
    includeConversation: hasFlag(args, '--include-conversation'),
    captureEvidence: hasFlag(args, '--evidence') || hasFlag(args, '--capture-evidence') || typeof evidencePath === 'string',
    evidencePath: evidencePath === true ? null : evidencePath,
    evidenceFullPage: hasFlag(args, '--evidence-full-page'),
    providerOptions: {
      sourceFocus: sourceFocus === true ? null : sourceFocus,
      searchFocus: searchFocus === true ? null : searchFocus,
      timeRange: timeRange === true ? null : timeRange,
      citationMode: citationMode === true ? null : citationMode,
      language: language === true ? null : language,
      timezone: timezone === true ? null : timezone,
      saveToLibrary: hasFlag(args, '--save-to-library'),
      verifySession: hasFlag(args, '--verify-session') || hasFlag(args, '--auth-check'),
      chromeProfile: chromeProfile === true ? null : chromeProfile,
      cookieSource: cookieSource === true ? null : cookieSource,
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

export function buildAiChatRequest(options = {}) {
  const prompt = options.listModels ? '' : (options.prompt ?? readPrompt(options));
  return {
    providerName: options.providerName || 'grok',
    modelName: options.modelName || 'default',
    modelTask: options.modelTask || null,
    thinking: !!options.thinking,
    outFile: options.outFile || null,
    port: normalizePort(options.port ?? DEFAULT_PORT),
    timeoutSeconds: options.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
    jsonOutput: !!options.jsonOutput,
    continueChat: !!options.continueChat,
    conversationTarget: options.conversationTarget || null,
    saveConversation: options.saveConversation || null,
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
    continue_chat: request.continueChat,
    conversation_target: request.conversationTarget,
    json_output: request.jsonOutput,
    include_conversation: request.includeConversation,
    provider_options: request.providerOptions || {},
    prompt: request.prompt,
  };
}

export function buildMetadata({ request, provider, result, fallbackFrom, fallbackTrail, conversation }) {
  const text = result.text || '';
  const previousMessages = Array.isArray(conversation?.record?.messages) ? conversation.record.messages : [];
  const conversationMessages = [
    ...previousMessages,
    ...(request.prompt ? [{ role: 'user', content: request.prompt }] : []),
    { role: 'assistant', content: text },
  ];
  return {
    provider: provider.name,
    model: result.modelUsed,
    requested_model: request.modelName,
    model_task: request.modelTask || null,
    fallback_from: fallbackFrom || null,
    fallback_attempts: fallbackTrail,
    prompt_chars: request.prompt.length,
    response_chars: text.length,
    complete: !!result.done,
    rate_limited: !!result.rateLimited,
    final_url: result.finalUrl || null,
    conversation_id: conversation?.id || request.saveConversation || null,
    conversation_url: result.finalUrl || conversation?.url || null,
    provider_state: result.providerState || null,
    search_results: result.searchResults || [],
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

export function saveSidecarArtifacts(baseOutFile, metadata, rawText) {
  if (!baseOutFile) return;
  try {
    writeFileSync(`${baseOutFile}.meta.json`, JSON.stringify(metadata, null, 2), 'utf-8');
  } catch (e) {
    console.error(`[artifact] Failed to write metadata sidecar: ${e.message}`);
  }

  if (typeof rawText === 'string' && rawText.trim()) {
    try {
      writeFileSync(`${baseOutFile}.raw.txt`, rawText, 'utf-8');
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

export function resolveConversationReference(request, fs = defaultFs) {
  const target = request.conversationTarget;
  if (!target) return null;
  if (/^https?:\/\//i.test(target)) return { id: null, url: target, source: 'url' };

  const path = conversationRecordPath({ providerName: request.providerName, id: target, storeDir: request.conversationStoreDir });
  if (!fs.exists(path)) throw new Error(`Conversation not found: ${target}`);
  const record = JSON.parse(fs.readFile(path, 'utf-8'));
  if (!record.final_url && !record.conversation_url && !record.provider_state) throw new Error(`Conversation record has no URL or provider state: ${target}`);
  return { id: target, url: record.final_url || record.conversation_url || null, source: path, record };
}

export function saveConversationReference(request, provider, result, metadata, fs = defaultFs, conversation = null) {
  const conversationId = request.saveConversation || conversation?.id;
  if (!conversationId) return null;
  const path = conversationRecordPath({ providerName: provider.name, id: conversationId, storeDir: request.conversationStoreDir });
  const previousMessages = Array.isArray(conversation?.record?.messages) ? conversation.record.messages : [];
  const record = {
    id: conversationId,
    provider: provider.name,
    requested_model: request.modelName,
    model: result.modelUsed,
    final_url: result.finalUrl || null,
    conversation_url: result.finalUrl || null,
    provider_state: result.providerState || null,
    messages: [
      ...previousMessages,
      { role: 'user', content: request.prompt, captured_at: metadata.captured_at },
      { role: 'assistant', content: result.text || '', captured_at: metadata.captured_at },
    ],
    captured_at: metadata.captured_at,
    response_chars: metadata.response_chars,
  };
  fs.mkdir(dirname(path), { recursive: true });
  fs.writeFile(path, JSON.stringify(record, null, 2), 'utf-8');
  return { path, record };
}

export async function openConversationPage({ browser, provider, url }) {
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
  const path = request.evidencePath || timestampedTmpPath(`ai-chat-${provider?.name || 'provider'}-evidence`, 'png');
  fs.mkdir(dirname(path), { recursive: true });
  const page = await selectEvidencePage({ browser, targetUrl });
  await page.screenshot({ path, fullPage: !!request.evidenceFullPage });
  return { path, url: page.url(), targetUrl };
}

export function emitCachedResponse({ request, cached, io = defaultIo }) {
  const metadata = {
    ...(cached.entry?.metadata || {}),
    cache_hit: true,
    cache_key: cached.key,
    cached_at: cached.entry?.created_at,
  };

  emitOutput({
    request,
    outputText: cached.output,
    metadata,
    rawText: cached.rawText || cached.output,
    io,
  });

  return { source: 'cache', metadata, output: cached.output };
}

export async function runPromptAttempt({ browser, provider, request, selectedModel, conversation = null }) {
  let attemptContext = null;
  let page = null;

  if (provider.run) {
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
    if (conversation?.url) {
      console.error(`[${provider.name}] Opening conversation: ${conversation.url}`);
      page = await openConversationPage({ browser, provider, url: conversation.url });
    } else {
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

  return {
    text,
    done: !placeholderRejected && !!result?.done,
    rawText,
    finalUrl,
    rateLimited,
    placeholderRejected,
    modelUsed: result?.modelUsed || selectedModel,
    providerState: result?.providerState || null,
    searchResults: result?.searchResults || [],
    evidencePath: result?.evidencePath || null,
    evidenceUrl: result?.evidenceUrl || null,
  };
}

export function resolveInitialModel(provider, request) {
  if (request.modelName && request.modelName !== 'default') return request.modelName;
  if (request.modelTask && provider.taskModels?.[request.modelTask]) return provider.taskModels[request.modelTask];
  return provider.defaultModel || request.modelName || 'default';
}

export async function runWithFallbacks({ browser, provider, request, conversation = null }) {
  const initialModel = resolveInitialModel(provider, request);
  const fallbackTrail = [initialModel];
  let fallbackFrom = null;
  let result = await runPromptAttempt({ browser, provider, request, selectedModel: initialModel, conversation });

  if (result.rateLimited) {
    const fallbackModels = provider.fallbackModels?.({ requestedModel: request.modelName, request, result }) || [];
    for (const fallbackModel of fallbackModels) {
      fallbackFrom = fallbackFrom || request.modelName;
      fallbackTrail.push(fallbackModel);
      console.error(`[${provider.name}] Quota banner detected on ${result.modelUsed}; retrying with ${fallbackModel}...`);
      result = await runPromptAttempt({ browser, provider, request, selectedModel: fallbackModel, conversation });
      if (!result.rateLimited) break;
    }
  }

  return { result, fallbackFrom, fallbackTrail };
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
    let ownsBrowser = false;
    try {
      const needsBrowser = typeof provider.listModelsRequiresBrowser === 'function'
        ? provider.listModelsRequiresBrowser({ request })
        : !!provider.listModelsRequiresBrowser;
      if (needsBrowser) {
        browser = deps.browser || await (deps.connectBrowser || connectBrowser)(request.port, { protocolTimeout: 60000 });
        ownsBrowser = !deps.browser;
      }
      const listResult = await (provider.listModels?.({ browser, request }) || []);
      const models = Array.isArray(listResult) ? listResult : (listResult.models || []);
      const extra = Array.isArray(listResult) ? {} : Object.fromEntries(Object.entries(listResult).filter(([key]) => key !== 'models'));
      const output = JSON.stringify({
        provider: provider.name,
        default_model: provider.defaultModel || null,
        task_models: provider.taskModels || null,
        history_policy: provider.historyPolicy || null,
        verify_models: request.verifyModels,
        verify_model_timeout_seconds: request.verifyModelTimeoutSeconds,
        ...extra,
        models,
        count: models.length,
        captured_at: new Date().toISOString(),
      }, null, 2);
      emitOutput({ request: { ...request, outFile: request.outFile || null }, outputText: output, metadata: { provider: provider.name, model_count: models.length, captured_at: new Date().toISOString() }, rawText: output, io });
      return { source: 'models', provider, models, output };
    } finally {
      if (ownsBrowser) browser?.disconnect();
    }
  }

  const conversation = deps.conversation || resolveConversationReference(request, fs);
  const cacheInput = buildCacheInput(request);
  const useCache = !request.captureEvidence;
  const cached = useCache ? cache.read('ai-chat', cacheInput) : null;
  if (cached) return emitCachedResponse({ request, cached, io });

  const needsBrowser = provider.runRequiresBrowser
    ? provider.runRequiresBrowser({ request })
    : true;
  const browser = deps.browser || (needsBrowser ? await (deps.connectBrowser || connectBrowser)(request.port, {
    protocolTimeout: 60000,
  }) : null);
  const ownsBrowser = needsBrowser && !deps.browser;

  try {
    const { result, fallbackFrom, fallbackTrail } = await runWithFallbacks({ browser, provider, request, conversation });
    const metadata = buildMetadata({ request, provider, result, fallbackFrom, fallbackTrail, conversation });
    const evidence = await captureEvidenceScreenshot({ browser, provider, result, request, fs });
    if (evidence) {
      metadata.evidence_path = evidence.path;
      metadata.evidence_url = evidence.url;
      metadata.evidence_target_url = evidence.targetUrl;
      result.evidencePath = evidence.path;
      result.evidenceUrl = evidence.url;
    }
    const output = buildOutput({ request, metadata, text: result.text });

    if (useCache && !result.rateLimited && !result.placeholderRejected && result.text.trim()) {
      const cacheWrite = cache.write('ai-chat', cacheInput, {
        output: output.text,
        rawText: result.rawText,
        pageUrl: result.finalUrl,
        metadata,
        extension: output.extension,
      });
      if (cacheWrite) metadata.cache_key = cacheWrite.key;
    }

    const savedConversation = saveConversationReference(request, provider, result, metadata, fs, conversation);
    if (savedConversation) metadata.conversation_record_path = savedConversation.path;

    const finalOutput = buildOutput({ request, metadata, text: result.text });
    emitOutput({ request, outputText: finalOutput.text, metadata, rawText: result.rawText, io });
    if (request.outFile) console.error(`[${provider.name}] Saved to ${request.outFile}`);

    return { source: 'live', provider, result, metadata, output: finalOutput.text };
  } finally {
    if (ownsBrowser) browser.disconnect();
  }
}

export const defaultIo = {
  stdout(text) {
    console.log(text);
  },
  writeFile(path, text, encoding = 'utf-8') {
    writeFileSync(path, text, encoding);
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
};

export { aiChatProviders };
