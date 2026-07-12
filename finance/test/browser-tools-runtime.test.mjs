import test from 'node:test';
import assert from 'node:assert/strict';
import { optionValue } from '../scripts/browser-tools-runtime.mjs';

test('finance helper option parsing rejects missing and option-like values', () => {
  assert.equal(optionValue([], '--out'), null);
  assert.equal(optionValue(['--out', '/tmp/quotes.md'], '--out'), '/tmp/quotes.md');

  assert.throws(() => optionValue(['--out'], '--out'), /Missing value after --out/);
  assert.throws(() => optionValue(['--tickers', '--json'], '--tickers'), /Missing value after --tickers/);
});
