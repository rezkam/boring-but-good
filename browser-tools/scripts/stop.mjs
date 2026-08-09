#!/usr/bin/env node
/**
 * Stop the sandboxed Chrome instance started by start.mjs.
 * Only kills the PID we spawned, never the main Chrome process.
 *
 * Usage:
 *   scripts/stop.mjs
 *   scripts/stop.mjs --port 9223
 *   scripts/stop.mjs --clean
 *   scripts/stop.mjs --dry-run
 *   scripts/stop.mjs --prune            (reap orphans, then remove all cached clones not in use)
 *   scripts/stop.mjs --reap             (kill managed browsers no lifecycle file tracks)
 *   scripts/stop.mjs --reap --dry-run   (list them without killing anything)
 *   scripts/stop.mjs --status           (show how many managed browsers are running)
 *   scripts/stop.mjs --owner-token "$BROWSER_TOOLS_OWNER_TOKEN"
 */

import {
  hasFlag,
  managedBrowserCapacity,
  managedBrowserStartupWarnings,
  parseOwnerToken,
  parsePort,
  pruneChromeClones,
  reapExitCode,
  reapOrphanedChromes,
  stopChrome,
} from './browser-control.mjs';

const args = process.argv.slice(2);
const port = parsePort(args);
const clean = hasFlag(args, '--clean');
const dryRun = hasFlag(args, '--dry-run');
const ownerToken = parseOwnerToken(args);

function reportReaped(reaped, wasDryRun) {
  if (!reaped.length) {
    console.log('No untracked managed browsers found.');
    return;
  }
  for (const entry of reaped) {
    const verb = wasDryRun ? 'Would reap' : entry.status === 'failed' ? '✗ Failed to reap' : '✓ Reaped';
    console.log(`${verb} :${entry.port} (PID ${entry.pid})`);
  }
}

if (hasFlag(args, '--status')) {
  const capacity = managedBrowserCapacity();
  console.log(`${capacity.count} of ${capacity.max} managed Chrome browsers running, ${capacity.remaining} slot(s) free`);
  for (const entry of capacity.processes) {
    const hours = Number.isFinite(entry.ageMs) ? (entry.ageMs / 3600000).toFixed(1) : '?';
    console.log(`  :${entry.port}  PID ${entry.pid}  up ${hours}h`);
  }
  for (const warning of managedBrowserStartupWarnings({ processes: capacity.processes, max: capacity.max })) {
    console.log(`⚠ ${warning}`);
  }
  process.exit(0);
}

if (hasFlag(args, '--reap')) {
  const result = reapOrphanedChromes({ dryRun });
  reportReaped(result.reaped, dryRun);
  // A caller reaping to free a slot must be able to tell that a browser survived.
  process.exit(reapExitCode(result.reaped));
}

if (hasFlag(args, '--prune')) {
  // Reap first: a clone dir held open by an untracked browser is otherwise unreclaimable, which is
  // how 2.4 GB of clones survived every prune during the leak.
  const reaped = reapOrphanedChromes({ dryRun });
  reportReaped(reaped.reaped, dryRun);
  // A real prune reclaims the clones of the browsers just reaped. Tell the dry run to assume the
  // same, otherwise the preview reports those clones as in use and understates what will be removed.
  const freedPorts = reaped.reaped
    .filter((entry) => entry.status === 'would-reap' || entry.status === 'reaped' || entry.status === 'killed' || entry.status === 'already-gone')
    .map((entry) => entry.port);
  const prune = pruneChromeClones({ dryRun, assumeStoppedPorts: dryRun ? freedPorts : [] });
  if (!prune.removed.length && !prune.kept.length) {
    console.log('No cached Chrome clones found.');
  }
  for (const entry of prune.kept) {
    console.log(`• Keeping :${entry.port} (in use by PID ${entry.pid})`);
  }
  for (const entry of prune.removed) {
    const count = entry.paths.length;
    console.log(`${dryRun ? '• Would remove' : '✓ Removed'} clone for :${entry.port} (${count} item${count === 1 ? '' : 's'})`);
  }
  process.exit(reapExitCode(reaped.reaped));
}

const result = stopChrome({ port, clean, dryRun, ownerToken });

if (result.status === 'missing') {
  console.log(`No managed debug Chrome instance found for port ${port}`);
  process.exit(0);
}

if (result.status === 'would-stop') {
  console.log(`✓ Dry run: would stop managed Chrome (PID ${result.pid}) on :${port}`);
} else if (result.status === 'stopped') {
  const reclaimed = result.reclaimedUnowned ? ' (reclaimed: nothing owned it)' : '';
  console.log(`✓ Stopped managed Chrome (PID ${result.pid}) on :${port}${reclaimed}`);
} else if (result.status === 'killed') {
  console.log(`✓ Killed managed Chrome (PID ${result.pid}) on :${port} after SIGTERM did not exit`);
} else if (result.status === 'already-gone') {
  console.log(`✓ Managed Chrome (PID ${result.pid}) was already gone`);
} else if (result.status === 'not-managed') {
  const target = result.pid ? `PID ${result.pid}` : `port ${port}`;
  console.error(`✗ Refusing to stop ${target}: ${result.reason}`);
  console.error('  Safety rule: stop.mjs only kills Chrome processes launched by start.mjs.');
  if (result.hint) console.error(`  ${result.hint}`);
  process.exit(1);
} else if (result.status === 'not-owned') {
  const owner = result.ownerId ? ` owned by ${result.ownerId}` : '';
  console.error(`✗ Refusing to stop managed Chrome on :${port}${owner}: ${result.reason}`);
  console.error('  Safety rule: provide the same --owner-token that start.mjs printed for this browser.');
  process.exit(1);
} else if (result.status === 'locked') {
  console.error(`✗ Refusing to stop managed Chrome on :${port}: ${result.reason}`);
  console.error('  A start operation is still claiming this port. Retry after it finishes.');
  process.exit(1);
} else {
  console.error(`✗ Failed to stop Chrome: ${result.error?.message || 'unknown error'}`);
  process.exit(1);
}

if (result.cleaned) console.log('✓ Cleaned up cached profile copy');
