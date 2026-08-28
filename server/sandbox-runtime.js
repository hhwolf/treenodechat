import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { parseGitHubRepository } from './github-repository.js';

const ACTIVE = new Set(['queued', 'running', 'paused']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_TASK_CHARS = 4_000;
const MAX_DIFF_CHARS = 100_000;
const DEFAULT_TIMEOUT = 40 * 60 * 1_000;
const refreshes = new Map();

function readableEvent(payload) {
  const kind = payload.type || payload.event || payload.item?.type || 'progress';
  const message = payload.message || payload.text || payload.delta || payload.item?.text || payload.item?.content?.[0]?.text;
  if (typeof message === 'string' && message.trim()) return { kind, message: message.trim() };
  const command = payload.command || payload.item?.command;
  if (typeof command === 'string') return { kind, message: `Command: ${command}` };
  return { kind, message: String(kind).replaceAll('.', ' ') };
}

function buildAgentPrompt(project, branch, contexts, task) {
  const sharedContext = contexts.map((item) => `- ${item.label}: ${item.value}`).join('\n') || '- No additional shared context.';
  return `You are a coding agent working in an isolated Vercel Sandbox managed by Threadline.

Project objective: ${project.intent.objective}
Desired outcome: ${project.intent.outcome}
Quality bar: ${project.intent.qualityBar}
Avoid: ${project.intent.avoid}

Branch: ${branch.name}
Branch purpose: ${branch.purpose || 'Complete the assigned task safely.'}
Assigned task: ${task}

Shared context:
${sharedContext}

Operating rules:
- Work only in the checked-out repository inside this sandbox.
- Do not push, change Git remotes, modify Git configuration, or create external side effects.
- Do not read secret-like files or seek private context.
- Do not commit. Leave changes in the sandbox for human review.
- Run the smallest relevant verification available locally.
- If blocked, explain the blocker and stop instead of guessing.
- Finish with a concise summary of files changed, tests run, and remaining risk.`;
}

async function readText(sandbox, path, limit = 1_000_000) {
  const value = await sandbox.readFileToBuffer({ path });
  return value ? value.toString('utf8').slice(0, limit) : '';
}

async function commandText(sandbox, cmd, args, cwd) {
  const result = await sandbox.runCommand({ cmd, args, cwd });
  return { exitCode: result.exitCode, stdout: await result.stdout(), stderr: await result.stderr() };
}

async function summarizeSandbox(sandbox, baseCommit) {
  const cwd = sandbox.cwd;
  const status = await commandText(sandbox, 'git', ['status', '--short', '--untracked-files=all'], cwd);
  const statusLines = status.stdout.split('\n').filter(Boolean);
  const files = [...new Set(statusLines.map((line) => line.slice(3).replace(/^.* -> /, '')).filter(Boolean))].slice(0, 100);
  const untracked = statusLines.filter((line) => line.startsWith('?? ')).map((line) => line.slice(3)).slice(0, 30);
  const stat = await commandText(sandbox, 'git', ['diff', '--stat', baseCommit], cwd);
  const trackedDiff = await commandText(sandbox, 'git', ['diff', '--no-color', '--unified=3', baseCommit], cwd);
  const untrackedDiffs = [];
  for (const file of untracked) {
    const result = await commandText(sandbox, 'git', ['diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', file], cwd);
    if (result.exitCode === 0 || result.exitCode === 1) untrackedDiffs.push(result.stdout);
  }
  return {
    files,
    diffStat: [stat.stdout.trim(), ...untracked.map((file) => `${file} | new file`)].filter(Boolean).join('\n').slice(0, 8_000),
    diff: [trackedDiff.stdout.trim(), ...untrackedDiffs.map((item) => item.trim())].filter(Boolean).join('\n\n').slice(0, MAX_DIFF_CHARS)
  };
}

export function createSandboxRuntime(store, options = {}) {
  const openAIKey = Object.hasOwn(options, 'openAIKey') ? options.openAIKey : process.env.OPENAI_API_KEY;
  const githubToken = Object.hasOwn(options, 'githubToken') ? options.githubToken : process.env.GITHUB_TOKEN;
  const model = options.model || process.env.OPENAI_MODEL || 'gpt-5.6-sol';
  const timeout = Number(options.timeout || process.env.THREADLINE_SANDBOX_TIMEOUT || DEFAULT_TIMEOUT);
  const SandboxClass = options.SandboxClass || Sandbox;

  async function adapterInfo() {
    const sandboxAuth = Boolean(process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN || options.allowWithoutVercelAuth);
    const missing = [];
    if (!openAIKey) missing.push('OPENAI_API_KEY');
    if (!sandboxAuth) missing.push('Vercel Sandbox authentication');
    return {
      id: 'codex-sandbox',
      name: 'Codex on Vercel Sandbox',
      available: missing.length === 0,
      version: model,
      error: missing.length ? `Configure ${missing.join(' and ')}` : '',
      safety: 'isolated-sandbox',
      supportsIntegration: false
    };
  }

  async function fail(project, branch, run, error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.addAgentRunEvent(project.id, run.id, 'failed', message);
    await store.updateAgentRun(project.id, run.id, { status: 'failed', summary: message, exitCode: null });
    await store.updateBranch(project.id, branch.id, { status: 'review', output: { summary: `Agent run failed: ${message}`, changes: [] } });
    await store.createAttentionItem(project.id, {
      branchId: branch.id, runId: run.id, kind: 'failure', severity: 'high',
      title: `${branch.name} needs intervention`, detail: message
    });
  }

  async function start(projectId, branchId, task) {
    const value = String(task || '').trim();
    if (!value) throw new Error('Describe what the agent should accomplish');
    if (value.length > MAX_TASK_CHARS) throw new Error(`Agent task must be ${MAX_TASK_CHARS} characters or fewer`);
    const info = await adapterInfo();
    if (!info.available) throw new Error(info.error);
    const project = await store.getProject(projectId);
    const branch = project?.branches.find((item) => item.id === branchId);
    if (!project || !branch) throw new Error('Project or branch not found');
    if (!project.repoPath) throw new Error('Connect a GitHub repository before starting an agent');
    const parsed = parseGitHubRepository(project.repoPath);
    if (project.repository?.private && !githubToken) throw new Error('GITHUB_TOKEN is required for this private repository');
    const runId = randomUUID();
    const sandboxName = `tl-${runId}`;
    let sandbox;
    let run = await store.createAgentRun(projectId, branchId, {
      id: runId, adapter: 'codex-sandbox', task: value, worktreePath: '/vercel/sandbox', sandboxName
    });

    try {
      const source = {
        type: 'git', url: `${parsed.root}.git`, depth: 50,
        ...(githubToken ? { username: 'x-access-token', password: githubToken } : {})
      };
      sandbox = await SandboxClass.create({
        name: sandboxName,
        source,
        persistent: true,
        timeout: Math.min(Math.max(timeout, 5 * 60_000), 24 * 60 * 60_000),
        networkPolicy: 'allow-all',
        tags: { product: 'threadline', run: runId.slice(0, 8) }
      });
      const base = await commandText(sandbox, 'git', ['rev-parse', 'HEAD'], sandbox.cwd);
      if (base.exitCode !== 0) throw new Error(base.stderr.trim() || 'Sandbox repository checkout failed');
      const sanitizedRemote = await commandText(sandbox, 'git', ['remote', 'set-url', 'origin', `${parsed.root}.git`], sandbox.cwd);
      if (sanitizedRemote.exitCode !== 0) throw new Error(sanitizedRemote.stderr.trim() || 'Could not sanitize the sandbox Git remote');
      const codex = await commandText(sandbox, 'codex', ['--version'], sandbox.cwd);
      if (codex.exitCode !== 0) {
        const install = await commandText(sandbox, 'npm', ['install', '--global', '@openai/codex'], sandbox.cwd);
        if (install.exitCode !== 0) throw new Error(install.stderr.trim() || 'Could not install Codex in the sandbox');
      }
      await sandbox.mkDir('/vercel/threadline');
      const runner = `#!/usr/bin/env bash
set +e
printf '{"status":"running"}' > /vercel/threadline/status.json
codex exec --json --sandbox workspace-write --model "$THREADLINE_MODEL" --output-last-message /vercel/threadline/last-message.txt -C "$THREADLINE_REPO" - < /vercel/threadline/prompt.txt > /vercel/threadline/events.jsonl 2> /vercel/threadline/stderr.log
code=$?
if [ "$code" -eq 0 ]; then state=completed; else state=failed; fi
printf '{"status":"%s","exitCode":%s}' "$state" "$code" > /vercel/threadline/status.json
exit "$code"
`;
      await sandbox.writeFiles([
        { path: '/vercel/threadline/prompt.txt', content: Buffer.from(buildAgentPrompt(project, branch, await store.inheritedContexts(projectId, branchId), value)) },
        { path: '/vercel/threadline/run.sh', content: Buffer.from(runner) },
        { path: '/vercel/threadline/events.jsonl', content: Buffer.from('') },
        { path: '/vercel/threadline/stderr.log', content: Buffer.from('') }
      ]);
      await sandbox.updateNetworkPolicy({ allow: ['api.openai.com'] });
      const command = await sandbox.runCommand({
        cmd: 'bash', args: ['/vercel/threadline/run.sh'], cwd: sandbox.cwd, detached: true,
        env: { OPENAI_API_KEY: openAIKey, THREADLINE_MODEL: model, THREADLINE_REPO: sandbox.cwd, NO_COLOR: '1' }
      });
      run = await store.updateAgentRun(projectId, runId, {
        status: 'running', baseCommit: base.stdout.trim(), sandboxName: sandbox.name, commandId: command.cmdId,
        sessionId: sandbox.name, worktreePath: sandbox.cwd
      });
      await store.addAgentRunEvent(projectId, runId, 'started', `Codex started in isolated sandbox ${sandbox.name}.`);
      return run;
    } catch (error) {
      await sandbox?.stop?.().catch(() => {});
      await fail(project, branch, run, error);
      throw error;
    }
  }

  async function appendEvents(projectId, run, contents) {
    const lines = contents.split('\n').filter((line) => line.trim());
    const nextLines = lines.slice(run.eventCursor || 0);
    const events = nextLines.map((line) => {
      try { return readableEvent(JSON.parse(line)); }
      catch { return { kind: 'output', message: line }; }
    }).filter((event) => event.message);
    if (store.appendAgentRunEvents) await store.appendAgentRunEvents(projectId, run.id, events, lines.length);
    else {
      for (const event of events) await store.addAgentRunEvent(projectId, run.id, event.kind, event.message);
      await store.updateAgentRun(projectId, run.id, { eventCursor: lines.length });
    }
  }

  async function doRefresh(projectId, runId) {
    let run = await store.getAgentRun(projectId, runId);
    if (!run || TERMINAL.has(run.status) || !run.sandboxName) return run;
    try {
      const sandbox = await SandboxClass.get({ name: run.sandboxName, resume: true });
      const events = await readText(sandbox, '/vercel/threadline/events.jsonl');
      await appendEvents(projectId, run, events);
      run = await store.getAgentRun(projectId, runId);
      let state = {};
      try { state = JSON.parse(await readText(sandbox, '/vercel/threadline/status.json', 2_000) || '{}'); } catch { /* A partial write is retried on the next poll. */ }
      if (!TERMINAL.has(state.status)) return run;
      const project = await store.getProject(projectId);
      const branch = project?.branches.find((item) => item.id === run.branchId);
      const evidence = await summarizeSandbox(sandbox, run.baseCommit || 'HEAD');
      const finalMessage = (await readText(sandbox, '/vercel/threadline/last-message.txt', 20_000)).trim();
      const stderr = (await readText(sandbox, '/vercel/threadline/stderr.log', 20_000)).trim();
      const summary = finalMessage || (state.status === 'completed'
        ? evidence.files.length ? `Agent completed with changes in ${evidence.files.length} file${evidence.files.length === 1 ? '' : 's'}.` : 'Agent completed without changing files.'
        : stderr || `Agent exited with code ${state.exitCode ?? 1}.`);
      run = await store.updateAgentRun(projectId, runId, {
        status: state.status, exitCode: state.exitCode ?? (state.status === 'completed' ? 0 : 1), summary,
        files: evidence.files, diffStat: evidence.diffStat, diff: evidence.diff
      });
      const changes = evidence.files.map((file, index) => ({
        id: `agent-${runId}-${index}`, title: file,
        detail: 'Changed in the isolated Vercel Sandbox. Inspect the diff before applying it.', selected: true, runId
      }));
      if (branch) await store.updateBranch(projectId, branch.id, { status: 'review', output: { summary, changes } });
      await store.addAgentRunEvent(projectId, runId, state.status, summary);
      if (branch) await store.createAttentionItem(projectId, {
        branchId: branch.id, runId, kind: state.status === 'completed' && evidence.files.length ? 'review' : state.status === 'failed' ? 'failure' : 'decision',
        severity: state.status === 'failed' ? 'high' : 'normal',
        title: state.status === 'failed' ? `${branch.name} agent run failed` : evidence.files.length ? `${branch.name} is ready for review` : `${branch.name} finished without a diff`,
        detail: summary
      });
      await sandbox.stop().catch(() => {});
      return run;
    } catch (error) {
      await store.addAgentRunEvent(projectId, runId, 'warning', `Sandbox refresh failed: ${error.message}`);
      return store.getAgentRun(projectId, runId);
    }
  }

  async function refresh(projectId, runId) {
    const key = `${projectId}:${runId}`;
    if (!refreshes.has(key)) refreshes.set(key, doRefresh(projectId, runId).finally(() => refreshes.delete(key)));
    return refreshes.get(key);
  }

  async function refreshProject(projectId) {
    const project = await store.getProject(projectId);
    if (!project) return null;
    await Promise.all(project.agentRuns.filter((run) => ACTIVE.has(run.status)).map((run) => refresh(projectId, run.id)));
    return store.getProject(projectId);
  }

  async function control(projectId, runId, action) {
    const run = await store.getAgentRun(projectId, runId);
    if (!run) throw new Error('Agent run not found');
    if (!ACTIVE.has(run.status)) throw new Error('This agent run has already finished');
    if (!run.sandboxName || !run.commandId) throw new Error('The sandbox command is not attached to this run');
    const sandbox = await SandboxClass.get({ name: run.sandboxName, resume: true });
    const command = await sandbox.getCommand(run.commandId);
    if (action === 'pause') {
      if (run.status !== 'running') throw new Error('Only a running agent can be paused');
      await command.kill('SIGSTOP');
      await store.addAgentRunEvent(projectId, runId, 'paused', 'Run paused by the user.');
      return store.updateAgentRun(projectId, runId, { status: 'paused' });
    }
    if (action === 'resume') {
      if (run.status !== 'paused') throw new Error('Only a paused agent can be resumed');
      await command.kill('SIGCONT');
      await store.addAgentRunEvent(projectId, runId, 'resumed', 'Run resumed by the user.');
      return store.updateAgentRun(projectId, runId, { status: 'running' });
    }
    if (action === 'cancel') {
      await command.kill('SIGTERM');
      await store.addAgentRunEvent(projectId, runId, 'cancelled', 'Run cancelled by the user.');
      const updated = await store.updateAgentRun(projectId, runId, { status: 'cancelled', summary: 'Run cancelled by the user.', exitCode: 143 });
      await sandbox.stop().catch(() => {});
      return updated;
    }
    throw new Error('Action must be pause, resume, or cancel');
  }

  return { adapterInfo, start, refresh, refreshProject, control, shutdown: () => {} };
}
