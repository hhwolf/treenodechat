import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApiHandler } from '../server/app.js';
import { createStore } from '../server/store.js';

async function setup(t, { withAgentRuntime = false } = {}) {
  const store = createStore(':memory:');
  const agentRuntime = withAgentRuntime ? {
    adapterInfo: () => ({ id: 'test', name: 'Test agent', available: true, version: '1.0', supportsIntegration: true }),
    start: (projectId, branchId, task) => store.createAgentRun(projectId, branchId, { adapter: 'test', task, worktreePath: '/tmp/test-agent-run' }),
    control: (projectId, runId, action) => store.updateAgentRun(projectId, runId, { status: action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled' }),
    integrate: (projectId, runId, input) => {
      const integration = { branchName: 'threadline/api-project-test', commit: 'abc123', files: input.filePaths, integratedAt: new Date().toISOString() };
      const run = store.updateAgentRun(projectId, runId, { integration });
      return { project: store.getProject(projectId), run, integration };
    },
    verify: (projectId, runId, input = {}) => {
      const run = store.getAgentRun(projectId, runId);
      if (!run) throw Object.assign(new Error('Agent run not found'), { status: 404 });
      return store.updateAgentRun(projectId, runId, { verification: { command: input.command || 'npm test', status: 'running', mode: 'worktree' } });
    },
    commitDocument: (projectId, docId) => {
      const project = store.updateDocument(projectId, docId, { committedAt: new Date().toISOString(), committedSha: 'sha-doc', committedBranch: 'threadline/test' });
      if (!project) throw Object.assign(new Error('Document not found'), { status: 404 });
      return { project, commit: { sha: 'sha-doc', branch: 'threadline/test', path: 'CLAUDE.md' } };
    }
  } : undefined;
  const handler = createApiHandler(store, { agentRuntime });
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers
    });
    return { response, payload: await response.json() };
  };
  return { store, request };
}

test('reports local SQLite health', async (t) => {
  const { request } = await setup(t);
  const { response, payload } = await request('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, mode: 'local', persistence: 'sqlite', repositoryInput: 'path' });
});

test('creates and retrieves a project through the API', async (t) => {
  const { request } = await setup(t);
  const created = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'API project', repoPath: process.cwd(), brief: 'Implement a safe migration' })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.specSource, 'local');
  const id = created.payload.project.id;
  const loaded = await request(`/api/projects/${id}`);
  assert.equal(loaded.payload.project.name, 'API project');
  assert.match(loaded.payload.project.intent.objective, /safe migration/);
  assert.ok(loaded.payload.project.repository.fileCount > 0);
});

test('validates, connects, and replaces a project repository', async (t) => {
  const { request } = await setup(t);
  const invalid = await request('/api/repositories/inspect', {
    method: 'POST',
    body: JSON.stringify({ location: '/definitely-missing-threadline-repository' })
  });
  assert.equal(invalid.response.status, 422);
  assert.equal(invalid.payload.error, 'Repository path does not exist');

  const inspected = await request('/api/repositories/inspect', {
    method: 'POST',
    body: JSON.stringify({ location: process.cwd() })
  });
  assert.equal(inspected.response.status, 200);
  assert.ok(inspected.payload.repository.files.includes('package.json'));

  const created = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Reconnectable', brief: 'Connect the correct repository later' })
  });
  const connected = await request(`/api/projects/${created.payload.project.id}/repository`, {
    method: 'PATCH',
    body: JSON.stringify({ location: process.cwd() })
  });
  assert.equal(connected.response.status, 200);
  assert.equal(connected.payload.project.repoPath, process.cwd());
  assert.ok(connected.payload.project.repository.fileCount > 0);
  assert.ok(connected.payload.project.events.some((event) => event.kind === 'repository'));
});

test('drafts clarifying questions without a configured model provider', async (t) => {
  const { store, request } = await setup(t);
  const project = store.createProject({ name: 'Draft', brief: 'Refactor the parser' });
  const drafted = await request(`/api/projects/${project.id}/specs/draft`, { method: 'POST', body: JSON.stringify({ brief: 'Refactor the parser without changing output' }) });
  assert.equal(drafted.response.status, 200);
  assert.equal(drafted.payload.source, 'local');
  assert.ok(drafted.payload.intent.questions.length >= 1);
  assert.match(drafted.payload.intent.objective, /parser/);
});

