import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createCloudStore } from '../server/cloud-store.js';
import { createSandboxRuntime } from '../server/sandbox-runtime.js';

function finished(stdout = '', stderr = '', exitCode = 0) {
  return { exitCode, stdout: async () => stdout, stderr: async () => stderr };
}

class FakeSandbox {
  static created = [];
  static expired = new Set();

  static async create(options) {
    const sandbox = new FakeSandbox(options);
    FakeSandbox.created.push(sandbox);
    return sandbox;
  }

  static async get({ name }) {
    if (FakeSandbox.expired.has(name)) throw new Error('Sandbox not found');
    return FakeSandbox.created.find((sandbox) => sandbox.name === name);
  }

  constructor(options) {
    this.options = options;
    this.name = options.name;
    this.cwd = '/vercel';
    this.files = [];
    this.policies = [];
    this.commands = [];
    this.contents = new Map();
    this.signals = [];
  }

  async runCommand(command) {
    if (typeof command === 'object') {
      this.commands.push(command);
      if (!command.detached) {
        const args = command.args;
        if (command.cmd === 'git' && args[0] === '-C') {
          return args[1] === '/vercel/project'
            ? finished('/vercel/project\n')
            : finished('', 'fatal: not a git repository (or any of the parent directories): .git', 128);
        }
        if (command.cmd === 'git' && args[0] === 'apply') {
          return FakeSandbox.applyExitCode ? finished('', 'error: patch failed: src/app.js', FakeSandbox.applyExitCode) : finished();
        }
        if (command.cmd === 'git' && args.includes('--diff-filter=U')) return finished(FakeSandbox.applyExitCode ? 'src/app.js\n' : '');
        if (command.cmd === 'git' && args.includes('--cached')) return finished('', '', 1);
        if (command.cmd === 'git' && args.includes('commit')) { this.committed = true; return finished(); }
        if (command.cmd === 'git' && args[0] === 'rev-parse') return finished(this.committed ? 'def456\n' : 'abc123\n');
        if (command.cmd === 'git' && args[0] === 'status' && this.completed) return finished(' M src/app.js\0?? tests/new.test.js\0');
        if (command.cmd === 'git' && args[0] === 'ls-files') return finished(this.completed ? 'tests/new.test.js\0' : '');
        if (command.cmd === 'git' && args.includes('--stat')) return finished('src/app.js | 2 +-\n');
        if (command.cmd === 'git' && args.includes('--no-renames') && args.includes('--binary')) return finished('diff --git a/src/app.js b/src/app.js\n+binary-safe tracked patch\n');
        if (command.cmd === 'git' && args.includes('--no-index') && args.includes('--binary')) return finished('diff --git a/tests/new.test.js b/tests/new.test.js\nnew file mode 100644\n', '', 1);
        if (command.cmd === 'git' && args.includes('--no-color')) return finished('diff --git a/src/app.js b/src/app.js\n+review me\n', '', 1);
        if (command.cmd === 'codex' && args[0] === '--version') return finished('codex 1.0\n');
        return finished();
      }
      this.detachedCommand = command;
      return { cmdId: 'command-1' };
    }
    return finished();
  }

  async mkDir(path) { this.directory = path; }
  async writeFiles(files) { this.files.push(...files); }
  async updateNetworkPolicy(policy) { this.policies.push(policy); }
  async stop() { this.stopped = true; }
  async readFileToBuffer({ path }) { return Buffer.from(this.contents.get(path) || ''); }
  async getCommand() { return { kill: async (signal) => { this.signals.push(signal); } }; }
}

function setup(t) {
  FakeSandbox.created = [];
  FakeSandbox.applyExitCode = 0;
  FakeSandbox.expired = new Set();
  const database = newDb();
  const { Pool } = database.adapters.createPg();
  const store = createCloudStore('', { pool: new Pool() });
  t.after(() => store.close());
  return store;
}

test('reports the exact hosted agent configuration that is missing', async () => {
  const runtime = createSandboxRuntime({}, { SandboxClass: FakeSandbox, openAIKey: '', allowWithoutVercelAuth: true });
  assert.deepEqual(await runtime.adapterInfo(), {
    id: 'codex-sandbox',
    name: 'Codex on Vercel Sandbox',
    available: false,
    version: 'gpt-5.6-sol',
    error: 'Configure OPENAI_API_KEY',
    safety: 'isolated-sandbox',
    supportsIntegration: false
  });
});

