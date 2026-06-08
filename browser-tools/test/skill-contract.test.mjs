import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC_BROWSER_CONTROL_SCRIPTS = [
  'scripts/config.mjs',
  'scripts/start.mjs',
  'scripts/stop.mjs',
  'scripts/nav.mjs',
  'scripts/eval.mjs',
  'scripts/screenshot.mjs',
  'scripts/pick.mjs',
];
const GENERIC_EXTRACTOR_SCRIPTS = [
  'scripts/scrape-page.mjs',
  'scripts/extract-article.mjs',
];
function readRelative(path) {
  return readFileSync(join(ROOT, path), 'utf-8');
}

function walk(dir, predicate, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.pi') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, predicate, files);
    else if (predicate(path)) files.push(path);
  }
  return files;
}

test('all public scripts named by the Skill Interface exist and are executable', () => {
  for (const script of [...PUBLIC_BROWSER_CONTROL_SCRIPTS, ...GENERIC_EXTRACTOR_SCRIPTS]) {
    const path = join(ROOT, script);
    assert.equal(existsSync(path), true, `${script} should exist`);
    accessSync(path, constants.X_OK);
    assert.match(readFileSync(path, 'utf-8'), /^#!\/usr\/bin\/env node/, `${script} should be directly executable`);
  }
});

test('SKILL.md and reference docs document the same public Browser Control and generic extractor surface', () => {
  const skill = readRelative('SKILL.md');
  const browserControl = readRelative('references/browser-control.md');
  const resourceHelpers = readRelative('references/resource-helpers.md');

  for (const script of PUBLIC_BROWSER_CONTROL_SCRIPTS) {
    assert.match(skill, new RegExp(script.replace('.', '\\.')));
    assert.match(browserControl, new RegExp(script.replace('.', '\\.')));
  }

  for (const script of GENERIC_EXTRACTOR_SCRIPTS) {
    assert.match(skill, new RegExp(script.replace('.', '\\.')));
    assert.match(resourceHelpers, new RegExp(script.replace('.', '\\.')));
  }
});

test('all JavaScript modules in the skill pass node syntax validation', () => {
  const files = walk(ROOT, (path) => extname(path) === '.mjs');
  const failures = [];

  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
    if (result.status !== 0) failures.push(`${file}\n${result.stderr || result.stdout}`);
  }

  assert.deepEqual(failures, []);
});

test('root directory has no compatibility wrapper scripts outside scripts/', () => {
  const rootFiles = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  assert.deepEqual(rootFiles.filter((name) => name.endsWith('.mjs')), []);
});

test('automation opens new pages in background and does not steal focus', () => {
  const files = walk(ROOT, (path) => extname(path) === '.mjs');
  const foregroundNewPages = [];
  const focusStealers = [];
  const bringToFrontCall = ['bring', 'To', 'Front'].join('');

  for (const file of files) {
    const relativePath = relative(ROOT, file);
    if (relativePath.startsWith('test/')) continue;
    const text = readFileSync(file, 'utf-8');
    const bareNewPagePattern = /\.newPage\s*\(\s*\)/g;
    const newPageWithoutBackground = /\.newPage\s*\(\s*\{(?![^}]*background\s*:\s*true)[^}]*\}\s*\)/g;
    if (bareNewPagePattern.test(text) || newPageWithoutBackground.test(text)) foregroundNewPages.push(relativePath);
    if (text.includes(`${bringToFrontCall}(`)) focusStealers.push(relativePath);
  }

  assert.deepEqual(foregroundNewPages, []);
  assert.deepEqual(focusStealers, []);
  assert.match(readRelative('SKILL.md'), /browser\.newPage\(\{ background: true \}\)/);
  assert.match(readRelative('references/browser-control.md'), /Only call `await page\.bringToFront\(\)` when/);
});

test('Browser Control is the only module allowed to connect to Chrome DevTools directly', () => {
  const files = walk(ROOT, (path) => extname(path) === '.mjs');
  const offenders = [];

  for (const file of files) {
    const relativePath = relative(ROOT, file);
    if (relativePath === 'scripts/browser-control.mjs' || relativePath.startsWith('test/')) continue;
    const text = readFileSync(file, 'utf-8');
    if (text.includes('puppeteer-core') || text.includes('puppeteer.connect')) offenders.push(relativePath);
  }

  assert.deepEqual(offenders, []);
});

test('new browser tabs are opened in the background to avoid stealing focus', () => {
  const files = walk(ROOT, (path) => extname(path) === '.mjs');
  const offenders = [];

  for (const file of files) {
    const relativePath = relative(ROOT, file);
    if (relativePath.startsWith('test/')) continue;
    const text = readFileSync(file, 'utf-8');
    const matches = text.matchAll(/\.newPage\(([^)]*)\)/g);
    for (const match of matches) {
      if (!match[1].includes('background: true')) offenders.push(`${relativePath}: ${match[0]}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test('documented generic extractors use the shared cache and lifecycle module', () => {
  const resourceHelper = readRelative('scripts/resource-helper.mjs');
  assert.match(resourceHelper, /readCachedResponse/);
  assert.match(resourceHelper, /writeCachedResponse/);
  assert.match(resourceHelper, /connectBrowser/);

  for (const script of GENERIC_EXTRACTOR_SCRIPTS) {
    assert.match(readRelative(script), /runBrowserResource/);
  }
});
