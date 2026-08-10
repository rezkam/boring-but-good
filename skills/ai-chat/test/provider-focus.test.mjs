import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PROVIDERS_DIR = join(ROOT, 'scripts', 'ai-chat', 'providers');

test('AI Chat providers do not bring browser tabs to front during automation', () => {
  const offenders = [];
  const bringToFrontCall = ['bring', 'To', 'Front'].join('');

  for (const entry of readdirSync(PROVIDERS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== '.mjs') continue;
    const file = join(PROVIDERS_DIR, entry.name);
    const text = readFileSync(file, 'utf-8');
    if (text.includes(`.${bringToFrontCall}(`)) offenders.push(relative(ROOT, file));
  }

  assert.deepEqual(offenders, []);
});
