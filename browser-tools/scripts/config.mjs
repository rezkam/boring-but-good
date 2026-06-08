#!/usr/bin/env node
/**
 * Manage private Browser Tools agent configuration.
 * Stores user-specific profile labels and task preferences outside the repo.
 */

import {
  activeChromeProfiles,
  browserToolsConfigFile,
  ensureBrowserToolsConfig,
  hasFlag,
  optionValue,
  readBrowserToolsConfig,
  setTaskProfiles,
} from './browser-control.mjs';

function usage() {
  console.error(`Usage:
  scripts/config.mjs profiles [--refresh] [--json]
  scripts/config.mjs active-profiles [--refresh] [--json]
  scripts/config.mjs task-profile list [--json]
  scripts/config.mjs task-profile get <task> [--json]
  scripts/config.mjs task-profile set <task> --profile <profile-or-alias> [--profile <profile-or-alias>]

Private config location:
  ${browserToolsConfigFile()}

Config roots:
  AGENT_CONFIG_DIR           Override the shared agent config root. Default: ~/.agents
  BROWSER_TOOLS_CONFIG_DIR   Override only Browser Tools config.

Notes:
  profiles          Creates or reads the cached Chrome profile registry.
  active-profiles   Shows profiles Chrome marks as last active in Local State.
  task-profile      Remembers which profile or profiles to use for non-primary helper tasks.
`);
}

function profileValues(args) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value after --profile');
      values.push(value);
      i += 1;
    }
  }
  return values;
}

function printProfiles(config, { onlyActive = false } = {}) {
  const entries = Object.values(config.profiles || {}).filter((profile) => !onlyActive || profile.lastActive);
  console.log(`Config: ${browserToolsConfigFile()}`);
  if (!entries.length) {
    console.log(onlyActive ? 'No last-active Chrome profiles found in Local State.' : 'No Chrome profiles discovered.');
    return;
  }
  for (const profile of entries) {
    const active = profile.lastActive ? ' active' : '';
    const account = profile.account ? ` account=${profile.account}` : '';
    const name = profile.name && profile.name !== profile.folder ? ` name=${profile.name}` : '';
    console.log(`${profile.folder}${active}${name}${account}`);
  }
}

function printTaskProfiles(config, task = null, { json = false } = {}) {
  const taskProfiles = config.taskProfiles || {};
  const data = task ? taskProfiles[task] || null : taskProfiles;
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (task) {
    if (!data) {
      console.log(`No profile preference for task "${task}".`);
      return;
    }
    console.log(`${task}: ${data.profiles.join(', ')} (default: ${data.defaultProfile})`);
    return;
  }
  const entries = Object.entries(taskProfiles);
  if (!entries.length) {
    console.log('No task profile preferences configured.');
    return;
  }
  for (const [name, entry] of entries) {
    console.log(`${name}: ${entry.profiles.join(', ')} (default: ${entry.defaultProfile})`);
  }
}

const args = process.argv.slice(2);
const command = args[0] || 'profiles';

try {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    usage();
    process.exit(0);
  }

  const refresh = hasFlag(args, '--refresh');
  const json = hasFlag(args, '--json');
  const configDir = optionValue(args, '--config-dir', undefined);

  if (command === 'profiles') {
    const config = ensureBrowserToolsConfig({ configDir, refresh });
    if (json) console.log(JSON.stringify(config, null, 2));
    else printProfiles(config);
  } else if (command === 'active-profiles') {
    const config = ensureBrowserToolsConfig({ configDir, refresh });
    if (json) console.log(JSON.stringify(activeChromeProfiles({ configDir, refresh }), null, 2));
    else printProfiles(config, { onlyActive: true });
  } else if (command === 'task-profile') {
    const action = args[1] || 'list';
    if (action === 'list') {
      printTaskProfiles(ensureBrowserToolsConfig({ configDir, refresh }), null, { json });
    } else if (action === 'get') {
      const task = args[2];
      if (!task) throw new Error('Missing task name');
      printTaskProfiles(ensureBrowserToolsConfig({ configDir, refresh }), task, { json });
    } else if (action === 'set') {
      const task = args[2];
      if (!task) throw new Error('Missing task name');
      const entry = setTaskProfiles(task, profileValues(args.slice(3)), { configDir });
      if (json) console.log(JSON.stringify(entry, null, 2));
      else console.log(`${task}: ${entry.profiles.join(', ')} (default: ${entry.defaultProfile})`);
    } else {
      usage();
      process.exit(1);
    }
  } else {
    usage();
    process.exit(1);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
