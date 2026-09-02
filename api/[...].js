import { createApiHandler } from '../server/app.js';
import { authorizeRequest } from '../server/auth.js';
import { createCloudStore } from '../server/cloud-store.js';
import { inspectGitHubRepository } from '../server/github-repository.js';
import { createOrchestrator } from '../server/orchestrator.js';
import { createSandboxRuntime } from '../server/sandbox-runtime.js';

export const config = { maxDuration: 300 };

let resources;

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function routedUrl(request) {
  const path = Array.isArray(request.query?.path) ? request.query.path.join('/') : request.query?.path;
  if (!path) return request.url;
  const incoming = new URL(request.url, 'http://threadline.local');
  incoming.searchParams.delete('path');
  const query = incoming.searchParams.toString();
  return `/api/${String(path).replace(/^\/+/, '')}${query ? `?${query}` : ''}`;
}

function getResources() {
  if (resources) return resources;
  const store = createCloudStore();
  const agentRuntime = createSandboxRuntime(store);
  const orchestrator = createOrchestrator(store, { agentRuntime });
  resources = {
    store,
    agentRuntime,
    handler: createApiHandler(store, { agentRuntime, repositoryInspector: inspectGitHubRepository, orchestrator })
  };
  return resources;
}

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  request.url = routedUrl(request);
  if (request.url?.split('?')[0] === '/api/health') {
    return send(response, 200, {
      ok: true,
      mode: 'cloud',
      persistence: 'postgres',
      repositoryInput: 'url',
      configured: Boolean(process.env.DATABASE_URL && process.env.THREADLINE_ACCESS_TOKEN),
      configuration: {
        database: Boolean(process.env.DATABASE_URL),
        accessToken: Boolean(process.env.THREADLINE_ACCESS_TOKEN),
        openAI: Boolean(process.env.OPENAI_API_KEY),
        github: Boolean(process.env.GITHUB_TOKEN)
      },
      agentConfigured: Boolean(process.env.OPENAI_API_KEY),
      authRequired: true
    });
  }
  const authorization = authorizeRequest(request);
  if (!authorization.ok) return send(response, authorization.status, { error: authorization.error });
  if (!process.env.DATABASE_URL) return send(response, 503, { error: 'Connect a Postgres database and set DATABASE_URL in Vercel' });
  try {
    const handled = await getResources().handler(request, response);
    if (!handled && !response.writableEnded) send(response, 404, { error: 'Endpoint not found' });
  } catch (error) {
    if (!response.writableEnded) send(response, 500, { error: error.message || 'Hosted API failed' });
  }
}

export { routedUrl };
