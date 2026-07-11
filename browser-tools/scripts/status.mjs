#!/usr/bin/env node
/**
 * Report whether a managed Chrome instance is running for a port.
 * Reads the same managed-state file start.mjs writes and stop.mjs verifies; never launches
 * or connects to Chrome itself.
 *
 * Usage:
 *   scripts/status.mjs
 *   scripts/status.mjs --port 9223
 *   scripts/status.mjs --json
 */

import { hasFlag, managedBrowserSafetyForPort, parsePort, readManagedStateForPort } from './browser-control.mjs';

const args = process.argv.slice(2);
const port = parsePort(args);
const json = hasFlag(args, '--json');

const state = readManagedStateForPort(port);

if (!state) {
  if (json) console.log(JSON.stringify({ running: false, port }, null, 2));
  else console.log(`No managed Chrome instance found for port ${port}`);
  process.exit(0);
}

const safety = managedBrowserSafetyForPort(port);
const running = Boolean(safety.ok);

const report = {
  running,
  port,
  pid: state.pid ?? null,
  profileName: state.profileName ?? null,
  headless: Boolean(state.headless),
  includeGoogle: Boolean(state.includeGoogle),
  ownerId: state.ownerId ?? null,
  startedAt: state.startedAt ?? null,
  reason: running ? null : safety.reason,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else if (running) {
  const mode = report.headless ? ' (headless)' : '';
  const profile = report.profileName ? ` profile="${report.profileName}"` : '';
  const owner = report.ownerId ? ` owner=${report.ownerId}` : '';
  console.log(`✓ Managed Chrome running on :${port}${mode} (PID ${report.pid})${profile}${owner}`);
} else {
  console.log(`✗ Managed state found for :${port}, but the browser is not verified running (${report.reason})`);
}
