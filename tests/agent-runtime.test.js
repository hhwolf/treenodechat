import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentEnvironment, createAgentRuntime, prepareGitWorktree, summarizeGitWorktree } from '../server/agent-runtime.js';
import { createStore } from '../server/store.js';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'threadline-agent-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'threadline@example.test');
  git(repo, 'config', 'user.name', 'Threadline Test');
  writeFileSync(join(repo, 'README.md'), '# Fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'fixture');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo };
}

async function waitFor(predicate, timeout = 4_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for agent run');
}

test('isolates a Git worktree and summarizes its reviewable diff', (t) => {
  const { root, repo } = repository(t);
  const worktree = join(root, 'worktree');
  const prepared = prepareGitWorktree(repo, worktree);
  writeFileSync(join(worktree, 'change.txt'), 'review me\n');
  const evidence = summarizeGitWorktree(worktree, prepared.baseCommit);
  assert.ok(evidence.files.includes('change.txt'));
  assert.match(evidence.diff, /review me/);
  assert.equal(existsSync(join(repo, 'change.txt')), false);
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# Fixture\n');
});

test('does not forward server credentials into agent commands', () => {
  const environment = buildAgentEnvironment({ PATH: '/usr/bin', HOME: '/safe/home', LLM_API_KEY: 'private', AWS_SECRET_ACCESS_KEY: 'private', GITHUB_TOKEN: 'private' });
  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.HOME, '/safe/home');
  assert.equal(environment.LLM_API_KEY, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
});

test('demo adapter records progress, diff evidence, and human attention', async (t) => {
  const { root, repo } = repository(t);
  const store = createStore(':memory:');
  const runtime = createAgentRuntime(store, { adapter: 'demo', stateRoot: join(root, 'state') });
  t.after(() => { runtime.shutdown(); store.close(); });
  const project = store.createProject({ name: 'Demo run', repoPath: repo, brief: 'Create an isolated demonstration' });
  const run = runtime.start(project.id, project.branches[0].id, 'Leave a small reviewable artifact');
  const completed = await waitFor(() => {
    const current = store.getAgentRun(project.id, run.id);
    return current.status === 'completed' ? current : null;
  });
  assert.ok(completed.files.includes('threadline-agent-demo.md'));
  assert.match(completed.diff, /Leave a small reviewable artifact/);
  assert.ok(completed.events.some((event) => event.kind === 'verification'));
  assert.equal(store.getProject(project.id).attentionItems[0].kind, 'review');
});

function completedRun(store, project, branchId, worktreePath, change) {
  const prepared = prepareGitWorktree(project.repoPath, worktreePath, project.integration?.headCommit || 'HEAD');
  let run = store.createAgentRun(project.id, branchId, { adapter: 'test', task: 'Prepare reviewed changes', worktreePath, baseCommit: prepared.baseCommit });
  change(worktreePath);
  const evidence = summarizeGitWorktree(worktreePath, prepared.baseCommit);
  run = store.updateAgentRun(project.id, run.id, { status: 'completed', ...evidence });
  return run;
}

test('integrates selected files on a dedicated branch without touching the active checkout', async (t) => {
  const { root, repo } = repository(t);
  writeFileSync(join(repo, 'active-only.txt'), 'uncommitted active checkout work\n');
  const activeHead = git(repo, 'rev-parse', 'HEAD');
  const activeStatus = git(repo, 'status', '--porcelain');
  const database = join(root, 'threadline.db');
  let store = createStore(database);
  const runtime = createAgentRuntime(store, { adapter: 'demo', stateRoot: join(root, 'state') });
  let project = store.createProject({ name: 'Safe integration', repoPath: repo, brief: 'Integrate reviewed files' });
  const run = completedRun(store, project, project.branches[0].id, join(root, 'run-selected'), (worktree) => {
    writeFileSync(join(worktree, 'README.md'), '# Integrated\n');
    writeFileSync(join(worktree, 'accepted.txt'), 'accepted\n');
    writeFileSync(join(worktree, 'skipped.txt'), 'skip me\n');
    writeFileSync(join(worktree, 'asset.bin'), Buffer.from([0, 1, 2, 3, 255]));
  });
  const result = await runtime.integrate(project.id, run.id, {
    filePaths: ['README.md', 'accepted.txt', 'asset.bin'],
    commitMessage: 'Integrate selected files'
  });
  assert.match(result.integration.branchName, /^threadline\/safe-integration-/);
  assert.equal(git(repo, 'show', `${result.integration.commit}:README.md`), '# Integrated');
  assert.equal(git(repo, 'show', `${result.integration.commit}:accepted.txt`), 'accepted');
  assert.throws(() => git(repo, 'show', `${result.integration.commit}:skipped.txt`));
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# Fixture\n');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), activeHead);
  assert.equal(git(repo, 'status', '--porcelain'), activeStatus);
  assert.equal(result.project.integration.headCommit, result.integration.commit);
  assert.equal(result.run.integration.commit, result.integration.commit);
  const followUp = completedRun(store, result.project, result.project.branches[0].id, join(root, 'run-follow-up'), (worktree) => {
    assert.equal(readFileSync(join(worktree, 'accepted.txt'), 'utf8'), 'accepted\n');
    writeFileSync(join(worktree, 'follow-up.txt'), 'continues from accepted code\n');
  });
  assert.equal(followUp.baseCommit, result.integration.commit);
  const repeated = await runtime.integrate(project.id, run.id, { filePaths: ['README.md'] });
  assert.equal(repeated.integration.commit, result.integration.commit);
  runtime.shutdown();
  store.close();

  store = createStore(database);
  project = store.getProject(project.id);
  assert.equal(project.integration.headCommit, result.integration.commit);
  assert.equal(project.agentRuns.find((item) => item.id === run.id).integration.commit, result.integration.commit);
  store.close();
});

