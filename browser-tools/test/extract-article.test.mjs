import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'scripts/extract-article.mjs');

function runExtractArticle(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      BROWSER_TOOLS_OWNER_TOKEN: 'test-owner-token',
    },
  });
}

for (const { name, args, pattern } of [
  { name: 'missing --chars value', args: ['--port', '1', '--chars'], pattern: /Missing --chars value/ },
  { name: 'non-numeric --chars value', args: ['--port', '1', '--chars', 'abc'], pattern: /Invalid --chars value/ },
  { name: 'option-like --chars value', args: ['--port', '1', '--chars', '--port', '9223'], pattern: /Missing --chars value/ },
  { name: 'zero --chars value', args: ['--port', '1', '--chars', '0'], pattern: /Invalid --chars value/ },
]) {
  test(`extract-article rejects ${name} before connecting to Chrome`, () => {
    const result = runExtractArticle(args);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stderr, /Refusing to connect|Chrome/);
  });
}
