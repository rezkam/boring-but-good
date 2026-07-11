import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC_BROWSER_CONTROL_SCRIPTS = [
  'scripts/config.mjs',
  'scripts/start.mjs',
  'scripts/status.mjs',
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
// The installed `browser-tools` CLI (bin/browser-tools.mjs) dispatches one subcommand per
// script above. The skill docs describe the CLI form, not the raw script path, so derive the
// documented contract from the same script list instead of hand-maintaining a second list.
const scriptToSubcommand = (script) => script.replace('scripts/', '').replace('.mjs', '');
const CLI_SUBCOMMANDS = [...PUBLIC_BROWSER_CONTROL_SCRIPTS, ...GENERIC_EXTRACTOR_SCRIPTS].map(scriptToSubcommand);

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

test('SKILL.md and browser-control.md document every public browser-tools CLI subcommand', () => {
  const skill = readRelative('SKILL.md');
  const browserControl = readRelative('references/browser-control.md');

  for (const subcommand of CLI_SUBCOMMANDS) {
    const pattern = new RegExp(`browser-tools ${subcommand}\\b`);
    assert.match(skill, pattern, `SKILL.md should document \`browser-tools ${subcommand}\``);
    assert.match(browserControl, pattern, `browser-control.md should document \`browser-tools ${subcommand}\``);
  }

  assert.match(skill, /Extract article-like visible links/);
  assert.match(browserControl, /Extract article-like visible links/);
});

test('SKILL.md documents the npm package setup required to install the browser-tools CLI', () => {
  const skill = readRelative('SKILL.md');

  assert.match(skill, /npm install -g @rezkam\/browser-tools/);
  assert.match(skill, /npx @rezkam\/browser-tools/);
});

test('resource-helpers.md documents the generic extractor scripts the CLI dispatches to', () => {
  const resourceHelpers = readRelative('references/resource-helpers.md');

  for (const script of GENERIC_EXTRACTOR_SCRIPTS) {
    assert.match(resourceHelpers, new RegExp(script.replace('.', '\\.')));
  }

  assert.match(resourceHelpers, /Extract article-like visible links and nearby timestamps/);
});

test('start guidance prefers owner token environment variable over CLI token argument', () => {
  const startScript = readRelative('scripts/start.mjs');

  assert.match(startScript, /export BROWSER_TOOLS_OWNER_TOKEN/);
  assert.doesNotMatch(startScript, /--owner-token \$\{result\.ownerToken\}/);
});

test('Browser Control docs document legacy profile config compatibility', () => {
  const browserControl = readRelative('references/browser-control.md');

  assert.match(browserControl, /Legacy profile config compatibility/);
  assert.match(browserControl, /browserToolsProfilesConfigFile/);
  assert.match(browserControl, /buildChromeProfilesConfig/);
  assert.match(browserControl, /new code should use `browserToolsRuntimeConfig`/i);
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

test('documented current-tab extractors use uncached lifecycle while reusable resources keep cache support', () => {
  const resourceHelper = readRelative('scripts/resource-helper.mjs');
  const resourceHelpersReference = readRelative('references/resource-helpers.md');
  assert.match(resourceHelper, /readCachedResponse/);
  assert.match(resourceHelper, /writeCachedResponse/);
  assert.match(resourceHelper, /connectBrowser/);
  assert.match(resourceHelper, /runCachedBrowserResource/);
  assert.match(resourceHelpersReference, /Current-tab extractors[\s\S]*do not use `BROWSER_QUERY_\*` caching/);
  assert.match(resourceHelpersReference, /`runCachedBrowserResource`[\s\S]*uses `BROWSER_QUERY_\*` caching/);

  for (const script of GENERIC_EXTRACTOR_SCRIPTS) {
    const text = readRelative(script);
    assert.match(text, /runBrowserResource/);
    assert.doesNotMatch(text, /runCachedBrowserResource/);
  }
});