test('starts Codex in a persistent Git sandbox with shared context and restricted network', async (t) => {
  const store = setup(t);
  let project = await store.createProject({ name: 'Sandbox run', repoPath: 'https://github.com/example/project', brief: 'Make one safe change.' });
  project = await store.createContext(project.id, { label: 'Shared rule', value: 'Run focused tests.', scope: 'project', sensitivity: 'shared' });
  project = await store.createContext(project.id, { label: 'Private note', value: 'Do not expose me.', scope: 'project', sensitivity: 'private' });
  const runtime = createSandboxRuntime(store, {
    SandboxClass: FakeSandbox,
    openAIKey: 'openai-secret',
    githubToken: 'github-read-token',
    allowWithoutVercelAuth: true
  });
  const run = await runtime.start(project.id, project.branches[0].id, 'Add one focused test.');
  const sandbox = FakeSandbox.created[0];
  const prompt = sandbox.files.find((file) => file.path.endsWith('prompt.txt')).content.toString('utf8');

  assert.equal(run.status, 'running');
  assert.equal(sandbox.options.persistent, true);
  assert.deepEqual(sandbox.options.source, {
    type: 'git',
    url: 'https://github.com/example/project.git',
    depth: 50,
    username: 'x-access-token',
    password: 'github-read-token'
  });
  assert.deepEqual(sandbox.policies, [{ allow: ['api.openai.com'] }]);
  assert.ok(sandbox.commands.some((command) => command.cmd === 'git' && command.args.join(' ') === 'remote set-url origin https://github.com/example/project.git'));
  assert.match(prompt, /Shared rule: Run focused tests/);
  assert.doesNotMatch(prompt, /Do not expose me/);
  assert.equal(sandbox.detachedCommand.detached, true);
  assert.equal(sandbox.detachedCommand.env.OPENAI_API_KEY, 'openai-secret');
  assert.equal(sandbox.detachedCommand.env.THREADLINE_MODEL, 'gpt-5.6-sol');
  assert.equal(run.worktreePath, '/vercel/project');
  assert.equal(sandbox.detachedCommand.cwd, '/vercel/project');
  assert.equal(sandbox.detachedCommand.env.THREADLINE_REPO, '/vercel/project');
});

test('pauses, resumes, and collects terminal Sandbox evidence for human review', async (t) => {
  const store = setup(t);
  const project = await store.createProject({ name: 'Lifecycle', repoPath: 'https://github.com/example/project', brief: 'Supervise one change.' });
  const runtime = createSandboxRuntime(store, {
    SandboxClass: FakeSandbox,
    openAIKey: 'openai-secret',
    allowWithoutVercelAuth: true
  });
  const started = await runtime.start(project.id, project.branches[0].id, 'Change one file.');
  const sandbox = FakeSandbox.created[0];

  assert.equal((await runtime.control(project.id, started.id, 'pause')).status, 'paused');
  assert.equal((await runtime.control(project.id, started.id, 'resume')).status, 'running');
  assert.deepEqual(sandbox.signals, ['SIGSTOP', 'SIGCONT']);

  sandbox.completed = true;
  sandbox.contents.set('/vercel/threadline/events.jsonl', '{"type":"item.completed","message":"Tests passed"}\n');
  sandbox.contents.set('/vercel/threadline/status.json', '{"status":"completed","exitCode":0}');
  sandbox.contents.set('/vercel/threadline/last-message.txt', 'Implemented and verified one focused change.');
  const completed = await runtime.refresh(project.id, started.id);
  const updated = await store.getProject(project.id);

  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.files, ['src/app.js', 'tests/new.test.js']);
  assert.match(completed.diff, /review me/);
  assert.ok(completed.events.some((event) => event.message === 'Tests passed'));
  assert.equal(updated.branches[0].status, 'review');
  assert.equal(updated.attentionItems[0].kind, 'review');
  assert.equal(sandbox.stopped, true);

  const patch = await store.getAgentRunPatch(project.id, started.id);
  assert.match(patch, /binary-safe tracked patch/);
  assert.match(patch, /new file mode 100644/);
});