test('returns inherited branch context through the API', async (t) => {
  const { store, request } = await setup(t);
  let project = store.createProject({ name: 'Context API', brief: 'Scope context' });
  const main = project.branches[0];
  project = store.createBranch(project.id, { parentId: main.id, name: 'Child', context: 'Child-only rule' });
  const child = project.branches.find((branch) => branch.name === 'Child');
  const result = await request(`/api/projects/${project.id}/contexts?branchId=${child.id}`);
  assert.equal(result.response.status, 200);
  assert.ok(result.payload.contexts.some((item) => item.value === 'Child-only rule'));
});

test('surfaces invalid operations as actionable client errors', async (t) => {
  const { store, request } = await setup(t);
  const project = store.createProject({ name: 'Errors', brief: 'Test errors' });
  const result = await request(`/api/projects/${project.id}/branches`, { method: 'POST', body: JSON.stringify({ parentId: 'missing', name: 'Invalid' }) });
  assert.equal(result.response.status, 422);
  assert.equal(result.payload.error, 'Parent branch not found');
});

test('rejects cross-origin state changes against the local API', async (t) => {
  const { request } = await setup(t);
  const result = await request('/api/projects', {
    method: 'POST',
    headers: { origin: 'https://malicious.example' },
    body: JSON.stringify({ name: 'Should not exist', brief: 'Blocked' })
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.payload.error, 'Cross-origin changes are not allowed');
});

test('drafts, reviews, and challenges a reasoning focus through the API', async (t) => {
  const { store, request } = await setup(t);
  const project = store.createProject({ name: 'Focus API', brief: 'Choose a compatible storage migration' });
  const drafted = await request(`/api/projects/${project.id}/reasoning/draft`, { method: 'POST', body: '{}' });
  assert.equal(drafted.response.status, 200);
  assert.equal(drafted.payload.source, 'local');
  assert.ok(drafted.payload.project.reasoning.some((item) => item.kind === 'approach'));
  const proposal = drafted.payload.project.reasoning[0];
  const confirmed = await request(`/api/projects/${project.id}/reasoning/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }) });
  assert.equal(confirmed.payload.project.reasoning.find((item) => item.id === proposal.id).status, 'confirmed');
  const challenged = await request(`/api/projects/${project.id}/reasoning/challenge`, { method: 'POST', body: '{}' });
  assert.ok(challenged.payload.project.reasoning.some((item) => item.kind === 'counterpoint'));
});

test('refreshes repository grounding and produces reviewable branch analysis', async (t) => {
  const { store, request } = await setup(t);
  let project = store.createProject({ name: 'Grounded', repoPath: process.cwd(), brief: 'Understand this implementation' });
  const scanned = await request(`/api/projects/${project.id}/repository/scan`, { method: 'POST', body: '{}' });
  assert.equal(scanned.response.status, 200);
  assert.ok(scanned.payload.project.repository.files.some((file) => file === 'package.json'));
  project = scanned.payload.project;
  const branch = project.branches[0];
  const analyzed = await request(`/api/projects/${project.id}/branches/${branch.id}/analyze`, { method: 'POST', body: '{}' });
  assert.equal(analyzed.response.status, 200);
  assert.equal(analyzed.payload.source, 'local');
  assert.equal(analyzed.payload.project.branches[0].status, 'review');
  assert.ok(analyzed.payload.project.branches[0].output.changes.length >= 2);
});

test('starts and controls a configured coding agent through the API', async (t) => {
  const { store, request } = await setup(t, { withAgentRuntime: true });
  const project = store.createProject({ name: 'Agent API', repoPath: process.cwd(), brief: 'Supervise a coding task' });
  const branch = project.branches[0];
  const adapters = await request('/api/adapters');
  assert.equal(adapters.payload.adapters[0].name, 'Test agent');
  const started = await request(`/api/projects/${project.id}/branches/${branch.id}/runs`, { method: 'POST', body: JSON.stringify({ task: 'Add one focused test' }) });
  assert.equal(started.response.status, 202);
  assert.equal(started.payload.run.status, 'queued');
  store.addAgentRunEvent(project.id, started.payload.run.id, 'analysis', 'Inspecting tests.');
  const events = await request(`/api/projects/${project.id}/runs/${started.payload.run.id}/events?after=0`);
  assert.equal(events.payload.events[0].message, 'Inspecting tests.');
  const paused = await request(`/api/projects/${project.id}/runs/${started.payload.run.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'pause' }) });
  assert.equal(paused.payload.run.status, 'paused');
});

