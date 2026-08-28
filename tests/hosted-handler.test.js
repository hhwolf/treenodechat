import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/[...].js';

function responseRecorder() {
  return {
    headers: {},
    writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; }
  };
}

function preserveEnvironment(t, names) {
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('reports hosted configuration without exposing secret values', async (t) => {
  preserveEnvironment(t, ['DATABASE_URL', 'THREADLINE_ACCESS_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']);
  process.env.DATABASE_URL = 'postgresql://configured';
  process.env.THREADLINE_ACCESS_TOKEN = 'access-secret';
  process.env.OPENAI_API_KEY = 'openai-secret';
  delete process.env.GITHUB_TOKEN;
  const response = responseRecorder();

  await handler({ url: '/api/[...]?path=health', query: { path: 'health' }, headers: {} }, response);

  assert.equal(response.status, 200);
  assert.equal(response.body.configured, true);
  assert.deepEqual(response.body.configuration, { database: true, accessToken: true, openAI: true, github: false });
  assert.doesNotMatch(JSON.stringify(response.body), /access-secret|openai-secret|postgresql:\/\//);
});

test('enforces the hosted bearer gate before initializing persistence', async (t) => {
  preserveEnvironment(t, ['THREADLINE_ACCESS_TOKEN']);
  process.env.THREADLINE_ACCESS_TOKEN = 'correct-code';
  const missing = responseRecorder();
  const wrong = responseRecorder();

  await handler({ url: '/api/[...]?path=projects', query: { path: 'projects' }, headers: {} }, missing);
  await handler({ url: '/api/[...]?path=projects/123/runs', query: { path: 'projects/123/runs' }, headers: { authorization: 'Bearer wrong-code' } }, wrong);

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'Enter the Threadline access code to continue');
});
