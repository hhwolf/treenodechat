import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { parseGitHubRepository } from './github-repository.js';
import { detectVerifyCommand } from './repository.js';
import { commitDocumentToGitHub, formatRulesSection } from './documents.js';

const ACTIVE = new Set(['queued', 'running', 'paused']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_TASK_CHARS = 4_000;
const MAX_DIFF_CHARS = 100_000;
const MAX_PATCH_CHARS = 5_000_000;
const MAX_UNTRACKED_PATCH_FILES = 200;
const DEFAULT_TIMEOUT = 40 * 60 * 1_000;
const INTEGRATION_TIMEOUT = 10 * 60 * 1_000;
const VERIFY_TIMEOUT = 15 * 60 * 1_000;
const refreshes = new Map();

function integrationError(message, status = 422, details) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

function slug(value) {
  return String(value || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
}

// git apply --include patterns are fnmatch globs; escape metacharacters so
// literal file names like api/[slug].js match instead of being skipped.
function globEscape(value) {
  return String(value).replace(/[[\]*?\\]/g, '\\$&');
}

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1_000
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.includes('\\')
    && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

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
  const rules = formatRulesSection(project.documents, 4_000);
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
${rules ? `\n${rules}\n` : ''}
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

// The sandbox clones the repository into a directory named after it, so the
// checkout is not `sandbox.cwd` itself. Resolve the real repository root.
async function resolveRepoDir(sandbox, repoName) {
  const candidates = [...new Set([`${sandbox.cwd}/${repoName}`, sandbox.cwd, '/vercel/sandbox'])];
  for (const candidate of candidates) {
    const result = await commandText(sandbox, 'git', ['-C', candidate, 'rev-parse', '--show-toplevel'], sandbox.cwd);
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error('Could not locate the repository checkout inside the sandbox');
}

async function summarizeSandbox(sandbox, baseCommit, cwd = sandbox.cwd) {
  const status = await commandText(sandbox, 'git', ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'], cwd);
  const entries = status.stdout.split('\0').filter(Boolean);
  const files = [...new Set(entries.map((entry) => entry.slice(3)).filter(Boolean))].slice(0, 100);
  const untracked = entries.filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3)).slice(0, 30);
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

// Git binary patches are base85 text, so the full-fidelity patch survives the
// sandbox as a string. It is the only durable record once the sandbox expires.
async function collectSandboxPatch(sandbox, baseCommit, cwd) {
  const tracked = await commandText(sandbox, 'git', ['diff', '--binary', '--full-index', '--no-renames', baseCommit], cwd);
  if (tracked.exitCode !== 0) throw new Error(tracked.stderr.trim() || 'Could not capture the run patch');
  const untracked = await commandText(sandbox, 'git', ['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  const chunks = tracked.stdout.trim() ? [tracked.stdout] : [];
  for (const file of untracked.stdout.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_PATCH_FILES)) {
    const created = await commandText(sandbox, 'git', ['diff', '--no-index', '--binary', '--full-index', '--', '/dev/null', file], cwd);
    if (created.exitCode !== 0 && created.exitCode !== 1) throw new Error(created.stderr.trim() || `Could not capture ${file}`);
    if (created.stdout.trim()) chunks.push(created.stdout);
  }
  if (!chunks.length) return '';
  const patch = chunks.map((chunk) => chunk.endsWith('\n') ? chunk : `${chunk}\n`).join('');
  if (patch.length > MAX_PATCH_CHARS) return null;
  return patch;
}

export function createSandboxRuntime(store, options = {}) {
  const openAIKey = Object.hasOwn(options, 'openAIKey') ? options.openAIKey : process.env.OPENAI_API_KEY;
  const githubToken = Object.hasOwn(options, 'githubToken') ? options.githubToken : process.env.GITHUB_TOKEN;
  const model = options.model || process.env.OPENAI_MODEL || 'gpt-5.6-sol';
  const timeout = Number(options.timeout || process.env.THREADLINE_SANDBOX_TIMEOUT || DEFAULT_TIMEOUT);
  const SandboxClass = options.SandboxClass || Sandbox;
  const fetchImpl = options.fetchImpl || fetch;

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
      supportsIntegration: Boolean(githubToken)
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
      const repoDir = await resolveRepoDir(sandbox, parsed.repo);
      if (project.integration?.headCommit) {
        const head = project.integration.headCommit;
        if (project.integration.branchName) await commandText(sandbox, 'git', ['fetch', 'origin', project.integration.branchName], repoDir);
        let checkout = await commandText(sandbox, 'git', ['checkout', '--detach', head], repoDir);
        if (checkout.exitCode !== 0) {
          await commandText(sandbox, 'git', ['fetch', 'origin', head], repoDir);
          checkout = await commandText(sandbox, 'git', ['checkout', '--detach', head], repoDir);
        }
        if (checkout.exitCode !== 0) throw new Error(`Could not start from the accepted integration commit ${head.slice(0, 8)}`);
        await store.addAgentRunEvent(projectId, runId, 'worktree', `Starting from accepted integration commit ${head.slice(0, 8)} on ${project.integration.branchName}.`);
      }
      const base = await commandText(sandbox, 'git', ['rev-parse', 'HEAD'], repoDir);
      if (base.exitCode !== 0) throw new Error(base.stderr.trim() || 'Sandbox repository checkout failed');
      const sanitizedRemote = await commandText(sandbox, 'git', ['remote', 'set-url', 'origin', `${parsed.root}.git`], repoDir);
      if (sanitizedRemote.exitCode !== 0) throw new Error(sanitizedRemote.stderr.trim() || 'Could not sanitize the sandbox Git remote');
      const codex = await commandText(sandbox, 'codex', ['--version'], repoDir);
      if (codex.exitCode !== 0) {
        const install = await commandText(sandbox, 'npm', ['install', '--global', '@openai/codex'], repoDir);
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
        cmd: 'bash', args: ['/vercel/threadline/run.sh'], cwd: repoDir, detached: true,
        env: { OPENAI_API_KEY: openAIKey, THREADLINE_MODEL: model, THREADLINE_REPO: repoDir, NO_COLOR: '1' }
      });
      run = await store.updateAgentRun(projectId, runId, {
        status: 'running', baseCommit: base.stdout.trim(), sandboxName: sandbox.name, commandId: command.cmdId,
        sessionId: sandbox.name, worktreePath: repoDir
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
      const repoDir = run.worktreePath || sandbox.cwd;
      const evidence = await summarizeSandbox(sandbox, run.baseCommit || 'HEAD', repoDir);
      if (state.status === 'completed' && evidence.files.length && run.baseCommit && store.saveAgentRunPatch) {
        try {
          const patch = await collectSandboxPatch(sandbox, run.baseCommit, repoDir);
          if (patch === null) await store.addAgentRunEvent(projectId, runId, 'warning', 'Run patch is too large to store; this run stays review-only.');
          else if (patch) await store.saveAgentRunPatch(projectId, runId, patch);
        } catch (error) {
          await store.addAgentRunEvent(projectId, runId, 'warning', `Could not capture the run patch: ${error.message}`);
        }
      }
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
    await Promise.all(project.agentRuns.flatMap((run) => [
      ...(ACTIVE.has(run.status) ? [refresh(projectId, run.id)] : []),
      ...(run.verification?.status === 'running' ? [refreshVerification(projectId, run.id)] : [])
    ]));
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

  async function integrate(projectId, runId, input = {}) {
    const project = await store.getProject(projectId);
    const run = await store.getAgentRun(projectId, runId);
    if (!project || !run) throw integrationError('Agent run not found', 404);
    if (run.integration?.commit) return { project, run, integration: run.integration };
    if (run.status !== 'completed') throw integrationError('Only a completed agent run can be integrated');
    if (!githubToken) throw integrationError('Configure GITHUB_TOKEN with write access to integrate hosted runs');
    if (!run.baseCommit) throw integrationError('This run has no recorded base commit');
    const patch = store.getAgentRunPatch ? await store.getAgentRunPatch(projectId, runId) : null;
    if (!patch) throw integrationError('No stored patch is available for this run; start a new run to integrate its changes');
    const selectedFiles = [...new Set(Array.isArray(input.filePaths) ? input.filePaths : [])];
    if (!selectedFiles.length) throw integrationError('Select at least one changed file');
    if (selectedFiles.some((file) => !safeRelativePath(file))) throw integrationError('Selected files must be safe repository-relative paths');
    const known = new Set(run.files || []);
    if (selectedFiles.some((file) => !known.has(file))) throw integrationError('Selected files no longer match the agent run');
    const branch = project.branches.find((item) => item.id === run.branchId);
    const commitMessage = String(input.commitMessage || `Threadline: accept ${branch?.name || 'agent run'}`).trim().slice(0, 200);
    if (!commitMessage) throw integrationError('Commit message is required');

    const parsed = parseGitHubRepository(project.repoPath);
    const branchName = project.integration?.branchName || `threadline/${slug(project.name)}-${project.id.slice(0, 6)}`;
    const scrub = (text) => String(text || '').replaceAll(githubToken, '***');
    let sandbox;
    try {
      sandbox = await SandboxClass.create({
        name: `tl-int-${randomUUID().slice(0, 8)}`,
        source: { type: 'git', url: `${parsed.root}.git`, depth: 50, username: 'x-access-token', password: githubToken },
        timeout: INTEGRATION_TIMEOUT,
        tags: { product: 'threadline', run: runId.slice(0, 8) }
      });
      const repoDir = await resolveRepoDir(sandbox, parsed.repo);
      const git = (args) => commandText(sandbox, 'git', args, repoDir);
      const hasBase = await git(['cat-file', '-e', `${run.baseCommit}^{commit}`]);
      if (hasBase.exitCode !== 0) {
        const fetched = await git(['fetch', 'origin', run.baseCommit]);
        if (fetched.exitCode !== 0) throw integrationError(`Could not fetch the run base commit ${run.baseCommit.slice(0, 8)} from GitHub`);
      }
      const remoteBranch = await git(['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`]);
      const checkout = await git(remoteBranch.exitCode === 0
        ? ['checkout', '-B', branchName, `refs/remotes/origin/${branchName}`]
        : ['checkout', '-B', branchName, run.baseCommit]);
      if (checkout.exitCode !== 0) throw integrationError(scrub(checkout.stderr.trim()) || 'Could not prepare the integration branch');
      await sandbox.mkDir('/vercel/threadline');
      await sandbox.writeFiles([{ path: '/vercel/threadline/patch.diff', content: Buffer.from(patch) }]);
      const applied = await git(['apply', '--3way', '--index', '--binary', ...selectedFiles.map((file) => `--include=${globEscape(file)}`), '/vercel/threadline/patch.diff']);
      if (applied.exitCode !== 0) {
        const conflicted = await git(['diff', '--name-only', '--diff-filter=U']);
        const conflicts = conflicted.stdout.split('\n').filter(Boolean);
        await store.addAgentRunEvent(projectId, runId, 'conflict', conflicts.length ? `Integration conflicts in ${conflicts.join(', ')}.` : 'The selected patch could not be applied to the latest project branch.');
        throw integrationError('Selected changes conflict with the latest project branch', 409, { conflicts });
      }
      const staged = await git(['diff', '--cached', '--quiet']);
      if (staged.exitCode === 0) throw integrationError('Selected changes are already present on the project branch');
      const committed = await git(['-c', 'user.name=Threadline', '-c', 'user.email=threadline@cloud', 'commit', '-m', commitMessage]);
      if (committed.exitCode !== 0) throw integrationError(scrub(committed.stderr.trim()) || 'Could not commit the integrated changes');
      const authRemote = await git(['remote', 'set-url', 'origin', `https://x-access-token:${githubToken}@github.com/${parsed.owner}/${parsed.repo}.git`]);
      if (authRemote.exitCode !== 0) throw integrationError('Could not prepare the authenticated push remote');
      const pushed = await git(['push', 'origin', `${branchName}:refs/heads/${branchName}`]);
      if (pushed.exitCode !== 0) throw integrationError(`Could not push ${branchName} to GitHub: ${scrub(pushed.stderr.trim()).split('\n').filter(Boolean).pop() || 'push failed'}`);
      const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      const integratedAt = new Date().toISOString();
      const integration = { branchName, commit, files: selectedFiles, integratedAt, pushed: true, remote: parsed.root };
      await store.updateAgentRun(projectId, runId, { integration });
      await store.addAgentRunEvent(projectId, runId, 'integrated', `Integrated ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} as ${commit.slice(0, 8)} and pushed ${branchName} to GitHub.`);
      if (store.updateProjectIntegration) await store.updateProjectIntegration(projectId, { branchName, headCommit: commit, remote: parsed.root, updatedAt: integratedAt });
      return { project: await store.getProject(projectId), run: await store.getAgentRun(projectId, runId), integration };
    } finally {
      await sandbox?.stop?.().catch(() => {});
    }
  }

  async function commitDocument(projectId, docId, input = {}) {
    const project = await store.getProject(projectId);
    const document = project?.documents?.find((item) => item.id === docId);
    if (!project || !document) throw integrationError('Document not found', 404);
    if (!project.repoPath) throw integrationError('Connect a GitHub repository before committing rules');
    const result = await commitDocumentToGitHub(project, document, { token: githubToken, message: input.message, fetchImpl });
    const committedAt = new Date().toISOString();
    await store.updateDocument(projectId, docId, { committedAt, committedSha: result.contentSha || result.commitSha, committedBranch: result.branch });
    if (result.commitSha && store.updateProjectIntegration) {
      await store.updateProjectIntegration(projectId, {
        ...(project.integration || {}),
        branchName: result.branch, headCommit: result.commitSha, remote: parseGitHubRepository(project.repoPath).root, updatedAt: committedAt
      });
    }
    return { project: await store.getProject(projectId), commit: { sha: result.commitSha, branch: result.branch, path: result.path } };
  }

  async function startVerificationSandbox(project, run) {
    if (run.sandboxName) {
      try {
        const sandbox = await SandboxClass.get({ name: run.sandboxName, resume: true });
        const probe = await commandText(sandbox, 'git', ['-C', run.worktreePath, 'rev-parse', 'HEAD'], sandbox.cwd);
        if (probe.exitCode === 0) return { sandbox, repoDir: run.worktreePath, mode: 'resumed' };
        await sandbox.stop?.().catch(() => {});
      } catch { /* The run sandbox has expired; recreate it below. */ }
    }
    if (!run.baseCommit) throw integrationError('This run has no recorded base commit');
    const parsed = parseGitHubRepository(project.repoPath);
    const sandbox = await SandboxClass.create({
      name: `tl-ver-${randomUUID().slice(0, 8)}`,
      source: { type: 'git', url: `${parsed.root}.git`, depth: 50, ...(githubToken ? { username: 'x-access-token', password: githubToken } : {}) },
      timeout: Number(process.env.THREADLINE_VERIFY_TIMEOUT || VERIFY_TIMEOUT),
      tags: { product: 'threadline', run: run.id.slice(0, 8) }
    });
    try {
      const repoDir = await resolveRepoDir(sandbox, parsed.repo);
      const hasBase = await commandText(sandbox, 'git', ['cat-file', '-e', `${run.baseCommit}^{commit}`], repoDir);
      if (hasBase.exitCode !== 0) {
        const fetched = await commandText(sandbox, 'git', ['fetch', 'origin', run.baseCommit], repoDir);
        if (fetched.exitCode !== 0) throw integrationError(`Could not fetch the run base commit ${run.baseCommit.slice(0, 8)} from GitHub`);
      }
      const checkout = await commandText(sandbox, 'git', ['checkout', '--detach', run.baseCommit], repoDir);
      if (checkout.exitCode !== 0) throw integrationError(checkout.stderr.trim() || 'Could not check out the run base commit');
      if (run.files?.length) {
        const patch = store.getAgentRunPatch ? await store.getAgentRunPatch(project.id, run.id) : null;
        if (!patch) throw integrationError('No stored patch is available for this run; start a new run to verify its changes');
        await sandbox.mkDir('/vercel/threadline');
        await sandbox.writeFiles([{ path: '/vercel/threadline/patch.diff', content: Buffer.from(patch) }]);
        const applied = await commandText(sandbox, 'git', ['apply', '--3way', '--index', '--binary', '/vercel/threadline/patch.diff'], repoDir);
        if (applied.exitCode !== 0) throw integrationError('Could not reapply the run changes for verification');
      }
      return { sandbox, repoDir, mode: 'recreated' };
    } catch (error) {
      await sandbox.stop?.().catch(() => {});
      throw error;
    }
  }

  async function verify(projectId, runId, input = {}) {
    const project = await store.getProject(projectId);
    const run = await store.getAgentRun(projectId, runId);
    if (!project || !run) throw integrationError('Agent run not found', 404);
    if (run.status !== 'completed') throw integrationError('Only a completed agent run can be verified');
    if (run.verification?.status === 'running') throw integrationError('A verification is already running for this run');
    const command = String(input.command || project.verifyCommand || detectVerifyCommand(project.repository)).trim().slice(0, 400);
    if (!command) throw integrationError('Add a test script to package.json or set a verify command for this project');
    const { sandbox, repoDir, mode } = await startVerificationSandbox(project, run);
    try {
      const allow = ['registry.npmjs.org', ...(process.env.THREADLINE_VERIFY_ALLOW || '').split(',').map((host) => host.trim()).filter(Boolean)];
      await sandbox.updateNetworkPolicy({ allow });
      const runner = `#!/usr/bin/env bash
set +e
cd "$THREADLINE_REPO"
start=$(date +%s)
if [ -f package-lock.json ] && [ ! -d node_modules ]; then
  echo '[threadline] installing dependencies with npm ci' >> /vercel/threadline/verify.log
  npm ci --no-audit --no-fund >> /vercel/threadline/verify.log 2>&1
fi
echo "[threadline] $THREADLINE_VERIFY_CMD" >> /vercel/threadline/verify.log
bash -c "$THREADLINE_VERIFY_CMD" >> /vercel/threadline/verify.log 2>&1
code=$?
end=$(date +%s)
if [ "$code" -eq 0 ]; then state=passed; else state=failed; fi
printf '{"status":"%s","exitCode":%s,"durationMs":%s}' "$state" "$code" "$(((end-start)*1000))" > /vercel/threadline/verify-status.json
exit "$code"
`;
      await sandbox.mkDir('/vercel/threadline');
      await sandbox.writeFiles([
        { path: '/vercel/threadline/verify.sh', content: Buffer.from(runner) },
        { path: '/vercel/threadline/verify.log', content: Buffer.from('') },
        { path: '/vercel/threadline/verify-status.json', content: Buffer.from('{"status":"running"}') }
      ]);
      const started = await sandbox.runCommand({
        cmd: 'bash', args: ['/vercel/threadline/verify.sh'], cwd: repoDir, detached: true,
        env: { THREADLINE_REPO: repoDir, THREADLINE_VERIFY_CMD: command, NO_COLOR: '1', CI: '1' }
      });
      await store.updateAgentRun(projectId, runId, {
        verification: {
          command, status: 'running', mode, startedAt: new Date().toISOString(),
          sandboxName: sandbox.name, commandId: started.cmdId, logCursor: 0
        }
      });
      await store.addAgentRunEvent(projectId, runId, 'verify', mode === 'resumed'
        ? `Verification started in the run sandbox: ${command}`
        : `Verification started in a fresh sandbox from ${run.baseCommit.slice(0, 8)} with the run changes applied: ${command}`);
      return store.getAgentRun(projectId, runId);
    } catch (error) {
      await sandbox.stop?.().catch(() => {});
      throw error;
    }
  }

  async function doRefreshVerification(projectId, runId) {
    let run = await store.getAgentRun(projectId, runId);
    const verification = run?.verification;
    if (!verification || verification.status !== 'running' || !verification.sandboxName) return run;
    try {
      const sandbox = await SandboxClass.get({ name: verification.sandboxName, resume: true });
      const log = await readText(sandbox, '/vercel/threadline/verify.log');
      const cursor = Number(verification.logCursor) || 0;
      const fresh = log.slice(cursor).trim();
      if (fresh) {
        await store.addAgentRunEvent(projectId, runId, 'verify', fresh.slice(-4_000));
        run = await store.updateAgentRun(projectId, runId, { verification: { ...verification, logCursor: log.length, pollFailures: 0 } });
      }
      let state = {};
      try { state = JSON.parse(await readText(sandbox, '/vercel/threadline/verify-status.json', 2_000) || '{}'); } catch { /* A partial write is retried on the next poll. */ }
      if (state.status !== 'passed' && state.status !== 'failed') return run;
      const final = {
        ...run.verification,
        status: state.status,
        exitCode: state.exitCode ?? (state.status === 'passed' ? 0 : 1),
        durationMs: Number(state.durationMs) || 0,
        endedAt: new Date().toISOString()
      };
      run = await store.updateAgentRun(projectId, runId, { verification: final });
      await store.addAgentRunEvent(projectId, runId, 'verify', `Verification ${state.status}${final.durationMs ? ` in ${Math.round(final.durationMs / 1000)}s` : ''}: ${final.command}`);
      if (state.status === 'failed') {
        const project = await store.getProject(projectId);
        const branch = project?.branches.find((item) => item.id === run.branchId);
        if (branch) await store.createAttentionItem(projectId, {
          branchId: branch.id, runId, kind: 'failure', severity: 'high',
          title: `${branch.name} verification failed`,
          detail: `${final.command} exited with code ${final.exitCode}. Review the verify output on the run.`
        });
      }
      await sandbox.stop().catch(() => {});
      return run;
    } catch (error) {
      const current = (await store.getAgentRun(projectId, runId))?.verification;
      if (!current || current.status !== 'running') return store.getAgentRun(projectId, runId);
      const pollFailures = (current.pollFailures || 0) + 1;
      if (pollFailures < 3) return store.updateAgentRun(projectId, runId, { verification: { ...current, pollFailures } });
      await store.addAgentRunEvent(projectId, runId, 'warning', `Verification stopped: ${error.message}`);
      return store.updateAgentRun(projectId, runId, { verification: { ...current, status: 'error', endedAt: new Date().toISOString() } });
    }
  }

  async function refreshVerification(projectId, runId) {
    const key = `verify:${projectId}:${runId}`;
    if (!refreshes.has(key)) refreshes.set(key, doRefreshVerification(projectId, runId).finally(() => refreshes.delete(key)));
    return refreshes.get(key);
  }

  return { adapterInfo, start, refresh, refreshProject, control, integrate, verify, commitDocument, shutdown: () => {} };
}