test('integrates reviewed local run files and rejects unsupported runtimes', async (t) => {
  const local = await setup(t, { withAgentRuntime: true });
  const project = local.store.createProject({ name: 'Integration API', repoPath: process.cwd(), brief: 'Carry accepted code forward' });
  const run = local.store.createAgentRun(project.id, project.branches[0].id, { adapter: 'test', task: 'Change two files', worktreePath: '/tmp/test-agent-run' });
  local.store.updateAgentRun(project.id, run.id, { status: 'completed', files: ['src/a.js', 'src/b.js'] });
  const integrated = await local.request(`/api/projects/${project.id}/runs/${run.id}/integrate`, {
    method: 'POST', body: JSON.stringify({ filePaths: ['src/a.js'], commitMessage: 'Accept A' })
  });
  assert.equal(integrated.response.status, 200);
  assert.deepEqual(integrated.payload.integration.files, ['src/a.js']);
  assert.equal(integrated.payload.run.integration.commit, 'abc123');

  const unsupported = await setup(t);
  const unsupportedProject = unsupported.store.createProject({ name: 'Hosted-like', brief: 'Review only' });
  const result = await unsupported.request(`/api/projects/${unsupportedProject.id}/runs/missing/integrate`, {
    method: 'POST', body: '{}'
  });
  assert.equal(result.response.status, 501);
  assert.match(result.payload.error, /not supported by the configured agent runtime/);
});

test('starts a run from one task, auto-creating a branch named from it', async (t) => {
  const { store, request } = await setup(t, { withAgentRuntime: true });
  const project = store.createProject({ name: 'Composer', repoPath: process.cwd(), brief: 'One-box prompting' });

  const first = await request(`/api/projects/${project.id}/runs`, {
    method: 'POST', body: JSON.stringify({ task: 'Add retry logic to the fetch layer, please.' })
  });
  assert.equal(first.response.status, 202);
  const branch = first.payload.project.branches.find((item) => item.id === first.payload.run.branchId);
  assert.equal(branch.name, 'Add retry logic to the fetch');
  assert.equal(branch.purpose, 'Add retry logic to the fetch layer, please.');
  assert.equal(branch.parentId, project.branches[0].id);

  const second = await request(`/api/projects/${project.id}/runs`, {
    method: 'POST', body: JSON.stringify({ task: 'Add retry logic to the fetch layer, please.' })
  });
  const secondBranch = second.payload.project.branches.find((item) => item.id === second.payload.run.branchId);
  assert.equal(secondBranch.name, 'Add retry logic to the fetch 2');

  store.updateAgentRun(project.id, first.payload.run.id, { status: 'completed' });
  const targeted = await request(`/api/projects/${project.id}/runs`, {
    method: 'POST', body: JSON.stringify({ task: 'Continue on the same branch', branchId: branch.id })
  });
  assert.equal(targeted.response.status, 202);
  assert.equal(targeted.payload.run.branchId, branch.id);

  const bare = store.createProject({ name: 'No repo yet', brief: 'Blocked prompting' });
  const blocked = await request(`/api/projects/${bare.id}/runs`, { method: 'POST', body: JSON.stringify({ task: 'Do something' }) });
  assert.equal(blocked.response.status, 422);
  assert.match(blocked.payload.error, /Connect a repository/);
  assert.equal(store.getProject(bare.id).branches.length, 1);
});

test('verifies a completed run and stores the project verify command', async (t) => {
  const { store, request } = await setup(t, { withAgentRuntime: true });
  const project = store.createProject({ name: 'Verify API', repoPath: process.cwd(), brief: 'One-click testing' });
  const run = store.createAgentRun(project.id, project.branches[0].id, { adapter: 'test', task: 'Change one file', worktreePath: '/tmp/test-agent-run' });
  store.updateAgentRun(project.id, run.id, { status: 'completed' });

  const verified = await request(`/api/projects/${project.id}/runs/${run.id}/verify`, { method: 'POST', body: '{}' });
  assert.equal(verified.response.status, 202);
  assert.equal(verified.payload.run.verification.status, 'running');

  const settings = await request(`/api/projects/${project.id}/settings`, {
    method: 'PATCH', body: JSON.stringify({ verifyCommand: 'npm run test:browser' })
  });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.payload.project.verifyCommand, 'npm run test:browser');

  const unsupported = await setup(t);
  const bareProject = unsupported.store.createProject({ name: 'Review only', brief: 'No runtime' });
  const result = await unsupported.request(`/api/projects/${bareProject.id}/runs/missing/verify`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 501);
  assert.match(result.payload.error, /not supported by the configured agent runtime/);
});

