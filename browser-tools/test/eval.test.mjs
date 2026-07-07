import test from 'node:test';
import assert from 'node:assert/strict';
import { formatResultLines } from '../scripts/eval.mjs';

test('eval result formatting preserves nested object values', () => {
  assert.deepEqual(formatResultLines({
    title: 'Example',
    details: { author: 'Example Author', stats: { views: 3 } },
    published: true,
  }), [
    'title: Example',
    'details: {"author":"Example Author","stats":{"views":3}}',
    'published: true',
  ]);
});

test('eval result formatting preserves nested array values', () => {
  assert.deepEqual(formatResultLines({
    links: ['https://example.test/a', { href: 'https://example.test/b', labels: ['docs', 'api'] }],
    counts: [1, 2],
  }), [
    'links: ["https://example.test/a",{"href":"https://example.test/b","labels":["docs","api"]}]',
    'counts: [1,2]',
  ]);
});

test('eval result formatting keeps primitive and top-level array output readable', () => {
  assert.deepEqual(formatResultLines('hello'), ['hello']);
  assert.deepEqual(formatResultLines(3), ['3']);
  assert.deepEqual(formatResultLines(-0), ['-0']);
  assert.deepEqual(formatResultLines(1n), ['1n']);
  assert.deepEqual(formatResultLines([{ name: 'first' }, { name: 'second' }]), [
    'name: first',
    '',
    'name: second',
  ]);
});