async function setupCompletedHostedRun(t, name, projectExtras = {}) {
  const store = setup(t);
  const project = await store.createProject({ name, repoPath: 'https://github.com/example/project', brief: 'Ship accepted code.', ...projectExtras });
  const runtime = createSandboxRuntime(store, {
    SandboxClass: FakeSandbox,
    openAIKey: 'openai-secret',
    githubToken: 'github-write-token',
    allowWithoutVercelAuth: true
  });
  const started = await runtime.start(project.id, project.branches[0].id, 'Change two files.');
  const sandbox = FakeSandbox.created[0];
  sandbox.completed = true;
  sandbox.contents.set('/vercel/threadline/status.json', '{"status":"completed","exitCode":0}');
  await runtime.refresh(project.id, started.id);
  return { store, runtime, project, runId: started.id };
}

test('integrates selected hosted files onto a pushed GitHub project branch', async (t) => {
  const { store, runtime, project, runId } = await setupCompletedHostedRun(t, 'Hosted Integration');
  assert.equal((await runtime.adapterInfo()).supportsIntegration, true);

  const result = await runtime.integrate(project.id, runId, { filePaths: ['src/app.js'], commitMessage: 'Accept hosted change' });
  const integrationSandbox = FakeSandbox.created[1];

  assert.equal(result.integration.pushed, true);
  assert.equal(result.integration.commit, 'def456');
  assert.equal(result.integration.branchName, `threadline/hosted-integration-${project.id.slice(0, 6)}`);
  assert.deepEqual(result.integration.files, ['src/app.js']);
  assert.deepEqual(integrationSandbox.options.source, {
    type: 'git', url: 'https://github.com/example/project.git', depth: 50,
    username: 'x-access-token', password: 'github-write-token'
  });
  assert.ok(integrationSandbox.files.some((file) => file.path === '/vercel/threadline/patch.diff' && /binary-safe tracked patch/.test(file.content.toString('utf8'))));
  assert.ok(integrationSandbox.commands.some((command) => command.cmd === 'git' && command.args[0] === 'apply'
    && command.args.includes('--3way') && command.args.includes('--include=src/app.js')));
  assert.ok(integrationSandbox.commands.some((command) => command.cmd === 'git' && command.args.includes('commit') && command.args.includes('Accept hosted change')));
  assert.ok(integrationSandbox.commands.some((command) => command.cmd === 'git' && command.args[0] === 'push'));
  assert.equal(integrationSandbox.stopped, true);

  const updated = await store.getProject(project.id);
  assert.equal(updated.integration.headCommit, 'def456');
  assert.equal(updated.integration.branchName, result.integration.branchName);
  const run = await store.getAgentRun(project.id, runId);
  assert.ok(run.events.some((event) => event.kind === 'integrated'));

  const retry = await runtime.integrate(project.id, runId, { filePaths: ['src/app.js'] });
  assert.equal(retry.integration.commit, 'def456');
  assert.equal(FakeSandbox.created.length, 2);

  const next = await runtime.start(project.id, project.branches[0].id, 'Continue from accepted code.');
  const nextSandbox = FakeSandbox.created[2];
  assert.ok(nextSandbox.commands.some((command) => command.cmd === 'git' && command.args.join(' ') === 'checkout --detach def456'));
  assert.equal(next.status, 'running');
});

test('reports hosted integration conflicts without recording an integration', async (t) => {
  const { store, runtime, project, runId } = await setupCompletedHostedRun(t, 'Hosted Conflict');
  FakeSandbox.applyExitCode = 1;

  await assert.rejects(
    runtime.integrate(project.id, runId, { filePaths: ['src/app.js'] }),
    (error) => error.status === 409 && error.details.conflicts.includes('src/app.js')
  );
  const run = await store.getAgentRun(project.id, runId);
  assert.equal(run.integration?.commit, undefined);
  assert.ok(run.events.some((event) => event.kind === 'conflict'));
  assert.equal(FakeSandbox.created[1].stopped, true);
});

test('keeps hosted runs review-only when the stored patch or token is missing', async (t) => {
  const { store, runtime, project, runId } = await setupCompletedHostedRun(t, 'Hosted Guardrails');
  await assert.rejects(runtime.integrate(project.id, runId, { filePaths: ['../escape.js'] }), /safe repository-relative/);
  await assert.rejects(runtime.integrate(project.id, runId, { filePaths: ['docs/unknown.md'] }), /no longer match/);

  const reviewOnly = createSandboxRuntime(store, { SandboxClass: FakeSandbox, openAIKey: 'openai-secret', githubToken: '', allowWithoutVercelAuth: true });
  assert.equal((await reviewOnly.adapterInfo()).supportsIntegration, false);
  await assert.rejects(reviewOnly.integrate(project.id, runId, { filePaths: ['src/app.js'] }), /GITHUB_TOKEN/);
});