test('manages rules documents through the API', async (t) => {
  const { store, request } = await setup(t, { withAgentRuntime: true });
  const project = store.createProject({ name: 'Rules API', brief: 'One home for the rules' });
  assert.equal(project.documents[0].name, 'CLAUDE.md');

  const created = await request(`/api/projects/${project.id}/documents`, { method: 'POST', body: JSON.stringify({ name: 'skills/research.md', content: 'Cite sources.' }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.project.documents.length, 2);
  const doc = created.payload.project.documents.find((item) => item.name === 'skills/research.md');

  const updated = await request(`/api/projects/${project.id}/documents/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ content: 'Cite everything.' }) });
  assert.equal(updated.payload.project.documents.find((item) => item.id === doc.id).content, 'Cite everything.');

  const committed = await request(`/api/projects/${project.id}/documents/${doc.id}/commit`, { method: 'POST', body: '{}' });
  assert.equal(committed.response.status, 200);
  assert.equal(committed.payload.commit.sha, 'sha-doc');
  assert.equal(committed.payload.project.documents.find((item) => item.id === doc.id).committedSha, 'sha-doc');

  const removed = await request(`/api/projects/${project.id}/documents/${doc.id}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.payload.project.documents.length, 1);

  const invalid = await request(`/api/projects/${project.id}/documents`, { method: 'POST', body: JSON.stringify({ name: '../escape.md' }) });
  assert.equal(invalid.response.status, 422);

  const bare = await setup(t);
  const bareProject = bare.store.createProject({ name: 'No runtime', brief: 'x' });
  const blocked = await bare.request(`/api/projects/${bareProject.id}/documents/${bareProject.documents[0].id}/commit`, { method: 'POST', body: '{}' });
  assert.equal(blocked.response.status, 501);
});

test('runs a chat turn, persists the tree, and gates action approvals', async (t) => {
  const store = createStore(':memory:');
  const orchestrator = {
    runChatTurn: async (projectId, userNode) => ({
      source: 'model',
      assistantNodeId: undefined,
      content: `Reply to: ${userNode.content}`,
      directions: [{ label: 'Technical', summary: 'Go deep.' }, { label: 'Practical', summary: 'Ship now.', recommended: true }],
      actions: [{ tool: 'trigger_deployment', args: { ref: 'main' }, status: 'needs_approval' }],
      engineBranchId: null
    })
  };
  const handler = createApiHandler(store, { orchestrator });
  const server = createServer(async (request, response) => { if (!(await handler(request, response))) { response.writeHead(404); response.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); });
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, { ...options, headers: options.body ? { 'content-type': 'application/json' } : {} });
    return { response, payload: await response.json() };
  };

  const project = store.createProject({ name: 'Chat API', brief: 'Talk to the orchestrator' });
  const first = await request(`/api/projects/${project.id}/chat`, { method: 'POST', body: JSON.stringify({ message: 'Hello' }) });
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.userNode.role, 'user');
  assert.equal(first.payload.assistantNode.parentId, first.payload.userNode.id);
  assert.equal(first.payload.assistantNode.directions.length, 2);
  assert.equal(first.payload.project.chatNodes.length, 2);

  const direction = first.payload.assistantNode.directions[1];
  const picked = await request(`/api/projects/${project.id}/chat`, {
    method: 'POST', body: JSON.stringify({ parentNodeId: first.payload.assistantNode.id, directionId: direction.id, message: 'Go practical' })
  });
  assert.equal(picked.payload.userNode.directionId, direction.id);

  const badDirection = await request(`/api/projects/${project.id}/chat`, {
    method: 'POST', body: JSON.stringify({ parentNodeId: first.payload.assistantNode.id, directionId: 'missing', message: 'x' })
  });
  assert.equal(badDirection.response.status, 404);

  const action = first.payload.assistantNode.actions[0];
  const approved = await request(`/api/projects/${project.id}/chat/nodes/${first.payload.assistantNode.id}/actions/${action.id}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'approved' })
  });
  assert.equal(approved.response.status, 200);
  const updatedNode = approved.payload.project.chatNodes.find((node) => node.id === first.payload.assistantNode.id);
  assert.equal(updatedNode.actions[0].status, 'approved');
  const again = await request(`/api/projects/${project.id}/chat/nodes/${first.payload.assistantNode.id}/actions/${action.id}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'dismissed' })
  });
  assert.equal(again.response.status, 422);

  const noOrchestrator = await setup(t);
  const bareProject = noOrchestrator.store.createProject({ name: 'No chat', brief: 'x' });
  const blocked = await noOrchestrator.request(`/api/projects/${bareProject.id}/chat`, { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
  assert.equal(blocked.response.status, 503);
});
