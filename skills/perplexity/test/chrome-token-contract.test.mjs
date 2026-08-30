import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(ROOT, 'scripts', 'chrome-token.mjs'), 'utf8');

test('chrome token uses the published Browser Tools package', () => {
  assert.match(source, /from '@rezkam\/browser-tools'/);
  assert.match(source, /\bconnectBrowser\(/);
  assert.match(source, /\bstartChrome\(/);
  assert.match(source, /\bstopChrome\(/);
});

test('chrome token has no local Browser Tools fallback', () => {
  for (const pattern of [
    /BROWSER_TOOLS_DIR/,
    /pathToFileURL/,
    /browser-tools\/scripts/,
    /(?:\.\.\/)+browser-tools\//,
    /boring-but-good\/browser-tools/,
  ]) {
    assert.doesNotMatch(source, pattern);
  }
});

test('perplexity package declares the published Browser Tools package', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.engines?.node, '>=20');
  assert.equal(packageJson.dependencies?.['@rezkam/browser-tools'], '^1.0.3');
});