test('rejects unsafe, stale, and incomplete integration selections', async (t) => {
  const { root, repo } = repository(t);
  const store = createStore(':memory:');
  const runtime = createAgentRuntime(store, { adapter: 'demo', stateRoot: join(root, 'state') });
  t.after(() => { runtime.shutdown(); store.close(); });
  const project = store.createProject({ name: 'Validation', repoPath: repo, brief: 'Reject invalid integrations' });
  const queued = store.createAgentRun(project.id, project.branches[0].id, { adapter: 'test', task: 'Still working', worktreePath: join(root, 'missing') });
  await assert.rejects(() => runtime.integrate(project.id, queued.id, { filePaths: ['README.md'] }), /completed/);
  store.updateAgentRun(project.id, queued.id, { status: 'failed' });
  const run = completedRun(store, project, project.branches[0].id, join(root, 'validation-run'), (worktree) => writeFileSync(join(worktree, 'valid.txt'), 'valid\n'));
  await assert.rejects(() => runtime.integrate(project.id, run.id, { filePaths: [] }), /at least one/);
  await assert.rejects(() => runtime.integrate(project.id, run.id, { filePaths: ['../valid.txt'] }), /safe repository-relative/);
  await assert.rejects(() => runtime.integrate(project.id, run.id, { filePaths: ['not-changed.txt'] }), /no longer match/);
});

test('three-way integrates non-overlapping parallel runs and supports deletes and renames', async (t) => {
  const { root, repo } = repository(t);
  writeFileSync(join(repo, 'delete-me.txt'), 'remove\n');
  writeFileSync(join(repo, 'rename-me.txt'), 'rename\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'more fixtures');
  const store = createStore(':memory:');
  const runtime = createAgentRuntime(store, { adapter: 'demo', stateRoot: join(root, 'state') });
  const project = store.createProject({ name: 'Parallel integration', repoPath: repo, brief: 'Combine parallel work' });
  const first = completedRun(store, project, project.branches[0].id, join(root, 'run-a'), (worktree) => writeFileSync(join(worktree, 'first.txt'), 'first\n'));
  const secondBranchProject = store.createBranch(project.id, { parentId: project.branches[0].id, name: 'Second' });
  const secondBranch = secondBranchProject.branches.find((item) => item.name === 'Second');
  const second = completedRun(store, project, secondBranch.id, join(root, 'run-b'), (worktree) => {
    rmSync(join(worktree, 'delete-me.txt'));
    renameSync(join(worktree, 'rename-me.txt'), join(worktree, 'renamed.txt'));
  });
  const integratedA = await runtime.integrate(project.id, first.id, { filePaths: first.files, commitMessage: 'First parallel change' });
  const integratedB = await runtime.integrate(project.id, second.id, { filePaths: second.files, commitMessage: 'Second parallel change' });
  assert.notEqual(integratedA.integration.commit, integratedB.integration.commit);
  assert.equal(git(repo, 'show', `${integratedB.integration.commit}:first.txt`), 'first');
  assert.equal(git(repo, 'show', `${integratedB.integration.commit}:renamed.txt`), 'rename');
  assert.throws(() => git(repo, 'show', `${integratedB.integration.commit}:delete-me.txt`));
  assert.throws(() => git(repo, 'show', `${integratedB.integration.commit}:rename-me.txt`));
  runtime.shutdown();
  store.close();
});

test('reports parallel conflicts and restores the dedicated integration workspace', async (t) => {
  const { root, repo } = repository(t);
  const store = createStore(':memory:');
  const runtime = createAgentRuntime(store, { adapter: 'demo', stateRoot: join(root, 'state') });
  let project = store.createProject({ name: 'Conflict integration', repoPath: repo, brief: 'Protect accepted work' });
  const first = completedRun(store, project, project.branches[0].id, join(root, 'conflict-a'), (worktree) => writeFileSync(join(worktree, 'README.md'), '# First\n'));
  project = store.createBranch(project.id, { parentId: project.branches[0].id, name: 'Conflict B' });
  const secondBranch = project.branches.find((item) => item.name === 'Conflict B');
  const second = completedRun(store, project, secondBranch.id, join(root, 'conflict-b'), (worktree) => writeFileSync(join(worktree, 'README.md'), '# Second\n'));
  const accepted = await runtime.integrate(project.id, first.id, { filePaths: ['README.md'] });
  await assert.rejects(() => runtime.integrate(project.id, second.id, { filePaths: ['README.md'] }), (error) => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.details.conflicts, ['README.md']);
    return true;
  });
  assert.equal(git(accepted.project.integration.workspacePath, 'rev-parse', 'HEAD'), accepted.integration.commit);
  assert.equal(git(accepted.project.integration.workspacePath, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'show', `${accepted.integration.commit}:README.md`), '# First');
  runtime.shutdown();
  store.close();
});

