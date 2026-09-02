import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createCloudStore } from '../server/cloud-store.js';

function setup(t) {
  const database = newDb();
  const { Pool } = database.adapters.createPg();
  const store = createCloudStore('', { pool: new Pool() });
  t.after(() => store.close());
  return store;
}

test('persists the hosted project graph and excludes private context from agent packages', async (t) => {
  const store = setup(t);
  let project = await store.createProject({
    name: 'Hosted project',
    repoPath: 'https://github.com/example/project',
    brief: 'Ship the hosted architecture safely.'
  });
  const main = project.branches[0];
  project = await store.createContext(project.id, { label: 'Shared', value: 'Agents may use this.', scope: 'project', sensitivity: 'shared' });
  project = await store.createContext(project.id, { label: 'Private', value: 'Never send this.', scope: 'project', sensitivity: 'private' });
  project = await store.createBranch(project.id, { parentId: main.id, name: 'Cloud path', context: 'Use managed Postgres.' });
  const branch = project.branches.find((item) => item.name === 'Cloud path');
  const contexts = await store.inheritedContexts(project.id, branch.id);

  assert.ok(contexts.some((item) => item.label === 'Shared'));
  assert.ok(contexts.some((item) => item.value === 'Use managed Postgres.'));
  assert.ok(!contexts.some((item) => item.label === 'Private'));
  assert.equal((await store.listProjects())[0].branchCount, 2);
});

test('stores sandbox run evidence atomically and keeps checkpoint snapshots private', async (t) => {
  const store = setup(t);
  let project = await store.createProject({ name: 'Agent evidence', repoPath: 'https://github.com/example/project', brief: 'Supervise a run.' });
  const run = await store.createAgentRun(project.id, project.branches[0].id, { task: 'Add one test', adapter: 'codex-sandbox' });
  await store.appendAgentRunEvents(project.id, run.id, [{ kind: 'command', message: 'npm test' }], 1);
  await store.appendAgentRunEvents(project.id, run.id, [{ kind: 'command', message: 'duplicate' }], 1);
  await store.updateAgentRun(project.id, run.id, { status: 'completed', files: ['test.js'], summary: 'Done.' });
  project = await store.createCheckpoint(project.id, 'Known good');

  const loadedRun = await store.getAgentRun(project.id, run.id);
  assert.deepEqual(loadedRun.events.map((event) => event.message), ['npm test']);
  assert.deepEqual(loadedRun.files, ['test.js']);
  assert.equal('snapshot' in project.checkpoints[0], false);
  assert.equal(JSON.stringify(project).includes('"snapshot"'), false);
});

test('selectively merges hosted branch findings and restores the prior checkpoint', async (t) => {
  const store = setup(t);
  let project = await store.createProject({ name: 'Hosted recovery', brief: 'Merge only reviewed findings.' });
  const main = project.branches[0];
  project = await store.createBranch(project.id, { parentId: main.id, name: 'Alternative' });
  const alternative = project.branches.find((branch) => branch.name === 'Alternative');
  project = await store.updateBranch(project.id, alternative.id, { status: 'review', output: { changes: [
    { id: 'accepted', title: 'Accepted', detail: 'Use this.' },
    { id: 'rejected', title: 'Rejected', detail: 'Leave this behind.' }
  ] } });
  const merged = await store.mergeBranch(project.id, alternative.id, main.id, ['accepted']);
  const checkpoint = merged.checkpoints[0];

  assert.deepEqual(merged.branches.find((branch) => branch.id === main.id).output.changes.map((change) => change.id), ['accepted']);
  assert.equal(merged.branches.find((branch) => branch.id === alternative.id).status, 'merged');
  const restored = await store.restoreCheckpoint(project.id, checkpoint.id);
  assert.equal(restored.branches.find((branch) => branch.id === alternative.id).status, 'review');
  assert.deepEqual(restored.branches.find((branch) => branch.id === main.id).output.changes, []);
});

test('stores the chat tree, documents, and ship settings in the hosted document', async (t) => {
  const store = setup(t);
  const project = await store.createProject({ name: 'Hosted chat', brief: 'Chat-first hosted workspace' });
  assert.equal(project.documents[0].name, 'CLAUDE.md');
  assert.deepEqual(project.shipSettings, { vercelProjectId: '', vercelTeamId: '' });

  const root = await store.appendChatNode(project.id, { role: 'user', content: 'Plan the trainer' });
  const reply = await store.appendChatNode(project.id, {
    role: 'assistant', parentId: root.id, content: 'Pick a direction.',
    directions: [{ label: 'Technical', summary: 'Deep dive.' }, { label: 'Practical', summary: 'Ship now.', recommended: true }]
  });
  await assert.rejects(store.appendChatNode(project.id, { role: 'user', parentId: 'missing', content: 'orphan' }), /Parent chat node not found/);
  await store.updateChatNode(project.id, reply.id, { engineBranchId: 'branch-1' });

  const run = await store.createAgentRun(project.id, project.branches[0].id, { task: 'Do it', nodeId: reply.id });
  assert.equal((await store.getAgentRun(project.id, run.id)).nodeId, reply.id);

  let updated = await store.createDocument(project.id, { name: 'HARNESS.md', content: 'Harness rules.' });
  assert.equal(updated.documents.length, 2);
  const doc = updated.documents.find((item) => item.name === 'HARNESS.md');
  updated = await store.updateDocument(project.id, doc.id, { committedSha: 'sha2', committedAt: '2026-08-29T00:00:00.000Z', committedBranch: 'threadline/y' });
  assert.equal(updated.documents.find((item) => item.id === doc.id).committedSha, 'sha2');
  updated = await store.updateShipSettings(project.id, { vercelProjectId: 'prj_abc' });
  assert.equal(updated.shipSettings.vercelProjectId, 'prj_abc');

  const loaded = await store.getProject(project.id);
  assert.equal(loaded.chatNodes.length, 2);
  assert.equal(loaded.chatNodes.find((node) => node.id === reply.id).engineBranchId, 'branch-1');
});

test('normalizes legacy hosted documents that predate the chat pivot', async (t) => {
  const database = newDb();
  const { Pool } = database.adapters.createPg();
  const pool = new Pool();
  const store = createCloudStore('', { pool });
  t.after(() => store.close());
  const project = await store.createProject({ name: 'Legacy', brief: 'Old shape' });
  const legacy = JSON.parse(JSON.stringify(project));
  delete legacy.chatNodes;
  delete legacy.documents;
  delete legacy.shipSettings;
  await pool.query('UPDATE threadline_projects SET document = $2::jsonb WHERE id = $1', [project.id, JSON.stringify(legacy)]);
  const loaded = await store.getProject(project.id);
  assert.deepEqual(loaded.chatNodes, []);
  assert.deepEqual(loaded.documents, []);
  assert.deepEqual(loaded.shipSettings, { vercelProjectId: '', vercelTeamId: '' });
  const node = await store.appendChatNode(project.id, { role: 'user', content: 'Still works' });
  assert.ok(node.id);
});
