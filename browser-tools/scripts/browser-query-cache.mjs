import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isFreshEnough(createdAt, ttlSeconds) {
  if (!ttlSeconds) return true;
  const ts = Date.parse(createdAt || '');
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= ttlSeconds * 1000;
}

export function getCacheConfig() {
  const cacheDir = process.env.BROWSER_QUERY_CACHE_DIR;
  if (!cacheDir) return null;
  return {
    cacheDir,
    entriesDir: path.join(cacheDir, 'entries'),
    responsesDir: path.join(cacheDir, 'responses'),
    rawDir: path.join(cacheDir, 'raw'),
    invocationsDir: process.env.BROWSER_QUERY_RUN_DIR && process.env.BROWSER_QUERY_STEP_ID
      ? path.join(process.env.BROWSER_QUERY_RUN_DIR, 'browser-tool-calls', process.env.BROWSER_QUERY_STEP_ID)
      : null,
    stepId: process.env.BROWSER_QUERY_STEP_ID || null,
    stepLabel: process.env.BROWSER_QUERY_STEP_LABEL || null,
    runDir: process.env.BROWSER_QUERY_RUN_DIR || null,
    ttlSeconds: process.env.BROWSER_QUERY_TTL_SECONDS ? Number(process.env.BROWSER_QUERY_TTL_SECONDS) : null,
  };
}

export function buildCacheKey(tool, input) {
  return sha256(stable({ tool, input }));
}

export function readCachedResponse(tool, input) {
  const cfg = getCacheConfig();
  if (!cfg) return null;
  const key = buildCacheKey(tool, input);
  const entryPath = path.join(cfg.entriesDir, `${key}.json`);
  if (!existsSync(entryPath)) return null;
  const entry = JSON.parse(readFileSync(entryPath, 'utf-8'));
  if (!isFreshEnough(entry.created_at, cfg.ttlSeconds)) {
    recordInvocation(tool, key, {
      cache_hit: false,
      cache_stale: true,
      input,
      response_path: entry.response_path || null,
      raw_path: entry.raw_path || null,
      page_url: entry.page_url || null,
      metadata: entry.metadata || null,
      cached_at: entry.created_at || null,
      ttl_seconds: cfg.ttlSeconds,
    });
    return null;
  }
  const responsePath = entry.response_path;
  if (!responsePath || !existsSync(responsePath)) return null;
  const output = readFileSync(responsePath, 'utf-8');
  const rawText = entry.raw_path && existsSync(entry.raw_path) ? readFileSync(entry.raw_path, 'utf-8') : output;
  recordInvocation(tool, key, {
    cache_hit: true,
    input,
    response_path: responsePath,
    raw_path: entry.raw_path || null,
    page_url: entry.page_url || null,
    metadata: entry.metadata || null,
    cached_at: entry.created_at || null,
    ttl_seconds: cfg.ttlSeconds,
  });
  return { key, entryPath, entry, output, rawText };
}

export function writeCachedResponse(tool, input, payload) {
  const cfg = getCacheConfig();
  if (!cfg) return null;
  const key = buildCacheKey(tool, input);
  ensureDir(cfg.entriesDir);
  ensureDir(path.join(cfg.responsesDir, tool));
  ensureDir(path.join(cfg.rawDir, tool));
  const extension = payload.extension || 'txt';
  const responsePath = path.join(cfg.responsesDir, tool, `${key}.${extension}`);
  const rawPath = payload.rawText ? path.join(cfg.rawDir, tool, `${key}.txt`) : null;
  writeFileSync(responsePath, payload.output, 'utf-8');
  if (rawPath) writeFileSync(rawPath, payload.rawText, 'utf-8');
  const entry = {
    key,
    tool,
    created_at: new Date().toISOString(),
    input,
    input_hash: key,
    page_url: payload.pageUrl || null,
    response_path: responsePath,
    raw_path: rawPath,
    metadata: payload.metadata || null,
  };
  const entryPath = path.join(cfg.entriesDir, `${key}.json`);
  writeFileSync(entryPath, JSON.stringify(entry, null, 2), 'utf-8');
  recordInvocation(tool, key, {
    cache_hit: false,
    input,
    response_path: responsePath,
    raw_path: rawPath,
    page_url: payload.pageUrl || null,
    metadata: payload.metadata || null,
  });
  return { key, entryPath, responsePath, rawPath };
}

export function recordInvocation(tool, key, details) {
  const cfg = getCacheConfig();
  if (!cfg?.invocationsDir) return;
  ensureDir(cfg.invocationsDir);
  const invocation = {
    ts: new Date().toISOString(),
    tool,
    key,
    step_id: cfg.stepId,
    step_label: cfg.stepLabel,
    run_dir: cfg.runDir,
    ...details,
  };
  const filePath = path.join(cfg.invocationsDir, `${nowStamp()}-${tool}-${key.slice(0, 10)}.json`);
  writeFileSync(filePath, JSON.stringify(invocation, null, 2), 'utf-8');
}