test('verifies a completed run in its worktree from the parent process', async (t) => {
  const { root, repo } = repository(t);
  const store = createStore(':memory:');
  const runtime = createAgentRuntime(store, { adapter: 'demo', stateRoot: join(root, 'state') });
  t.after(() => { runtime.shutdown(); store.close(); });
  const project = store.createProject({ name: 'Verify locally', repoPath: repo, brief: 'Run checks against agent output' });
  const run = completedRun(store, project, project.branches[0].id, join(root, 'verify-worktree'), (worktree) => {
    writeFileSync(join(worktree, 'change.txt'), 'verify me\n');
  });

  const started = runtime.verify(project.id, run.id, { command: 'cat change.txt && echo checks passed' });
  assert.equal(started.verification.status, 'running');
  assert.equal(started.verification.mode, 'worktree');
  const passed = await waitFor(() => {
    const current = store.getAgentRun(project.id, run.id);
    return current.verification?.status === 'passed' ? current : null;
  });
  assert.equal(passed.verification.exitCode, 0);
  assert.ok(passed.events.some((event) => event.kind === 'verify' && /checks passed/.test(event.message)));

  const failing = runtime.verify(project.id, run.id, { command: 'echo broken output && exit 3' });
  assert.equal(failing.verification.status, 'running');
  const failed = await waitFor(() => {
    const current = store.getAgentRun(project.id, run.id);
    return current.verification?.status === 'failed' ? current : null;
  });
  assert.equal(failed.verification.exitCode, 3);
  assert.ok(failed.events.some((event) => event.kind === 'verify' && /broken output/.test(event.message)));
  const attention = store.getProject(project.id).attentionItems.find((item) => item.kind === 'failure' && item.runId === run.id);
  assert.match(attention.title, /verification failed/);

  assert.throws(() => runtime.verify(project.id, run.id, { command: '' }), /verify command/);
});

test('commits a rules document onto the integration branch without touching the checkout', async (t) => {
  const { root, repo } = repository(t);
  const store = createStore(':memory:');
  const runtime = createAgentRuntime(store, { adapter: 'demo', stateRoot: join(root, 'state') });
  t.after(() => { runtime.shutdown(); store.close(); });
  let project = store.createProject({ name: 'Rules commit', repoPath: repo, brief: 'Sync the project rules' });
  const doc = project.documents[0];
  const activeHead = git(repo, 'rev-parse', 'HEAD');

  const result = runtime.commitDocument(project.id, doc.id, { message: 'Sync CLAUDE.md' });
  assert.equal(result.commit.path, 'CLAUDE.md');
  project = store.getProject(project.id);
  assert.equal(project.documents[0].committedSha, result.commit.sha);
  assert.equal(project.documents[0].committedBranch, result.commit.branch);
  assert.equal(project.integration.headCommit, result.commit.sha);
  assert.match(git(repo, 'show', `${result.commit.branch}:CLAUDE.md`), /Rules commit/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), activeHead);
  assert.equal(existsSync(join(repo, 'CLAUDE.md')), false);

  const again = runtime.commitDocument(project.id, doc.id, {});
  assert.equal(again.commit.sha, result.commit.sha);
});
