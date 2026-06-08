import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCookiesToGoogleCookieMap, buildGeminiCookieHeader, buildGeminiInnerRequest, buildGeminiModelHeader, classifyGeminiUiState, hasRequiredGoogleCookies, parseGeminiAccountModelsResponse, parseGeminiStreamResponse, resolveGeminiModel } from '../scripts/ai-chat/providers/gemini-api.mjs';

test('buildGeminiCookieHeader serializes cookie map', () => {
  assert.equal(buildGeminiCookieHeader({ A: '1', B: '', C: '3' }), 'A=1; C=3');
});

test('browserCookiesToGoogleCookieMap filters browser cookies and checks required cookies', () => {
  const cookieMap = browserCookiesToGoogleCookieMap([
    { name: '__Secure-1PSID', value: 'psid' },
    { name: 'irrelevant', value: 'x' },
  ]);
  assert.deepEqual(cookieMap, { '__Secure-1PSID': 'psid' });
  assert.equal(hasRequiredGoogleCookies(cookieMap), true);
  assert.equal(hasRequiredGoogleCookies({ '__Secure-1PSIDTS': 'ts' }), false);
});

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

test('resolves Gemini model aliases', () => {
  assert.equal(resolveGeminiModel('flash').id, 'gemini-3-flash');
  assert.equal(resolveGeminiModel('thinking').id, 'gemini-3-flash-thinking');
  assert.equal(resolveGeminiModel('pro').id, 'gemini-3-pro');
});

test('buildGeminiInnerRequest defaults to temporary and can save to history', () => {
  const temporary = buildGeminiInnerRequest({ prompt: 'hello', requestUuid: 'REQ' }).innerReqList;
  const saved = buildGeminiInnerRequest({ prompt: 'hello', temporary: false, requestUuid: 'REQ' }).innerReqList;
  assert.equal(temporary[45], 1);
  assert.equal(saved[45], null);
  assert.equal(temporary[59], 'REQ');
});

test('buildGeminiModelHeader supports normal and field 13 capacity tails', () => {
  assert.equal(buildGeminiModelHeader({ id: 'm', model_id: 'abc', capacity_tail: 4 }), '[1,null,null,null,"abc",null,null,0,[4],null,null,4]');
  assert.equal(buildGeminiModelHeader({ id: 'm', model_id: 'abc', capacity: 2, capacity_field: 13 }), '[1,null,null,null,"abc",null,null,0,[4],null,null,null,2]');
});

test('classifyGeminiUiState distinguishes app readiness from consent and sign-in pages', () => {
  assert.deepEqual(classifyGeminiUiState({
    url: 'https://consent.google.com/m?continue=https://gemini.google.com/app',
    title: 'Before you continue',
    text: 'Before you continue to Google\nReject all\nAccept all',
  }).reason, 'google_consent_required');
  assert.deepEqual(classifyGeminiUiState({
    url: 'https://accounts.google.com/signin',
    title: 'Sign in',
    text: 'Sign in',
  }).reason, 'google_sign_in_required');
  const ready = classifyGeminiUiState({
    url: 'https://gemini.google.com/app',
    title: 'Gemini',
    promptInput: true,
    accountButton: true,
    text: 'Hi Reza\nAsk Gemini',
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, 'gemini_app_ready');
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
