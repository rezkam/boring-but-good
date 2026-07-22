import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['node_modules', '.pi']);
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT_EXTENSIONS = new Set(['.md', '.mjs', '.json']);
const LOCAL_PRIVATE_PATTERNS = (process.env.AI_CHAT_PRIVATE_PATTERNS || '')
  .split(',')
  .map(pattern => pattern.trim())
  .filter(Boolean)
  .map(pattern => new RegExp(pattern, 'i'));
const PERSONAL_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\/Users\/[^\s"'`]+/,
  /\/home\/[^\s"'`]+/,
  /\bProfile \d+\b/,
  ...LOCAL_PRIVATE_PATTERNS,
];

function publicFiles(dir = ROOT) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...publicFiles(join(dir, entry.name)));
      continue;
    }
    if (SKIP_FILES.has(entry.name)) continue;
    if (!TEXT_EXTENSIONS.has(extname(entry.name))) continue;
    files.push(join(dir, entry.name));
  }
  return files;
}

test('public skill surface does not include local account or machine details', () => {
  const leaks = [];
  for (const file of publicFiles()) {
    const text = readFileSync(file, 'utf-8');
    for (const pattern of PERSONAL_PATTERNS) {
      if (pattern.test(text)) leaks.push(`${relative(ROOT, file)} matches ${pattern}`);
    }
  }
  assert.deepEqual(leaks, []);
});

test('public ChatGPT contract has no stale local or rewrite claims', () => {
  const docs = ['SKILL.md', 'references/ai-chat.md', 'references/providers.md', 'references/transport.md', 'references/orchestration.md', 'references/evaluation.md']
    .map(file => readFileSync(join(ROOT, file), 'utf8')).join('\n');
  for (const stale of [/pro-extended/i, /gpt-5\.5/i, /chatgpt[^\n]*save-conversation/i, /chatgpt[^\n]*attach-conversation/i, /The adapter rewrites the backend request payload/i, /DOM text is only a fallback/i, /old [^\n]*medium[^\n]*high[^\n]*HTTP 422/i, /Sentinel flow/i, /imported-chatgpt/i, /launch-risks/i]) assert.doesNotMatch(docs, stale);
  assert.match(docs, /--list-conversations/); assert.match(docs, /provider conversation ID/i); assert.match(docs, /extra-high/);
  const source = readFileSync(join(ROOT, 'scripts/ai-chat/providers/chatgpt.mjs'), 'utf8');
  assert.doesNotMatch(source, /Fetch\.enable|Network\.setRequestInterception|continueRequest|fulfillRequest/);
  assert.doesNotMatch(source, /document\.body\.innerText|text stability|localConversationState:\s*true/);
});
