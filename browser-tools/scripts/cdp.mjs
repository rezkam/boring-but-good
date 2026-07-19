#!/usr/bin/env node
/**
 * Send owner-protected CDP calls to the active managed-browser tab.
 *
 * Usage:
 *   scripts/cdp.mjs call Runtime.evaluate --params '{"expression":"document.title"}'
 *   scripts/cdp.mjs call Network.getCookies --params-file ./params.json --redact
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OWNER_TOKEN_ENV,
  hasFlag,
  parseOwnerToken,
  parsePort,
  requiredOptionValue,
} from './browser-control.mjs';
import {
  redactBodyText,
  redactSensitive,
  validateCdpMethod,
  withPageCdpSession,
} from './cdp-common.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function usage() {
  console.error(`Usage: browser-tools cdp call <Domain.method> [options]

Options:
  --params <json>          CDP parameters as a JSON object
  --params-file <path>     Read parameters from a file instead of process arguments
  --redact                 Redact sensitive-looking values from the result
  --port <n>               Managed browser port (default: 9222)
  --owner-token <token>    Prefer ${OWNER_TOKEN_ENV} instead

Direct calls target the active tab and require its owner token. Methods that bypass
managed-browser lifecycle safety are blocked. Prefer --params-file for sensitive input.`);
}

function parseParams(args) {
  const inline = requiredOptionValue(args, '--params', null);
  const file = requiredOptionValue(args, '--params-file', null);
  if (inline && file) throw new Error('Use only one of --params or --params-file');
  const source = file ? readFileSync(file, 'utf-8') : (inline || '{}');
  let params;
  try {
    params = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid CDP params JSON: ${error.message}`);
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('CDP params must be a JSON object');
  }
  return params;
}

export function sanitizeCdpCallResult(method, result, { redact = false } = {}) {
  if (!redact) return result;
  const output = redactSensitive(result);
  if ((method === 'Network.getResponseBody' || method === 'Fetch.getResponseBody') && output.body && !output.base64Encoded) {
    output.body = redactBodyText(output.body, '');
  }
  if (method === 'Network.getRequestPostData' && output.postData) {
    output.postData = redactBodyText(output.postData, '');
  }
  return output;
}

async function callMethod(args) {
  const method = validateCdpMethod(args[0]);
  const rest = args.slice(1);
  const port = parsePort(rest);
  const ownerToken = parseOwnerToken(rest);
  if (!ownerToken) {
    throw new Error(`Missing browser owner token. Export ${OWNER_TOKEN_ENV} with the token printed by browser-tools start`);
  }
  const params = parseParams(rest);
  const result = await withPageCdpSession(port, ownerToken, ({ session }) => session.send(method, params));
  const output = sanitizeCdpCallResult(method, result, { redact: hasFlag(rest, '--redact') });
  console.log(JSON.stringify(output, null, 2));
}

export async function main(args = process.argv.slice(2)) {
  const [command] = args;
  if (!command || command === '--help' || command === '-h') {
    usage();
    return command ? 0 : 1;
  }
  if (command === 'call') await callMethod(args.slice(1));
  else {
    usage();
    throw new Error(`Unknown cdp command: ${command}`);
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
