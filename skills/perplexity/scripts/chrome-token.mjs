#!/usr/bin/env node
import { connectBrowser, startChrome, stopChrome } from '@rezkam/browser-tools';

const API_BASE_URL = 'https://www.perplexity.ai';
const COOKIE_NAME = '__Secure-next-auth.session-token';
const DEFAULT_PROFILE = 'Default';
const DEFAULT_OWNER_ID = 'perplexity-skill-token';

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parsePort(value) {
  if (!value) return null;
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid Browser Tools port: ${value}`, 2);
  return port;
}

async function pageSessionToken(page) {
  if (!page.url().includes('perplexity.ai')) {
    await page.goto(API_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const cookies = [
    ...(await page.cookies(API_BASE_URL)),
    ...(await page.cookies('https://perplexity.ai')),
  ];
  const cookie = cookies.find((candidate) => candidate.name === COOKIE_NAME && candidate.value);
  if (!cookie?.value) {
    throw new Error(
      'Perplexity session cookie not found in the Browser Tools profile copy. ' +
      'Log in to perplexity.ai in the selected Chrome profile, or restart with a synced profile copy.',
    );
  }
  return cookie.value;
}

async function readTokenFromBrowser(browser) {
  const pages = await browser.pages();
  let page = pages.find((candidate) => candidate.url().includes('perplexity.ai'));
  if (!page) page = await browser.newPage({ background: true });
  return pageSessionToken(page);
}

async function withBrowser(callback) {
  const existingPort = parsePort(process.env.PPLX_BROWSER_TOOLS_PORT || process.env.BROWSER_TOOLS_PORT || process.env.BROWSER_PORT);
  const existingOwnerToken = process.env.BROWSER_TOOLS_OWNER_TOKEN || null;

  if (existingPort) {
    if (!existingOwnerToken) fail('BROWSER_TOOLS_OWNER_TOKEN is required when using an existing Browser Tools port.', 2);
    const browser = await connectBrowser(existingPort, { ownerToken: existingOwnerToken });
    try {
      return await callback(browser);
    } finally {
      browser.disconnect();
    }
  }

  const profileName = process.env.PPLX_BROWSER_TOOLS_PROFILE || process.env.CHROME_PROFILE || DEFAULT_PROFILE;
  const taskName = process.env.PPLX_BROWSER_TOOLS_TASK || null;
  const forceProfileSync = envFlag('PPLX_BROWSER_TOOLS_SYNC', true);
  const ownerToken = process.env.BROWSER_TOOLS_OWNER_TOKEN || null;
  const ownerId = process.env.BROWSER_TOOLS_OWNER_ID || DEFAULT_OWNER_ID;

  const started = await startChrome({
    profileName: taskName ? null : profileName,
    taskName,
    forceProfileSync,
    autoAllocatePort: true,
    ownerToken,
    ownerId,
  });

  let browser;
  try {
    browser = await connectBrowser(started.port, { ownerToken: started.ownerToken });
    return await callback(browser);
  } finally {
    if (browser) browser.disconnect();
    stopChrome({ port: started.port, ownerToken: started.ownerToken });
  }
}

async function main() {
  const token = await withBrowser(readTokenFromBrowser);
  process.stdout.write(token);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error), 2));
