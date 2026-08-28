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

  static async create(options) {
    const sandbox = new FakeSandbox(options);
    FakeSandbox.created.push(sandbox);
    return sandbox;
  }

  static async get({ name }) {
    return FakeSandbox.created.find((sandbox) => sandbox.name === name);
  }

  constructor(options) {
    this.options = options;
    this.name = options.name;
    this.cwd = '/vercel/sandbox';
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
        if (command.cmd === 'git' && command.args[0] === 'rev-parse') return finished('abc123\n');
        if (command.cmd === 'git' && command.args[0] === 'status' && this.completed) return finished(' M src/app.js\n?? tests/new.test.js\n');
        if (command.cmd === 'git' && command.args.includes('--stat')) return finished('src/app.js | 2 +-\n');
        if (command.cmd === 'git' && command.args.includes('--no-color')) return finished('diff --git a/src/app.js b/src/app.js\n+review me\n', '', 1);
        if (command.cmd === 'codex' && command.args[0] === '--version') return finished('codex 1.0\n');
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
});
