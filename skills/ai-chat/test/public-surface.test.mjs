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

function detector(...parts) {
  return new RegExp(parts.join(''), 'i');
}

const PERSONAL_PATTERNS = [
  detector('[A-Z0-9._%+-]+', '@', '[A-Z0-9.-]+', '\\.[A-Z]{2,}'),
  detector('/', '(?:Users|home)', '/', '[^\\s"\'`]+'),
  detector('(?:^|[\\s"\'`])', '(?:~|\\$HOME)', '/', '[^\\s"\'`]+'),
  detector('/', '(?:private|Volumes)', '/', '[^\\s"\'`]+'),
  detector('\\bProfile\\s+', '\\d+', '\\b'),
  detector('\\.', 'agents', '/'),
  detector('(?:^|[/.])', 'coordinator', '/', '(?:[^/\\s]+/)?', 'worktrees?', '/'),
  detector('\\b(?:', 'pull[- ]?request|', 'p', 'r', ')\\b'),
  detector('\\bsource[- ]?', 'provenance\\b'),
  detector('(?:https?:\\/\\/)?(?:www\\.)?', '(?:github|gitlab)', '\\.com/', '[^\\s"\'`]+'),
  ...LOCAL_PRIVATE_PATTERNS,
];

const DOCUMENTATION_PATH_PATTERNS = [
  detector('\\.', 'agents', '/'),
  detector('\\b', 'coordinator', '\\b'),
  detector('\\bworktrees?\\b'),
  detector('(?:^|[\\s"\'`])', '(?:~|\\$HOME)', '/'),
  detector('/tmp/'),
  detector('/', '(?:Users|home|private|Volumes)', '/'),
  detector('\\b(?:source[- ]?provenance|provenance)\\b'),
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

test('public skill surface excludes machine, account, and repository provenance', () => {
  const leaks = [];
  for (const file of publicFiles()) {
    const text = readFileSync(file, 'utf-8');
    for (const pattern of PERSONAL_PATTERNS) {
      if (pattern.test(text)) leaks.push(`${relative(ROOT, file)} matches ${pattern}`);
    }
  }
  assert.deepEqual(leaks, []);
});

test('public documentation uses neutral private-output placeholders', () => {
  const leaks = [];
  for (const file of publicFiles().filter(file => extname(file) === '.md' || (extname(file) === '.json' && relative(ROOT, file).startsWith('evals/')))) {
    const text = readFileSync(file, 'utf-8');
    for (const pattern of DOCUMENTATION_PATH_PATTERNS) {
      if (pattern.test(text)) leaks.push(`${relative(ROOT, file)} matches ${pattern}`);
    }
    if (extname(file) === '.json' && /chrome[_ -]?profile/i.test(text)) leaks.push(`${relative(ROOT, file)} includes browser profile guidance`);
  }
  assert.deepEqual(leaks, []);
});

test('public AI Chat files exclude agent attribution', () => {
  const attributionPattern = new RegExp([
    '\\b(?:',
    'Generated\\s+with',
    `|Co-authored${'-'}By`,
    '|Implementer:\\s*(?:Codex|Claude)',
    '|(?:Codex|Claude)\\s+(?:Code|agent)',
    ')\\b',
  ].join(''), 'i');
  const attributionLeaks = publicFiles()
    .filter(file => attributionPattern.test(readFileSync(file, 'utf8')))
    .map(file => relative(ROOT, file));
  assert.deepEqual(attributionLeaks, []);
});

test('AI Chat consumes Browser Tools only through the published package', () => {
  const siblingImport = new RegExp(['(?:\\.\\.\\/)+', 'browser-tools', '\\/'].join(''));
  const sourceScriptCommand = new RegExp(['browser-tools', '\\/scripts\\/'].join(''));
  const siblingContract = new RegExp(['(?:sibling.{0,40}browser[ -]tools|browser[ -]tools.{0,40}sibling)'].join(''), 'i');
  const sourceEntryPoint = new RegExp(['`(?:start|stop|config)', '\\.mjs'].join(''), 'i');
  const offenders = publicFiles()
    .filter(file => relative(ROOT, file) !== 'test/public-surface.test.mjs')
    .filter(file => {
      const text = readFileSync(file, 'utf-8');
      return siblingImport.test(text)
        || sourceScriptCommand.test(text)
        || siblingContract.test(text)
        || sourceEntryPoint.test(text);
    })
    .map(file => relative(ROOT, file));
  assert.deepEqual(offenders, []);

  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  assert.equal(packageJson.dependencies?.['@rezkam/browser-tools'], '^1.0.2');
});

test('public ChatGPT contract has no stale local or rewrite claims', () => {
  const docs = ['SKILL.md', 'references/ai-chat.md', 'references/providers.md', 'references/transport.md', 'references/orchestration.md', 'references/evaluation.md']
    .map(file => readFileSync(join(ROOT, file), 'utf8')).join('\n');
  for (const stale of [/pro-extended/i, /gpt-5\.5/i, /The adapter rewrites the backend request payload/i, /DOM text is only a fallback/i, /old [^\n]*medium[^\n]*high[^\n]*HTTP 422/i, /Sentinel flow/i, /imported-chatgpt/i, /launch-risks/i]) assert.doesNotMatch(docs, stale);
  assert.match(docs, /--list-conversations/); assert.match(docs, /provider conversation ID/i); assert.match(docs, /extra-high/);
  assert.match(docs, /ChatGPT has no local records/i); assert.match(docs, /ChatGPT has no local records and rejects `--save-conversation` and `--attach-conversation`/i);
  const source = readFileSync(join(ROOT, 'scripts/ai-chat/providers/chatgpt.mjs'), 'utf8');
  assert.doesNotMatch(source, /Fetch\.enable|Network\.setRequestInterception|continueRequest|fulfillRequest/);
  assert.doesNotMatch(source, /document\.body\.innerText|text stability|localConversationState:\s*true/);
});
