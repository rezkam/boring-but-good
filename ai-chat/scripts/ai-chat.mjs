#!/usr/bin/env node
/**
 * Universal AI Chat Resource Helper.
 *
 * The AI Chat Module owns prompt lifecycle, fallback, cache, metadata, and output.
 * Provider Adapters under scripts/ai-chat/ own browser-specific behavior only.
 */

import { buildAiChatRequest, parseAiChatArgs, runAiChat } from './ai-chat/module.mjs';

async function main() {
  const options = parseAiChatArgs(process.argv.slice(2));
  const request = buildAiChatRequest(options);
  await runAiChat(request);
}

main().catch((error) => {
  if (error.message === 'empty prompt') {
    console.error('Error: provide --prompt, --prompt-file, or pipe via stdin');
  } else {
    console.error(`Error: ${error.message}`);
  }
  process.exit(1);
});
