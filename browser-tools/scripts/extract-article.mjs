#!/usr/bin/env node
/**
 * Extract full article text from the current tab.
 * Usage: ./extract-article.js [--port 9222] [--owner-token token] [--chars 6000]
 */
import { activePage, parseOwnerToken, parsePort, parsePositiveIntegerOption } from './browser-control.mjs';
import { runBrowserResource } from './resource-helper.mjs';

const args = process.argv.slice(2);
let maxChars;
try {
  maxChars = parsePositiveIntegerOption(args, '--chars', 5000);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const port = parsePort(args);
const ownerToken = parseOwnerToken(args);

await runBrowserResource({
  port,
  ownerToken,
  getPage: activePage,
  run: async ({ page }) => {
    // Wait for content to settle
    await new Promise(r => setTimeout(r, 1500));

    const text = await page.evaluate((max) => {
      const url = location.href;
      const title = document.title;

      // Try known article body selectors first
      const selectors = [
        "article",
        "[class*='article-body']",
        "[class*='articleBody']",
        "[class*='story-body']",
        "[class*='StoryBody']",
        "[class*='body-content']",
        "[class*='article__body']",
        "[class*='post-body']",
        "[data-module='ArticleBody']",
        "[data-testid='article-body']",
        "main",
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const txt = el.innerText.trim();
          if (txt.length > 300) return { url, title, body: txt.slice(0, max) };
        }
      }

      // Fallback: collect all visible paragraphs
      const paras = Array.from(document.querySelectorAll("p"))
        .map(p => p.innerText.trim())
        .filter(t => t.length > 50)
        .join("\n\n");

      return { url, title, body: paras.slice(0, max) };
    }, maxChars);

    console.log(`URL: ${text.url}`);
    console.log(`TITLE: ${text.title}`);
    console.log(`---`);
    console.log(text.body);
  },
});
