'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BraveSearchClient, normalizeBraveResults } = require('../../src/main/assistant/brave-search-client');

test('Brave result normalization keeps safe URLs and strips control characters', () => {
  const results = normalizeBraveResults({ web: { results: [
    { title: 'Good\u0000 title', url: 'https://example.com/path', description: 'Useful result' },
    { title: 'Unsafe', url: 'javascript:alert(1)', description: 'Ignore' }
  ] } });
  assert.deepEqual(results, [{
    title: 'Good title',
    url: 'https://example.com/path',
    snippets: ['Useful result']
  }]);
});

test('Brave client never places the API key in the URL', async () => {
  let observedUrl;
  let observedHeaders;
  const client = new BraveSearchClient({
    apiKey: 'secret-key',
    fetchImpl: async (url, options) => {
      observedUrl = url;
      observedHeaders = options.headers;
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    }
  });
  await client.search('safe query');
  assert.equal(observedUrl.includes('secret-key'), false);
  assert.equal(observedHeaders['X-Subscription-Token'], 'secret-key');
});
