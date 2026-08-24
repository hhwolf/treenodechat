import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';

function setup(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  return store;
}

test('creates a durable project intent and main branch', (t) => {
  const store = setup(t);
  const project = store.createProject({ name: 'Compiler cleanup', repoPath: '/code/compiler', brief: 'Remove the legacy optimizer safely.' });
  assert.equal(project.name, 'Compiler cleanup');
  assert.equal(project.repoPath, '/code/compiler');
  assert.match(project.intent.objective, /legacy optimizer/);
  assert.equal(project.branches.length, 1);
  assert.equal(project.branches[0].name, 'Main');
  assert.equal(project.contexts[0].scope, 'project');
});

test('updates intent without losing the rest of the shared contract', (t) => {
  const store = setup(t);
  const project = store.createProject({ name: 'Intent', brief: 'Initial objective' });
  const updated = store.updateIntent(project.id, { qualityBar: 'All compatibility tests pass.' });
  assert.equal(updated.intent.qualityBar, 'All compatibility tests pass.');
  assert.equal(updated.intent.audience, project.intent.audience);
  assert.ok(updated.events.some((event) => /Intent updated/.test(event.summary)));
});

test('isolates sibling context while inheriting parent and project context', (t) => {
  const store = setup(t);
  let project = store.createProject({ name: 'Context tree', brief: 'Test context inheritance' });
  const main = project.branches[0];
  project = store.createBranch(project.id, { parentId: main.id, name: 'Path A', context: 'Only Path A sees this.' });
  project = store.createBranch(project.id, { parentId: main.id, name: 'Path B', context: 'Only Path B sees this.' });
  const pathA = project.branches.find((branch) => branch.name === 'Path A');
  const pathB = project.branches.find((branch) => branch.name === 'Path B');
  const aContext = store.inheritedContexts(project.id, pathA.id);
  const bContext = store.inheritedContexts(project.id, pathB.id);
  assert.ok(aContext.some((item) => /Path A/.test(item.value)));
  assert.ok(!aContext.some((item) => /Path B/.test(item.value)));
  assert.ok(bContext.some((item) => /Path B/.test(item.value)));
  assert.ok(aContext.some((item) => item.scope === 'project'));
});

test('keeps private and restricted context out of agent packages', (t) => {
  const store = setup(t);
  let project = store.createProject({ name: 'Permissions', brief: 'Protect sensitive context' });
  const main = project.branches[0];
  project = store.createContext(project.id, { label: 'Secret', value: 'Do not send', scope: 'project', sensitivity: 'private' });
  project = store.createContext(project.id, { label: 'Shared rule', value: 'Agents may use this', scope: 'project', sensitivity: 'shared' });
  const packageContext = store.inheritedContexts(project.id, main.id);
  assert.ok(packageContext.some((item) => item.label === 'Shared rule'));
  assert.ok(!packageContext.some((item) => item.label === 'Secret'));
  assert.ok(store.inheritedContexts(project.id, main.id, { includePrivate: true }).some((item) => item.label === 'Secret'));
});

test('partially merges selected changes and creates a rollback checkpoint', (t) => {
  const store = setup(t);
  let project = store.createProject({ name: 'Selective merge', brief: 'Merge only reviewed work' });
  const main = project.branches[0];
  project = store.createBranch(project.id, { parentId: main.id, name: 'Alternative' });
  const alternative = project.branches.find((branch) => branch.name === 'Alternative');
  project = store.updateBranch(project.id, alternative.id, {
    status: 'review',
    output: { summary: 'Two possible changes.', changes: [
      { id: 'safe', title: 'Safe change', detail: 'Accepted' },
      { id: 'risky', title: 'Risky change', detail: 'Rejected' }
    ] }
  });
  const merged = store.mergeBranch(project.id, alternative.id, main.id, ['safe']);
  const updatedMain = merged.branches.find((branch) => branch.id === main.id);
  assert.deepEqual(updatedMain.output.changes.map((change) => change.id), ['safe']);
  assert.equal(merged.branches.find((branch) => branch.id === alternative.id).status, 'merged');
  assert.ok(merged.checkpoints.some((checkpoint) => /Before merging Alternative/.test(checkpoint.name)));
});

