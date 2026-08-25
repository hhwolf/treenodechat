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
