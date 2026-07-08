#!/usr/bin/env node
/**
 * Manual end-to-end check: launch the sandboxed Chrome from a real Chrome profile in
 * headless mode and confirm the copied session is actually signed in to Google.
 *
 * This is NOT part of the automated suite and must never be. It navigates to Google
 * using the copied live session, which is a network side effect, and reconciling the
 * copy with Google can affect the source Chrome's own Google session. The `npm test`
 * glob (test/*.mjs) is single-level, so a file in this subdirectory is never run by it.
 * The check only runs when you pass --run, so an accidental execution does nothing.
 *
 * It prints only a sign-in verdict (PASS/FAIL) and the landing host. It never prints or
 * stores the account identity, and it hardcodes nothing about any specific machine.
 *
 * Usage:
 *   node test/e2e/headless-profile-login.mjs --run
 *   node test/e2e/headless-profile-login.mjs --run --profile "<Chrome profile folder>"
 *   node test/e2e/headless-profile-login.mjs --run --windowed   (open a visible window instead of headless)
 *
 * Exit codes: 0 signed in, 1 signed out, 2 inconclusive, 3 launch/connection error.
 */

import {
  activePage,
  connectBrowser,
  generateOwnerToken,
  hasFlag,
  requiredOptionValue,
  sleep,
  startChrome,
  stopChrome,
} from '../../scripts/browser-control.mjs';

const args = process.argv.slice(2);
const profileName = requiredOptionValue(args, '--profile', 'Default');
const headless = !hasFlag(args, '--windowed');
const confirmed = hasFlag(args, '--run') || hasFlag(args, '--yes');

// myaccount serves the account home to a signed-in session and redirects a signed-out
// one to the accounts.google.com sign-in flow, so the landing host is the sign-in signal.
const LOGIN_PROBE_URL = 'https://myaccount.google.com/';

function log(message) {
  console.error(message);
}

if (!confirmed) {
  log('Live end-to-end check (opt-in). It launches a second Chrome from your copied profile');
  log(`("${profileName}", ${headless ? 'headless' : 'windowed'}) and navigates to Google to read sign-in state.`);
  log('It uses the real copied session, so it is a network side effect and is intentionally not part of `npm test`.');
  log('Reconciling a copied Google session with Google can affect the source Chrome, so only run it on a profile you accept that risk for.');
  log('Re-run with --run to actually perform the check.');
  process.exit(0);
}

const ownerToken = generateOwnerToken();
let port = null;
let browser = null;
let verdict = 'inconclusive';
let landedHost = '';

try {
  log(`⟳ Starting ${headless ? 'headless ' : ''}Chrome from profile "${profileName}" with a fresh profile sync...`);
  const started = await startChrome({
    profileName,
    forceProfileSync: true,
    headless,
    autoAllocatePort: true,
    ownerToken,
    // This check exists to verify a Google-signed-in clone, so it must keep the Google identity;
    // the default sync strips it, which would make the sign-in check always fail.
    includeGoogle: true,
  });
  port = started.port;
  log(`✓ Chrome ready on :${port}${started.headless ? ' (headless)' : ''}`);

  browser = await connectBrowser(port, { ownerToken });
  const page = await activePage(browser);
  await page.goto(LOGIN_PROBE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  // Let any client-side auth redirect settle before reading the final location.
  await sleep(1500);

  const finalUrl = page.url();
  try {
    landedHost = new URL(finalUrl).host;
  } catch {
    landedHost = '';
  }

  // Read a locale-independent DOM signal on whatever page we landed on: the signed-in account
  // avatar links to SignOutOptions, while a signed-out page shows a ServiceLogin link. These
  // are href-based, so they do not depend on the account's language or leak the account identity.
  const signals = await page.evaluate(() => ({
    accountWidget: !!document.querySelector('a[href*="SignOutOptions"], a[href*="accounts.google.com/SignOutOptions"]'),
    signInLink: !!document.querySelector('a[href*="ServiceLogin"], a[href*="/signin/"]'),
  })).catch(() => ({ accountWidget: false, signInLink: false }));

  const redirectedToSignin = landedHost === 'accounts.google.com' || /\/(signin|ServiceLogin|AccountChooser)/i.test(finalUrl);
  const stayedOnAccount = landedHost === 'myaccount.google.com';
  if (stayedOnAccount || signals.accountWidget) verdict = 'logged-in';
  else if (redirectedToSignin || (signals.signInLink && !signals.accountWidget)) verdict = 'logged-out';
  else verdict = 'inconclusive';
} catch (error) {
  log(`✗ ${error.message}`);
  verdict = 'error';
} finally {
  if (browser) browser.disconnect();
  if (port !== null) {
    const stopped = stopChrome({ port, clean: true, ownerToken });
    log(stopped.cleaned ? '✓ Stopped and cleaned up the clone' : `stop status: ${stopped.status}`);
  }
}

const mode = headless ? 'headless' : 'windowed';
if (verdict === 'logged-in') {
  console.log(`PASS: profile "${profileName}" is signed in to Google in ${mode} Chrome (landed on ${landedHost})`);
  process.exit(0);
}
if (verdict === 'logged-out') {
  console.log(`FAIL: profile "${profileName}" is NOT signed in to Google in ${mode} Chrome (redirected to sign-in)`);
  process.exit(1);
}
if (verdict === 'error') {
  console.log(`ERROR: could not complete the ${mode} sign-in check for profile "${profileName}"`);
  process.exit(3);
}
console.log(`INCONCLUSIVE: ${mode} check for profile "${profileName}" landed on "${landedHost || 'unknown host'}"`);
process.exit(2);
