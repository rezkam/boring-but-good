#!/usr/bin/env node
/**
 * Scrape all article links + timestamps visible on the current tab.
 * Usage: ./scrape-page.js [--port 9222] [--owner-token token]
 * Outputs JSON: [{headline, href, time}]
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { activePage, parseOwnerToken, parsePort } from './browser-control.mjs';
import { runBrowserResource } from './resource-helper.mjs';

const ARTICLE_LIKE_PATH_SEGMENT_PATTERN = /(?:^|\/)(?:articles?|news|stor(?:y|ies)|(?:19|20)\d{2})(?=\/|$)/i;

if (isDirectExecution()) await main();

async function main() {
  const args = process.argv.slice(2);
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);

  await runBrowserResource({
    port,
    ownerToken,
    getPage: activePage,
    run: async ({ page }) => {
      // Scroll to bottom to trigger lazy-loaded content
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 2000));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 1500));

      const articles = await page.evaluate((articleLikePathSegmentPatternSource, articleLikePathSegmentPatternFlags) => {
        const articleLikePathSegmentPattern = new RegExp(
          articleLikePathSegmentPatternSource,
          articleLikePathSegmentPatternFlags,
        );
        const isGenericArticleLikeHref = (href) => {
          let pathname = href;
          try {
            pathname = new URL(href, 'https://example.invalid').pathname;
          } catch {
            pathname = href;
          }

          return articleLikePathSegmentPattern.test(pathname);
        };
        const scrapeVisibleText = (element) => {
          const raw = typeof element?.innerText === 'string'
            ? element.innerText
            : typeof element?.textContent === 'string'
              ? element.textContent
              : '';
          return raw.trim().replace(/\s+/g, ' ');
        };
        const seen = new Set();
        const results = [];

        // Candidate link selectors (broad)
        const links = Array.from(document.querySelectorAll("a[href]"));

        for (const a of links) {
          const href = a.href;
          const headline = scrapeVisibleText(a);

          // Filter: meaningful headlines, article-like URLs
          if (
            headline.length < 25 ||
            headline.length > 250 ||
            seen.has(headline) ||
            !isGenericArticleLikeHref(href)
          ) continue;

          // Skip nav/footer/promo links
          if (/subscribe|sign.?in|login|newsletter|podcast|video|watch|listen/i.test(headline)) continue;

          seen.add(headline);

          // Try to find a timestamp near this link
          let time = "";
          let el = a;
          for (let i = 0; i < 7; i++) {
            el = el.parentElement;
            if (!el) break;
            const ts = el.querySelector("time, [class*='time'], [class*='timestamp'], [class*='date'], [data-testid*='time']");
            if (ts) { time = scrapeVisibleText(ts) || ts.getAttribute("datetime") || ""; break; }
          }

          results.push({ headline, href, time });
        }

        return results;
      }, ARTICLE_LIKE_PATH_SEGMENT_PATTERN.source, ARTICLE_LIKE_PATH_SEGMENT_PATTERN.flags);

      // Deduplicate by href
      const unique = Object.values(
        Object.fromEntries(articles.map(a => [a.href, a]))
      );

      console.log(JSON.stringify(unique, null, 2));
    },
  });
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

export function scrapeVisibleText(element) {
  const raw = typeof element?.innerText === 'string'
    ? element.innerText
    : typeof element?.textContent === 'string'
      ? element.textContent
      : '';
  return raw.trim().replace(/\s+/g, ' ');
}

export function isGenericArticleLikeHref(href) {
  let pathname = href;
  try {
    pathname = new URL(href, 'https://example.invalid').pathname;
  } catch {
    pathname = href;
  }

  return ARTICLE_LIKE_PATH_SEGMENT_PATTERN.test(pathname);
}
