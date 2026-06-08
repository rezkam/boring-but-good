import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['node_modules', '.pi']);
const SKIP_FILES = new Set(['package-lock.json', 'profiles.local.json']);
const TEXT_EXTENSIONS = new Set(['.md', '.mjs', '.json']);
const LOCAL_PRIVATE_PATTERNS = (process.env.BROWSER_TOOLS_PRIVATE_PATTERNS || '')
  .split(',')
  .map((pattern) => pattern.trim())
  .filter(Boolean)
  .map((pattern) => new RegExp(pattern, 'i'));
const PERSONAL_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\/Users\/[^\s"'`]+/,
  /\/home\/[^\s"'`]+/,
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
