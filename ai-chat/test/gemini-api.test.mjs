import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryGeminiWeb, buildGeminiInnerRequest, parseGeminiAccountModelsResponse, parseGeminiStreamResponse, resolveGeminiModel } from '../scripts/ai-chat/providers/gemini-api.mjs';

test('parseGeminiStreamResponse extracts longest candidate text and conversation ids', () => {
  const inner = JSON.stringify([null, ['c_1', 'r_1'], null, null, [['rc_1', ['short']], ['rc_2', ['longer answer']]]]);
  const outer = [[null, null, inner]];
  const raw = `)]}'\n${JSON.stringify(outer)}\n`;
  assert.deepEqual(parseGeminiStreamResponse(raw), {
    text: 'longer answer',
    errorCode: undefined,
    conversationId: 'c_1',
    responseId: 'r_1',
    choiceId: 'rc_2',
    metadata: ['c_1', 'r_1', 'rc_2', null, null, null, null, null, null, ''],
  });
});

test('parseGeminiStreamResponse extracts model unavailable error code', () => {
  const raw = JSON.stringify([[null, null, null, null, null, [null, null, [[null, [1052]]]]]]);
  assert.equal(parseGeminiStreamResponse(raw).errorCode, 1052);
});

test('resolves Gemini model aliases without escalating shared transport identifiers', () => {
  assert.equal(resolveGeminiModel('flash').id, 'gemini-3-flash');
  assert.equal(resolveGeminiModel('thinking').id, 'gemini-3-flash-thinking');
  assert.equal(resolveGeminiModel('pro').id, 'gemini-3-pro');
  assert.equal(resolveGeminiModel('plus-pro').id, 'gemini-3-pro-plus');
  assert.equal(resolveGeminiModel('advanced-pro').id, 'gemini-3-pro-advanced');
  // This provider transport ID is shared by Basic, Plus, and Advanced. A raw
  // ID is therefore ambiguous and must not silently select the Advanced tier.
  assert.equal(resolveGeminiModel('9d8ca3786ebdfbea'), null);
});

test('buildGeminiInnerRequest defaults to provider history and uses temporary mode only explicitly', () => {
  const persistent = buildGeminiInnerRequest({ prompt: 'hello', requestUuid: 'REQ' }).innerReqList;
  const temporary = buildGeminiInnerRequest({ prompt: 'hello', temporary: true, requestUuid: 'REQ' }).innerReqList;
  assert.equal(persistent[45], null);
  assert.equal(temporary[45], 1);
  assert.equal(persistent[59], 'REQ');
});

test('parseGeminiAccountModelsResponse extracts account model registry', () => {
  const body = [];
  body[14] = 1;
  body[15] = [['fbb127bbb056c959', 'Fast', 'Fast model']];
  body[16] = [];
  body[17] = [115];
  const raw = `)]}'\n${JSON.stringify([['wrb.fr', 'otAQ7b', JSON.stringify(body)]])}\n`;
  const parsed = parseGeminiAccountModelsResponse(raw);
  assert.equal(parsed.models[0].id, 'gemini-3-flash');
  assert.equal(parsed.models[0].display_name, 'Fast');
  assert.equal(parsed.models[0].capacity, 4);
  assert.equal(parsed.models[0].source, 'gemini-account-rpc');
});

function withRawOutput(path, fn) {
  const previous = process.env.AI_CHAT_GEMINI_RAW_OUT;
  process.env.AI_CHAT_GEMINI_RAW_OUT = path;
  return Promise.resolve().then(fn).finally(() => { if (previous === undefined) delete process.env.AI_CHAT_GEMINI_RAW_OUT; else process.env.AI_CHAT_GEMINI_RAW_OUT = previous; });
}

async function runGeminiRawOutput(path) {
  const page = { evaluate: async () => ({ ok: true, status: 200, body: 'private raw response' }) };
  await withRawOutput(path, () => assert.rejects(() => queryGeminiWeb(page, 'prompt'), /empty response/));
}

test('same-origin page bridge returns only body and status-derived errors', async () => {
  let evaluated = false;
  const page = { evaluate: async (_fn, args) => { evaluated = true; assert.equal(args.operation, 'prompt'); return { ok: true, status: 200, body: JSON.stringify([[null, null, JSON.stringify([null, ['c', 'r'], null, null, [['x', ['answer']]]])]]) }; } };
  const result = await queryGeminiWeb(page, 'prompt');
  assert.equal(evaluated, true);
  assert.equal(result.text, 'answer');
});

test('Gemini raw output uses private new directories and presecures overwrites', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-chat-gemini-raw-'));
  try {
    chmodSync(root, 0o700);
    const output = join(root, 'new', 'raw.txt');
    await runGeminiRawOutput(output);
    assert.equal(statSync(join(root, 'new')).mode & 0o777, 0o700);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    writeFileSync(output, 'old'); chmodSync(output, 0o644);
    await runGeminiRawOutput(output);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(readFileSync(output, 'utf8'), 'private raw response');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gemini raw output rejects a permissive existing parent before writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-chat-gemini-raw-unsafe-'));
  const output = join(root, 'raw.txt');
  try {
    chmodSync(root, 0o755);
    await assert.rejects(() => runGeminiRawOutput(output), /existing parent directory must already have mode 0700/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gemini raw output rejects file and directory symlinks without touching targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-chat-gemini-raw-symlink-'));
  try {
    chmodSync(root, 0o700);
    const target = join(root, 'target.txt'); writeFileSync(target, 'unchanged'); chmodSync(target, 0o644);
    const output = join(root, 'raw.txt'); symlinkSync(target, output);
    await assert.rejects(() => runGeminiRawOutput(output), /symlink/);
    assert.equal(readFileSync(target, 'utf8'), 'unchanged'); assert.equal(statSync(target).mode & 0o777, 0o644);
    const realDir = join(root, 'real-dir'); mkdirSync(realDir); chmodSync(realDir, 0o700);
    const linkedDir = join(root, 'linked-dir'); symlinkSync(realDir, linkedDir);
    await assert.rejects(() => runGeminiRawOutput(join(linkedDir, 'raw.txt')), /real directory/);
    assert.equal(existsSync(join(realDir, 'raw.txt')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gemini transport keeps credential material in the managed page', async () => {
  const source = readFileSync(new URL('../scripts/ai-chat/providers/gemini-api.mjs', import.meta.url), 'utf8');
  assert.match(source, /page\.evaluate/);
  assert.match(source, /credentials: 'include'/);
  assert.doesNotMatch(source, /page\.cookies|node:sqlite|createDecipher|Cookie header|cookieMap|chromeProfile|readManagedStateForPort/);
  assert.doesNotMatch(source, /response\.headers/);
});
