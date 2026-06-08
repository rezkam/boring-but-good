#!/usr/bin/env node
/**
 * Scrape all article links + timestamps visible on the current tab.
 * Usage: ./scrape-page.js [--port 9222] [--owner-token token]
 * Outputs JSON: [{headline, href, time}]
 */
import { activePage, parseOwnerToken, parsePort } from './browser-control.mjs';
import { runBrowserResource } from './resource-helper.mjs';

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

    const articles = await page.evaluate(() => {
      const seen = new Set();
      const results = [];

      // Candidate link selectors (broad)
      const links = Array.from(document.querySelectorAll("a[href]"));

      for (const a of links) {
        const href = a.href;
        const headline = a.innerText.trim().replace(/\s+/g, " ");

        // Filter: meaningful headlines, article-like URLs
        if (
          headline.length < 25 ||
          headline.length > 250 ||
          seen.has(headline) ||
          !/\/(article|news|story|markets|finance|stocks|economy|business|investing|2026)/.test(href)
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
          if (ts) { time = ts.innerText.trim() || ts.getAttribute("datetime") || ""; break; }
        }

        results.push({ headline, href, time });
      }

      return results;
    });

    // Deduplicate by href
    const unique = Object.values(
      Object.fromEntries(articles.map(a => [a.href, a]))
    );

    console.log(JSON.stringify(unique, null, 2));
  },
});