test('restores a checkpoint without deleting its recovery path', (t) => {
  const store = setup(t);
  let project = store.createProject({ name: 'Recovery', brief: 'Make rollback safe' });
  project = store.createCheckpoint(project.id, 'Known good');
  const checkpoint = project.checkpoints.find((item) => item.name === 'Known good');
  const main = project.branches[0];
  project = store.createBranch(project.id, { parentId: main.id, name: 'Bad path' });
  assert.ok(project.branches.some((branch) => branch.name === 'Bad path'));
  const restored = store.restoreCheckpoint(project.id, checkpoint.id);
  assert.ok(!restored.branches.some((branch) => branch.name === 'Bad path'));
  assert.ok(restored.checkpoints.some((item) => item.id === checkpoint.id));
  assert.ok(restored.events.some((event) => /Restored Known good/.test(event.summary)));
});

test('rejects unsafe or ambiguous graph operations', (t) => {
  const store = setup(t);
  const project = store.createProject({ name: 'Guardrails', brief: 'Reject malformed operations' });
  assert.throws(() => store.createBranch(project.id, { parentId: 'missing', name: 'Invalid' }), /Parent branch not found/);
  assert.throws(() => store.createContext(project.id, { label: 'Missing scope', value: 'No branch', scope: 'branch' }), /requires a branch/);
  assert.throws(() => store.mergeBranch(project.id, project.branches[0].id, project.branches[0].id, []), /Select at least one/);
});

test('keeps model reasoning provisional until a user confirms it', (t) => {
  const store = setup(t);
  let project = store.createProject({ name: 'Reasoning', brief: 'Choose a safe migration path' });
  project = store.replaceReasoningProposals(project.id, [
    { kind: 'approach', title: 'Staged migration', summary: 'Move one boundary at a time.', sourceLabel: 'Project intent', confidence: 'medium' },
    { kind: 'evidence', title: 'Compatibility tests', summary: 'The existing suite describes preserved behavior.', sourceLabel: 'tests/', confidence: 'high' }
  ]);
  assert.equal(project.reasoning.length, 2);
  assert.ok(project.reasoning.every((item) => item.status === 'proposed'));
  const approach = project.reasoning.find((item) => item.kind === 'approach');
  project = store.resolveReasoningItem(project.id, approach.id, 'confirmed');
  assert.equal(project.reasoning.find((item) => item.id === approach.id).status, 'confirmed');
  project = store.replaceReasoningProposals(project.id, [{ kind: 'approach', title: 'Staged migration', summary: 'A repeated draft should not return.' }]);
  assert.equal(project.reasoning.filter((item) => item.title === 'Staged migration').length, 1);
});

test('adds only one pending counterpoint and restores reasoning with checkpoints', (t) => {
  const store = setup(t);
  let project = store.createProject({ name: 'Challenge', brief: 'Improve the parser safely' });
  project = store.replaceReasoningProposals(project.id, [{ kind: 'assumption', title: 'Baseline exists', summary: 'Current behavior is testable.' }]);
  project = store.createCheckpoint(project.id, 'Before challenge');
  const checkpoint = project.checkpoints.find((item) => item.name === 'Before challenge');
  project = store.addReasoningChallenge(project.id);
  project = store.addReasoningChallenge(project.id);
  assert.equal(project.reasoning.filter((item) => item.kind === 'counterpoint').length, 1);
  const restored = store.restoreCheckpoint(project.id, checkpoint.id);
  assert.equal(restored.reasoning.filter((item) => item.kind === 'counterpoint').length, 0);
  assert.ok(restored.reasoning.some((item) => item.title === 'Baseline exists'));
});

test('persists agent runs, event evidence, and resolvable attention', (t) => {
  const store = setup(t);
  let project = store.createProject({ name: 'Agent supervision', repoPath: '/code/project', brief: 'Make a reviewable change' });
  const branch = project.branches[0];
  let run = store.createAgentRun(project.id, branch.id, { adapter: 'codex', task: 'Update the parser', worktreePath: '/tmp/threadline-run' });
  assert.equal(run.status, 'queued');
  assert.throws(() => store.createAgentRun(project.id, branch.id, { task: 'Competing run' }), /already has an active agent run/);
  store.addAgentRunEvent(project.id, run.id, 'command', 'npm test');
  run = store.updateAgentRun(project.id, run.id, { status: 'completed', files: ['parser.js'], diffStat: 'parser.js | 2 +-', summary: 'Parser updated.' });
  assert.equal(run.events[0].message, 'npm test');
  assert.deepEqual(run.files, ['parser.js']);
  const attention = store.createAttentionItem(project.id, { branchId: branch.id, runId: run.id, kind: 'review', title: 'Parser is ready', detail: 'Inspect one changed file.' });
  project = store.getProject(project.id);
  assert.equal(project.attentionItems[0].status, 'open');
  project = store.resolveAttentionItem(project.id, attention.id);
  assert.equal(project.attentionItems[0].status, 'resolved');
});
