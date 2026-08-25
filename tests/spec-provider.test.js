import test from 'node:test';
import assert from 'node:assert/strict';
import { draftSpec } from '../server/spec.js';

test('uses the official Responses contract and parses structured output', async (t) => {
  const original = {
    key: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
    legacy: process.env.LLM_API_URL,
    fetch: globalThis.fetch
  };
  t.after(() => {
    if (original.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original.key;
    if (original.model === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = original.model;
    if (original.legacy === undefined) delete process.env.LLM_API_URL; else process.env.LLM_API_URL = original.legacy;
    globalThis.fetch = original.fetch;
  });
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'gpt-5.6-sol';
  delete process.env.LLM_API_URL;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({
        objective: 'Ship the hosted runtime.',
        audience: 'Developers',
        outcome: 'A working deployment',
        avoid: 'Secret exposure',
        format: 'Reviewable changes',
        qualityBar: 'Tests pass',
        questions: ['Which database is connected?']
      }) }] }] })
    };
  };

  const result = await draftSpec({ brief: 'Deploy Threadline.' });

  assert.equal(result.source, 'model');
  assert.equal(result.intent.objective, 'Ship the hosted runtime.');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.headers.authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'gpt-5.6-sol');
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.text.format, { type: 'json_object' });
  assert.match(request.body.instructions, /Do not include chain-of-thought/);
});
