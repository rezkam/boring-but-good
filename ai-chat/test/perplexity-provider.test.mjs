import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPerplexityPayload,
  extractPerplexityState,
  parseSseLine,
  perplexityProvider,
  resolvePerplexityModel,
} from '../scripts/ai-chat/providers/perplexity.mjs';

test('resolves Perplexity model ids and display names', () => {
  assert.equal(resolvePerplexityModel('perplexity/deep-research').identifier, 'pplx_alpha');
  assert.equal(resolvePerplexityModel('GPT-5.4 Thinking').id, 'openai/gpt-5.4-thinking');
  assert.equal(resolvePerplexityModel('claude46sonnetthinking').id, 'anthropic/claude-sonnet-4.6-thinking');
  assert.equal(resolvePerplexityModel('reasoning').id, 'openai/gpt-5.4-thinking');
});

test('lists Perplexity models with capability metadata', async () => {
  const list = await perplexityProvider.listModels({ request: { verifyModels: false } });
  assert.equal(list.models.length >= 10, true);
  const thinking = list.models.find(model => model.id === 'google/gemini-3.1-pro-thinking-high');
  assert.equal(thinking.thinking, true);
  assert.equal(thinking.thinking_level, 'high');
  assert.equal(thinking.provider_family, 'google');
  assert.equal(list.verification.enabled, false);
});

test('builds Perplexity payload with continuation and source options', () => {
  const payload = buildPerplexityPayload({
    query: 'follow up',
    model: resolvePerplexityModel('perplexity/deep-research'),
    options: { sourceFocus: 'academic,web', timeRange: 'week', saveToLibrary: true },
    conversation: { record: { provider_state: { backend_uuid: 'uuid-1', read_write_token: 'rw-1' } } },
  });

  assert.equal(payload.params.model_preference, 'pplx_alpha');
  assert.equal(payload.params.mode, 'research');
  assert.deepEqual(payload.params.sources, ['scholar', 'web']);
  assert.equal(payload.params.search_recency_filter, 'WEEK');
  assert.equal(payload.params.is_incognito, false);
  assert.equal(payload.params.last_backend_uuid, 'uuid-1');
  assert.equal(payload.params.read_write_token, 'rw-1');
  assert.equal(payload.params.query_source, 'followup');
});

test('parses Perplexity SSE data and extracts answer, citations, and thread state', () => {
  const state = extractPerplexityState(parseSseLine(`data: ${JSON.stringify({
    backend_uuid: 'uuid-2',
    read_write_token: 'rw-2',
    final: true,
    text: JSON.stringify({
      answer: 'Answer [1]',
      chunks: ['Answer [1]'],
      web_results: [{ name: 'Source', url: 'https://example.com', snippet: 'Snippet' }],
    }),
  })}`), undefined, 'markdown');

  assert.equal(state.backendUuid, 'uuid-2');
  assert.equal(state.readWriteToken, 'rw-2');
  assert.equal(state.answer, 'Answer [1](https://example.com)');
  assert.equal(state.searchResults[0].title, 'Source');
  assert.equal(state.done, true);
});
