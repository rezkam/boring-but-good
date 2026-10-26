import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const FINANCE_HELPER_SCRIPTS = [
  'scripts/yahoo-finance.mjs',
  'scripts/perplexity-finance.mjs',
  'scripts/tradingeconomics-markets.mjs',
  'scripts/tradingeconomics-indicators.mjs',
  'scripts/tradingeconomics-forecasts.mjs',
  'scripts/tradingeconomics-country-list.mjs',
];

function walk(dir, predicate, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.pi') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, predicate, files);
    else if (predicate(path)) files.push(path);
  }
  return files;
}

test('all public finance helpers exist and are executable', () => {
  for (const script of FINANCE_HELPER_SCRIPTS) {
    const path = join(ROOT, script);
    assert.equal(existsSync(path), true, `${script} should exist`);
    accessSync(path, constants.X_OK);
    assert.match(readFileSync(path, 'utf-8'), /^#!\/usr\/bin\/env node/, `${script} should be directly executable`);
  }
});

test('all JavaScript modules in the finance skill pass node syntax validation', () => {
  const files = walk(ROOT, path => extname(path) === '.mjs');
  const failures = [];

  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
    if (result.status !== 0) failures.push(`${file}\n${result.stderr || result.stdout}`);
  }

  assert.deepEqual(failures, []);
});

test('finance helpers depend on Browser Tools instead of owning browser management', () => {
  const offenders = [];
  for (const file of walk(ROOT, path => extname(path) === '.mjs')) {
    const relativePath = relative(ROOT, file);
    if (relativePath.startsWith('test/')) continue;
    const text = readFileSync(file, 'utf-8');
    if (text.includes('puppeteer-core') || text.includes('puppeteer.connect')) offenders.push(relativePath);
  }

  assert.deepEqual(offenders, []);

  const siblingUsage = new RegExp(['(?:\\.\\.\\/)+', 'browser-tools', '\\/'].join(''));
  const sourceScriptCommand = new RegExp(['browser-tools', '\\/scripts\\/'].join(''));
  const siblingContract = new RegExp(['(?:sibling.{0,40}browser[ -]tools|browser[ -]tools.{0,40}sibling)'].join(''), 'i');
  const sourceEntryPoint = new RegExp(['`(?:start|stop|config)', '\\.mjs'].join(''), 'i');
  const directUsage = walk(ROOT, path => ['.mjs', '.md', '.json'].includes(extname(path)))
    .filter(path => !path.endsWith('package-lock.json'))
    .filter(path => relative(ROOT, path) !== 'test/skill-contract.test.mjs')
    .filter(path => {
      const text = readFileSync(path, 'utf-8');
      return siblingUsage.test(text)
        || sourceScriptCommand.test(text)
        || siblingContract.test(text)
        || sourceEntryPoint.test(text);
    })
    .map(path => relative(ROOT, path));
  assert.deepEqual(directUsage, []);
});
