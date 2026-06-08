import { grokProvider } from './grok.mjs';
import { perplexityProvider } from './perplexity.mjs';
import { geminiProvider } from './gemini.mjs';
import { chatgptProvider } from './chatgpt.mjs';

export const aiChatProviders = {
  grok: grokProvider,
  perplexity: perplexityProvider,
  gemini: geminiProvider,
  chatgpt: chatgptProvider,
};

export function getAiChatProvider(name) {
  return aiChatProviders[name] || null;
}

export function listAiChatProviders() {
  return Object.keys(aiChatProviders);
}
