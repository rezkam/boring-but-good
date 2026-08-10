import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function privateArtifact(pathname, mode, kind) {
  let info;
  try { info = lstatSync(pathname); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new Error(`[browser-query-cache] Cannot inspect private ${kind} ${pathname}: ${error.message}`);
  }
  const correctKind = kind === 'directory' ? info.isDirectory() : info.isFile();
  if (info.isSymbolicLink() || !correctKind || (info.mode & 0o777) !== mode) {
    throw new Error(`[browser-query-cache] Refusing unsafe private ${kind} ${pathname}: it must be a real ${kind} with mode 0${mode.toString(8)}.`);
  }
  return true;
}

function ensureDir(dir) {
  if (privateArtifact(dir, PRIVATE_DIR_MODE, 'directory')) return;
  try {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (!privateArtifact(dir, PRIVATE_DIR_MODE, 'directory')) throw new Error('directory was not created');
  } catch (error) {
    if (String(error.message || '').startsWith('[browser-query-cache]')) throw error;
    throw new Error(`[browser-query-cache] Cannot create private cache directory ${dir}: ${error.message}`);
  }
}

function writePrivateFile(file, value) {
  // Existing paths are checked before opening so a symlink or permissive file is
  // never followed, chmodded, truncated, or overwritten.
  privateArtifact(file, PRIVATE_FILE_MODE, 'file');
  try {
    writeFileSync(file, value, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE, flag: 'w' });
    if (!privateArtifact(file, PRIVATE_FILE_MODE, 'file')) throw new Error('file was not created');
  } catch (error) {
    if (String(error.message || '').startsWith('[browser-query-cache]')) throw error;
    throw new Error(`[browser-query-cache] Cannot write private cache file ${file}: ${error.message}`);
  }
}
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function isFreshEnough(createdAt, ttlSeconds) {
  if (ttlSeconds === null || ttlSeconds === undefined) return true;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) return false;
  const ts = Date.parse(createdAt || '');
  return Number.isFinite(ts) && Date.now() - ts <= ttlSeconds * 1000;
}
function parseTtlSeconds(value = process.env.BROWSER_QUERY_TTL_SECONDS) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim(); if (!raw) return null;
  const ttlSeconds = Number(raw);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) throw new Error(`Invalid BROWSER_QUERY_TTL_SECONDS: expected a non-negative number of seconds, got "${value}"`);
  return ttlSeconds;
}
export function getCacheConfig() {
  const cacheDir = process.env.BROWSER_QUERY_CACHE_DIR; if (!cacheDir) return null;
  return { cacheDir, entriesDir: path.join(cacheDir, 'entries'), responsesDir: path.join(cacheDir, 'responses'), rawDir: path.join(cacheDir, 'raw'), invocationsDir: process.env.BROWSER_QUERY_RUN_DIR && process.env.BROWSER_QUERY_STEP_ID ? path.join(process.env.BROWSER_QUERY_RUN_DIR, 'browser-tool-calls', process.env.BROWSER_QUERY_STEP_ID) : null, stepId: process.env.BROWSER_QUERY_STEP_ID || null, stepLabel: process.env.BROWSER_QUERY_STEP_LABEL || null, runDir: process.env.BROWSER_QUERY_RUN_DIR || null, ttlSeconds: parseTtlSeconds() };
}
export function buildCacheKey(tool, input) { return sha256(stable({ tool, input })); }
export function readCachedResponse(tool, input) {
  const cfg = getCacheConfig(); if (!cfg) return null;
  const key = buildCacheKey(tool, input); const entryPath = path.join(cfg.entriesDir, `${key}.json`);
  privateArtifact(cfg.cacheDir, PRIVATE_DIR_MODE, 'directory'); privateArtifact(cfg.entriesDir, PRIVATE_DIR_MODE, 'directory');
  if (!privateArtifact(entryPath, PRIVATE_FILE_MODE, 'file')) return null;
  const entry = JSON.parse(readFileSync(entryPath, 'utf-8'));
  if (!isFreshEnough(entry.created_at, cfg.ttlSeconds)) { recordInvocation(tool, key, { cache_hit: false, cache_stale: true, input, response_path: entry.response_path || null, raw_path: entry.raw_path || null, page_url: entry.page_url || null, metadata: entry.metadata || null, cached_at: entry.created_at || null, ttl_seconds: cfg.ttlSeconds }); return null; }
  const responsePath = entry.response_path; if (!responsePath) return null;
  privateArtifact(path.dirname(responsePath), PRIVATE_DIR_MODE, 'directory'); if (!privateArtifact(responsePath, PRIVATE_FILE_MODE, 'file')) return null;
  const output = readFileSync(responsePath, 'utf-8');
  if (entry.raw_path) privateArtifact(path.dirname(entry.raw_path), PRIVATE_DIR_MODE, 'directory');
  const rawText = entry.raw_path && privateArtifact(entry.raw_path, PRIVATE_FILE_MODE, 'file') ? readFileSync(entry.raw_path, 'utf-8') : output;
  recordInvocation(tool, key, { cache_hit: true, input, response_path: responsePath, raw_path: entry.raw_path || null, page_url: entry.page_url || null, metadata: entry.metadata || null, cached_at: entry.created_at || null, ttl_seconds: cfg.ttlSeconds });
  return { key, entryPath, entry, output, rawText };
}
export function writeCachedResponse(tool, input, payload) {
  const cfg = getCacheConfig(); if (!cfg) return null; const key = buildCacheKey(tool, input);
  ensureDir(cfg.cacheDir); ensureDir(cfg.entriesDir); ensureDir(cfg.responsesDir); ensureDir(path.join(cfg.responsesDir, tool)); ensureDir(cfg.rawDir); ensureDir(path.join(cfg.rawDir, tool));
  const extension = payload.extension || 'txt'; const responsePath = path.join(cfg.responsesDir, tool, `${key}.${extension}`); const rawPath = payload.rawText ? path.join(cfg.rawDir, tool, `${key}.txt`) : null;
  writePrivateFile(responsePath, payload.output); if (rawPath) writePrivateFile(rawPath, payload.rawText);
  const entry = { key, tool, created_at: new Date().toISOString(), input, input_hash: key, page_url: payload.pageUrl || null, response_path: responsePath, raw_path: rawPath, metadata: payload.metadata || null };
  const entryPath = path.join(cfg.entriesDir, `${key}.json`); writePrivateFile(entryPath, JSON.stringify(entry, null, 2));
  recordInvocation(tool, key, { cache_hit: false, input, response_path: responsePath, raw_path: rawPath, page_url: payload.pageUrl || null, metadata: payload.metadata || null }); return { key, entryPath, responsePath, rawPath };
}
export function recordInvocation(tool, key, details) {
  const cfg = getCacheConfig(); if (!cfg?.invocationsDir) return;
  ensureDir(cfg.runDir); ensureDir(path.join(cfg.runDir, 'browser-tool-calls')); ensureDir(cfg.invocationsDir);
  const invocation = { ts: new Date().toISOString(), tool, key, step_id: cfg.stepId, step_label: cfg.stepLabel, run_dir: cfg.runDir, ...details };
  writePrivateFile(path.join(cfg.invocationsDir, `${nowStamp()}-${tool}-${key.slice(0, 10)}.json`), JSON.stringify(invocation, null, 2));
}
