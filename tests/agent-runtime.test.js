import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