test('verifies a completed hosted run by resuming its sandbox', async (t) => {
  const { store, runtime, project, runId } = await setupCompletedHostedRun(t, 'Hosted Verify', {
    repository: { excerpts: [{ path: 'package.json', content: '{"scripts":{"test":"node --test"}}' }] }
  });
  const started = await runtime.verify(project.id, runId, {});
  assert.equal(started.verification.status, 'running');
  assert.equal(started.verification.mode, 'resumed');
  assert.equal(started.verification.command, 'npm test');

  const sandbox = FakeSandbox.created[0];
  assert.deepEqual(sandbox.policies.at(-1), { allow: ['registry.npmjs.org'] });
  assert.equal(sandbox.detachedCommand.env.THREADLINE_VERIFY_CMD, 'npm test');
  assert.ok(sandbox.files.some((file) => file.path === '/vercel/threadline/verify.sh'));

  sandbox.contents.set('/vercel/threadline/verify.log', 'test suite output\nall green\n');
  sandbox.contents.set('/vercel/threadline/verify-status.json', '{"status":"passed","exitCode":0,"durationMs":34000}');
  await runtime.refreshProject(project.id);
  const run = await store.getAgentRun(project.id, runId);
  assert.equal(run.verification.status, 'passed');
  assert.equal(run.verification.exitCode, 0);
  assert.ok(run.events.some((event) => event.kind === 'verify' && /all green/.test(event.message)));
  assert.ok(run.events.some((event) => /Verification passed in 34s/.test(event.message)));
  assert.equal(sandbox.stopped, true);
});

test('recreates an expired sandbox from the stored patch for verification', async (t) => {
  const { store, runtime, project, runId } = await setupCompletedHostedRun(t, 'Hosted Verify Expired');
  await store.updateProjectSettings(project.id, { verifyCommand: 'npm run test:browser' });
  FakeSandbox.expired.add(FakeSandbox.created[0].name);

  const started = await runtime.verify(project.id, runId, {});
  assert.equal(started.verification.mode, 'recreated');
  assert.equal(started.verification.command, 'npm run test:browser');
  const sandbox = FakeSandbox.created[1];
  assert.match(sandbox.name, /^tl-ver-/);
  assert.ok(sandbox.commands.some((command) => command.cmd === 'git' && command.args.join(' ') === 'checkout --detach abc123'));
  const apply = sandbox.commands.find((command) => command.cmd === 'git' && command.args[0] === 'apply');
  assert.ok(apply.args.includes('--3way'));
  assert.ok(!apply.args.some((arg) => arg.startsWith('--include')));
  assert.ok(sandbox.files.some((file) => file.path === '/vercel/threadline/patch.diff' && /binary-safe tracked patch/.test(file.content.toString('utf8'))));

  sandbox.contents.set('/vercel/threadline/verify-status.json', '{"status":"failed","exitCode":1,"durationMs":9000}');
  await runtime.refreshProject(project.id);
  const run = await store.getAgentRun(project.id, runId);
  assert.equal(run.verification.status, 'failed');
  const attention = (await store.getProject(project.id)).attentionItems.find((item) => item.kind === 'failure' && item.runId === runId);
  assert.match(attention.title, /verification failed/);
});

test('refuses hosted verification without a detectable verify command', async (t) => {
  const { runtime, project, runId } = await setupCompletedHostedRun(t, 'Hosted Verify Missing');
  await assert.rejects(runtime.verify(project.id, runId, {}), /verify command/);
});

test('escapes glob metacharacters when integrating selected files', async (t) => {
  const { store, runtime, project, runId } = await setupCompletedHostedRun(t, 'Hosted Glob');
  await store.updateAgentRun(project.id, runId, { files: ['src/app.js', 'api/[slug].js'] });
  const result = await runtime.integrate(project.id, runId, { filePaths: ['api/[slug].js'], commitMessage: 'Accept bracket file' });
  assert.equal(result.integration.commit, 'def456');
  const apply = FakeSandbox.created[1].commands.find((command) => command.cmd === 'git' && command.args[0] === 'apply');
  assert.ok(apply.args.includes('--include=api/\\[slug\\].js'));
});
