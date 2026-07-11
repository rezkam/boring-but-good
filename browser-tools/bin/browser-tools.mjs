#!/usr/bin/env node
/**
 * `browser-tools` CLI dispatcher.
 *
 * This is packaging only: it does not reimplement browser lifecycle, profile, or safety
 * logic. It resolves a subcommand to the matching script under scripts/ and runs it exactly
 * as it would run from the skill (`scripts/<name>.mjs [args]`), forwarding argv and exit code.
 *
 * Usage:
 *   browser-tools start [--task <task>] [--profile <name>] [--headless] [--sync] [--port <n>]
 *   browser-tools status [--port <n>] [--json]
 *   browser-tools stop [--clean] [--dry-run] [--prune]
 *   browser-tools nav <url> [--new] [--port <n>]
 *   browser-tools eval '<javascript>' [--port <n>]
 *   browser-tools screenshot [--full] [--port <n>]
 *   browser-tools pick "<instruction>" [--port <n>]
 *   browser-tools scrape-page [--port <n>]
 *   browser-tools extract-article [--chars <n>] [--port <n>]
 *   browser-tools config profiles|active-profiles|task-profile ...
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// Maps each CLI subcommand to the existing script it dispatches to unchanged.
const COMMANDS = {
  start: 'start.mjs',
  status: 'status.mjs',
  stop: 'stop.mjs',
  nav: 'nav.mjs',
  eval: 'eval.mjs',
  screenshot: 'screenshot.mjs',
  pick: 'pick.mjs',
  'scrape-page': 'scrape-page.mjs',
  'extract-article': 'extract-article.mjs',
  config: 'config.mjs',
};

function printUsage() {
  console.error(`Usage: browser-tools <command> [args]

Commands:
${Object.keys(COMMANDS).map((name) => `  ${name}`).join('\n')}

Each command forwards its arguments to the matching browser-tools script.
See the package README or SKILL.md for the full flag reference per command.`);
}

const [, , command, ...rest] = process.argv;

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(command ? 0 : 1);
}

const scriptFile = COMMANDS[command];
if (!scriptFile) {
  console.error(`✗ Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

const result = spawnSync(process.execPath, [join(SCRIPTS_DIR, scriptFile), ...rest], { stdio: 'inherit' });
if (result.error) {
  console.error(`✗ Failed to run ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
