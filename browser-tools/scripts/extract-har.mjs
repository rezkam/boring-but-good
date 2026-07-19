#!/usr/bin/env node
/**
 * Extract a compact chronological network recipe from a HAR file for agent analysis.
 * This command never replays requests.
 *
 * Usage:
 *   scripts/extract-har.mjs ./checkout_api_network.har
 *   scripts/extract-har.mjs ./checkout_api_network.har --output ./checkout_api_recipe.json
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFlag, optionValue, requiredOptionValue } from './browser-control.mjs';
import {
  isSensitiveName,
  matchesPatterns,
  matchesStatus,
  normalizeResourceTypes,
  optionValues,
  parseStatusSelectors,
  privateOutputPath,
  redactBodyText,
  redactSensitive,
  resourceTypesForPreset,
  writePrivateJson,
} from './cdp-common.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function usage() {
  console.error(`Usage: browser-tools extract-har <capture.har> [options]

Options:
  --output <meaningful.json>       Recipe output path
  --preset <api|page|all>          Resource preset (default: api)
  --resource-type <types>          Include CDP resource types
  --exclude-resource-type <types>
  --url-pattern <glob>             Include URL glob, repeatable
  --exclude-url-pattern <glob>
  --method <methods>
  --exclude-method <methods>
  --status <code|range>
  --exclude-status <code|range>
  --mime-type <glob>
  --exclude-mime-type <glob>
  --redact                         Redact sensitive-looking values from the recipe
  --overwrite                      Replace an existing recipe
  --json                           Print extraction metadata as JSON

The recipe preserves chronological request structure for an agent to inspect and use
when writing a separate fetch, curl, or browser-backed replay script. It never executes requests.`);
}

function harInputPath(value) {
  if (!value || value.startsWith('--')) throw new Error('Missing HAR path');
  const path = resolve(value);
  if (extname(path).toLowerCase() !== '.har') throw new Error(`HAR input must end in .har: ${value}`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`HAR input not found: ${path}`);
  return path;
}

function defaultOutputPath(input) {
  const stem = parse(basename(input)).name.replace(/[^a-zA-Z0-9._-]/g, '-');
  return join(dirname(input), `${stem}-recipe.json`);
}

function parseOptions(args) {
  const preset = String(optionValue(args, '--preset', 'api')).toLowerCase();
  const explicitTypes = normalizeResourceTypes(optionValues(args, '--resource-type'));
  const presetTypes = explicitTypes.length && !args.includes('--preset') ? [] : resourceTypesForPreset(preset);
  return {
    preset,
    resourceTypes: [...new Set([...presetTypes, ...explicitTypes])],
    excludedResourceTypes: normalizeResourceTypes(optionValues(args, '--exclude-resource-type')),
    urlPatterns: optionValues(args, '--url-pattern'),
    excludedUrlPatterns: optionValues(args, '--exclude-url-pattern'),
    methods: optionValues(args, '--method').map((method) => method.toUpperCase()),
    excludedMethods: optionValues(args, '--exclude-method').map((method) => method.toUpperCase()),
    statuses: parseStatusSelectors(optionValues(args, '--status')),
    excludedStatuses: parseStatusSelectors(optionValues(args, '--exclude-status')),
    mimeTypes: optionValues(args, '--mime-type'),
    excludedMimeTypes: optionValues(args, '--exclude-mime-type'),
    redact: hasFlag(args, '--redact'),
  };
}

function entryMatches(entry, options) {
  const type = entry._resourceType || 'Other';
  const method = String(entry.request?.method || '').toUpperCase();
  const status = Number(entry.response?.status || 0);
  const mimeType = entry.response?.content?.mimeType || '';
  if (!options.resourceTypes.includes(type) || options.excludedResourceTypes.includes(type)) return false;
  if (options.methods.length && !options.methods.includes(method)) return false;
  if (options.excludedMethods.includes(method)) return false;
  if (!matchesPatterns(entry.request?.url, options.urlPatterns, options.excludedUrlPatterns)) return false;
  if (!matchesStatus(status, options.statuses, options.excludedStatuses)) return false;
  return matchesPatterns(mimeType, options.mimeTypes, options.excludedMimeTypes);
}

function headerObject(headers = []) {
  return Object.fromEntries(headers.map((header) => [String(header.name).toLowerCase(), String(header.value)]));
}

function bodyRecipe(value, mimeType = '', encoding = null, { redact = false } = {}) {
  if (value === undefined) return null;
  const text = redact && !encoding ? redactBodyText(value, mimeType) : value;
  const result = { mime_type: mimeType || 'application/octet-stream', text };
  if (encoding) result.encoding = encoding;
  if (!encoding && (String(mimeType).toLowerCase().includes('json') || /^[\s]*[\[{]/.test(String(value)))) {
    try {
      result.json = JSON.parse(text);
    } catch {
      // Keep malformed or truncated JSON as text only.
    }
  }
  return result;
}

export function extractHarRecipe(har, sourceHar, options) {
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : null;
  if (!entries) throw new Error(`Invalid HAR 1.2 log: ${sourceHar}`);
  const requests = entries
    .filter((entry) => entryMatches(entry, options))
    .map((entry, index) => ({
      sequence: index + 1,
      started_at: entry.startedDateTime || null,
      resource_type: entry._resourceType || 'Other',
      method: entry.request.method,
      url: entry.request.url,
      headers: headerObject(entry.request.headers),
      query: (entry.request.queryString || []).map((parameter) => ({
        ...parameter,
        value: options.redact && isSensitiveName(parameter.name) ? '<redacted>' : parameter.value,
      })),
      body: bodyRecipe(
        entry.request.postData?.text,
        entry.request.postData?.mimeType,
        null,
        { redact: options.redact },
      ),
      response: {
        status: entry.response.status,
        status_text: entry.response.statusText,
        headers: headerObject(entry.response.headers),
        mime_type: entry.response.content?.mimeType || '',
        body: bodyRecipe(
          entry.response.content?.text,
          entry.response.content?.mimeType,
          entry.response.content?.encoding || null,
          { redact: options.redact },
        ),
      },
      timing: {
        total_ms: entry.time,
        ...entry.timings,
      },
      failure: entry._failure || null,
    }));

  const recipe = {
    version: 1,
    kind: 'browser-tools-network-recipe',
    source_har: sourceHar,
    generated_at: new Date().toISOString(),
    filters: {
      preset: options.preset,
      resource_types: options.resourceTypes,
      excluded_resource_types: options.excludedResourceTypes,
      url_patterns: options.urlPatterns,
      excluded_url_patterns: options.excludedUrlPatterns,
      methods: options.methods,
      excluded_methods: options.excludedMethods,
      statuses: options.statuses,
      excluded_statuses: options.excludedStatuses,
      mime_types: options.mimeTypes,
      excluded_mime_types: options.excludedMimeTypes,
    },
    request_count: requests.length,
    requests,
    notes: [
      'This file describes captured requests but does not execute them.',
      'Validate dynamic tokens, cookies, ordering dependencies, and side effects before writing or running a replay script.',
    ],
  };
  return options.redact ? redactSensitive(recipe) : recipe;
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    usage();
    return args.length ? 0 : 1;
  }
  const input = harInputPath(args[0]);
  const rest = args.slice(1);
  const overwrite = hasFlag(rest, '--overwrite');
  const requestedOutput = requiredOptionValue(rest, '--output', null) || defaultOutputPath(input);
  const output = privateOutputPath(requestedOutput, 'json', { overwrite });
  const options = parseOptions(rest);
  const har = JSON.parse(readFileSync(input, 'utf-8'));
  const recipe = extractHarRecipe(har, input, options);
  writePrivateJson(output, recipe);

  const report = { input, output, request_count: recipe.request_count };
  if (hasFlag(rest, '--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`HAR: ${input}`);
    console.log(`Recipe: ${output}`);
    console.log(`Requests: ${recipe.request_count}`);
  }
  return 0;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(SCRIPT_FILE);
}

if (isDirectExecution()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
