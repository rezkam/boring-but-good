import test from 'node:test';
import assert from 'node:assert/strict';
import { isGenericArticleLikeHref, scrapeVisibleText } from '../scripts/scrape-page.mjs';

test('scrape-page keeps next-year keyword-free permalinks', () => {
  assert.equal(isGenericArticleLikeHref('https://example.test/2027/06/plain-permalink-without-topic-keywords'), true);
});

test('scrape-page keeps singular story article paths', () => {
  assert.equal(isGenericArticleLikeHref('https://example.test/story/plain-permalink-without-topic-keywords'), true);
});

test('scrape-page reads textContent when an anchor has no innerText', () => {
  assert.equal(scrapeVisibleText({ textContent: '  SVG linked story headline\nwith spacing  ' }), 'SVG linked story headline with spacing');
  assert.equal(scrapeVisibleText({}), '');
});

test('scrape-page keeps opaque unrelated slugs rejected', () => {
  assert.equal(isGenericArticleLikeHref('https://example.test/research/plain-permalink-without-topic-keywords'), false);
});

test('scrape-page does not require or privilege finance keywords for generic extraction', () => {
  assert.equal(isGenericArticleLikeHref('https://example.test/article/science-discovery-deep-dive'), true);
  assert.equal(isGenericArticleLikeHref('https://example.test/finance/science-discovery-deep-dive'), false);
});
