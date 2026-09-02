import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { detectVerifyCommand, inspectRepository } from './repository.js';

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const activeStatuses = new Set(['queued', 'running', 'paused']);
const MAX_TASK_CHARS = 4_000;
const MAX_DIFF_CHARS = 100_000;
const AGENT_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TERM_PROGRAM',
  'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'
];

export function buildAgentEnvironment(environment = process.env) {
  const safe = { NO_COLOR: '1', THREADLINE_AGENT_RUN: '1' };
  for (const name of AGENT_ENV_ALLOWLIST) {
    if (typeof environment[name] === 'string' && environment[name]) safe[name] = environment[name];
  }
  return safe;
}

function git(root, args, { timeout = 20_000 } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4_000_000
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trimEnd();
}

function gitResult(root, args, { timeout = 20_000, input, encoding = 'utf8', env } = {}) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding,
    input,
    env: env ? { ...process.env, ...env } : process.env,
    timeout,
    maxBuffer: 16_000_000
  });
}

function nulList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function changedFiles(worktreePath, baseCommit) {
  const tracked = gitResult(worktreePath, ['diff', '--name-only', '-z', '--no-renames', baseCommit], { encoding: null });
  if (tracked.status !== 0) throw new Error(tracked.stderr.toString('utf8').trim() || 'Could not list changed files');
  const untracked = gitResult(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: null });
  if (untracked.status !== 0) throw new Error(untracked.stderr.toString('utf8').trim() || 'Could not list new files');
  return [...new Set([...nulList(tracked.stdout), ...nulList(untracked.stdout)])].sort();
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

function slug(value) {
  return String(value || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
}

function integrationError(message, status = 422, details) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

function createSelectedPatch(worktreePath, baseCommit, selectedFiles) {
  const tracked = gitResult(worktreePath, ['diff', '--binary', '--full-index', '--no-renames', baseCommit, '--', ...selectedFiles], { encoding: null, timeout: 60_000 });
  if (tracked.status !== 0) throw integrationError(tracked.stderr.toString('utf8').trim() || 'Could not prepare the selected patch');
  const untracked = new Set(nulList(gitResult(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: null }).stdout));
  const chunks = tracked.stdout.length ? [tracked.stdout] : [];
  for (const file of selectedFiles.filter((item) => untracked.has(item))) {
    const created = gitResult(worktreePath, ['diff', '--no-index', '--binary', '--', '/dev/null', file], { encoding: null, timeout: 60_000 });
    if (created.status !== 0 && created.status !== 1) throw integrationError(created.stderr.toString('utf8').trim() || `Could not prepare ${file}`);
    if (created.stdout.length) chunks.push(created.stdout);
  }
  if (!chunks.length) return Buffer.alloc(0);
  return Buffer.concat(chunks.map((chunk) => Buffer.concat([chunk, Buffer.from('\n')])));
}

export function prepareGitWorktree(repoPath, worktreePath, baseRef = 'HEAD') {
  const root = git(repoPath, ['rev-parse', '--show-toplevel']);
  const baseCommit = git(root, ['rev-parse', baseRef]);
  mkdirSync(dirname(worktreePath), { recursive: true });
  git(root, ['worktree', 'add', '--detach', worktreePath, baseCommit], { timeout: 60_000 });
  return { root, baseCommit };
}

export function summarizeGitWorktree(worktreePath, baseCommit) {
  if (!worktreePath || !baseCommit || !existsSync(worktreePath)) return { files: [], diffStat: '', diff: '' };
  const files = changedFiles(worktreePath, baseCommit).slice(0, 100);
  const untrackedFiles = nulList(gitResult(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: null }).stdout).slice(0, 100);
  const trackedStat = git(worktreePath, ['diff', '--stat', baseCommit]);
  const diffStat = [trackedStat, ...untrackedFiles.map((file) => `${file} | new file`)].filter(Boolean).join('\n').slice(0, 8_000);
  const trackedDiff = git(worktreePath, ['diff', '--no-color', '--unified=3', baseCommit]);
  const untrackedDiff = untrackedFiles.map((file) => {
    const result = spawnSync('git', ['-C', worktreePath, 'diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', file], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 4_000_000
    });
    return result.status === 0 || result.status === 1 ? result.stdout.trimEnd() : '';
  });
  const diff = [trackedDiff, ...untrackedDiff].filter(Boolean).join('\n\n').slice(0, MAX_DIFF_CHARS);
  return { files, diffStat, diff };
}

function buildAgentPrompt(project, branch, contexts, task) {
  const sharedContext = contexts.map((item) => `- ${item.label}: ${item.value}`).join('\n') || '- No additional shared context.';
  return `You are a coding agent working in an isolated Git worktree managed by Threadline.

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
- Work only inside the current isolated worktree.
- Do not push, change Git remotes, or modify Git configuration.
- Do not read secret-like files or seek private context.
- Do not commit. Leave changes in the worktree for human review.
- Run the smallest relevant verification available locally.
- If blocked, explain the blocker and stop instead of guessing.
- Finish with a concise summary of files changed, tests run, and remaining risk.`;
}

function readableEvent(payload) {
  const type = payload.type || payload.event || payload.item?.type || 'progress';
  const text = payload.message || payload.text || payload.delta || payload.item?.text || payload.item?.content?.[0]?.text;
  if (typeof text === 'string' && text.trim()) return { kind: type, message: text.trim() };
  const command = payload.command || payload.item?.command;
  if (typeof command === 'string') return { kind: type, message: `Command: ${command}` };
  return { kind: type, message: String(type).replaceAll('.', ' ') };
}

export function createAgentRuntime(store, options = {}) {
  const adapter = options.adapter || process.env.THREADLINE_AGENT_ADAPTER || 'codex';
  const command = options.command || 'codex';
  const stateRoot = options.stateRoot || join(process.cwd(), '.threadline');
  const spawnProcess = options.spawnProcess || spawn;
  const checkProcess = options.checkProcess || spawnSync;
  const prepareWorktree = options.prepareWorktree || prepareGitWorktree;
  const summarizeWorktree = options.summarizeWorktree || summarizeGitWorktree;
  const repositoryInspector = options.repositoryInspector || inspectRepository;
  const active = new Map();
  let cachedInfo;

  function signalProcess(entry, signal) {
    if (!entry?.child?.pid) return false;
    if (entry.grouped) {
      try { process.kill(-entry.child.pid, signal); return true; } catch { /* Fall back to the direct child below. */ }
    }
    return entry.child.kill(signal);
  }

  function adapterInfo() {
    if (cachedInfo) return cachedInfo;
    if (adapter === 'demo') {
      cachedInfo = { id: 'demo', name: 'Demo agent', available: true, version: 'local', safety: 'isolated-worktree', supportsIntegration: true };
      return cachedInfo;
    }
    const result = checkProcess(command, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    cachedInfo = {
      id: 'codex',
      name: 'Codex CLI',
      available: result.status === 0,
      version: result.status === 0 ? result.stdout.trim() : '',
      error: result.status === 0 ? '' : (result.stderr?.trim() || 'Codex CLI is not available'),
      safety: 'workspace-write',
      supportsIntegration: true
    };
    return cachedInfo;
  }

  function failRun(project, branch, run, error) {
    if (terminalStatuses.has(store.getAgentRun(project.id, run.id)?.status)) return;
    const message = error instanceof Error ? error.message : String(error);
    store.addAgentRunEvent(project.id, run.id, 'failed', message);
    store.updateAgentRun(project.id, run.id, { status: 'failed', summary: message, pid: null });
    store.updateBranch(project.id, branch.id, {
      status: 'review',
      output: { summary: `Agent run failed: ${message}`, changes: [] }
    });
    store.createAttentionItem(project.id, {
      branchId: branch.id,
      runId: run.id,
      kind: 'failure',
      severity: 'high',
      title: `${branch.name} needs intervention`,
      detail: message
    });
    active.delete(run.id);
  }

  function finishRun(project, branch, run, { exitCode = 0, cancelled = false, finalMessage = '' } = {}) {
    const current = store.getAgentRun(project.id, run.id);
    if (!current || terminalStatuses.has(current.status)) return current;
    let evidence = { files: [], diffStat: '', diff: '' };
    try { evidence = summarizeWorktree(current.worktreePath, current.baseCommit); } catch (error) {
      store.addAgentRunEvent(project.id, run.id, 'warning', `Could not summarize worktree: ${error.message}`);
    }
    const status = cancelled ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed';
    const summary = finalMessage.trim() || (status === 'completed'
      ? evidence.files.length ? `Agent completed with changes in ${evidence.files.length} file${evidence.files.length === 1 ? '' : 's'}.` : 'Agent completed without changing files.'
      : status === 'cancelled' ? 'Run cancelled by the user.' : `Agent exited with code ${exitCode}.`);
    store.updateAgentRun(project.id, run.id, {
      status,
      exitCode,
      summary,
      files: evidence.files,
      diffStat: evidence.diffStat,
      diff: evidence.diff,
      pid: null
    });
    store.addAgentRunEvent(project.id, run.id, status, summary);
    const changes = evidence.files.map((file, index) => ({
      id: `agent-${run.id}-${index}`,
      title: file,
      detail: 'Changed in the isolated agent worktree. Inspect the diff before applying it.',
      selected: true,
      runId: run.id
    }));
    store.updateBranch(project.id, branch.id, { status: 'review', output: { summary, changes } });
    if (status === 'completed') {
      store.createAttentionItem(project.id, {
        branchId: branch.id,
        runId: run.id,
        kind: evidence.files.length ? 'review' : 'decision',
        title: evidence.files.length ? `${branch.name} is ready for review` : `${branch.name} finished without a diff`,
        detail: evidence.files.length ? `${evidence.files.length} changed file${evidence.files.length === 1 ? '' : 's'} in ${current.worktreePath}` : 'Review the final agent summary and decide whether to retry or close the branch.'
      });
    } else if (status === 'failed') {
      store.createAttentionItem(project.id, {
        branchId: branch.id,
        runId: run.id,
        kind: 'failure',
        severity: 'high',
        title: `${branch.name} agent run failed`,
        detail: summary
      });
    }
    active.delete(run.id);
    return store.getAgentRun(project.id, run.id);
  }

  function runDemo(project, branch, run) {
    const steps = [
      ['analysis', 'Inspecting the assigned branch and shared context.'],
      ['command', 'Checking the smallest relevant code surface.'],
      ['verification', 'Recording a reviewable demonstration change.']
    ];
    const entry = { kind: 'demo', paused: false, cancelled: false, timer: null };
    active.set(run.id, entry);
    let index = 0;
    const tick = () => {
      if (entry.cancelled) return finishRun(project, branch, run, { cancelled: true, exitCode: 143 });
      if (entry.paused) { entry.timer = setTimeout(tick, 150); return; }
      const step = steps[index++];
      if (step) {
        store.addAgentRunEvent(project.id, run.id, step[0], step[1]);
        entry.timer = setTimeout(tick, 220);
        return;
      }
      writeFileSync(join(run.worktreePath, 'threadline-agent-demo.md'), `# Agent run\n\nBranch: ${branch.name}\n\nTask: ${run.task}\n`);
      finishRun(project, branch, run, { finalMessage: 'Demo agent completed an isolated change and left it ready for review.' });
    };
    tick();
  }

  function runCodex(project, branch, contexts, run) {
    const runState = join(stateRoot, 'runs', run.id);
    mkdirSync(runState, { recursive: true });
    const lastMessagePath = join(runState, 'last-message.txt');
    const args = ['exec', '--json', '--sandbox', 'workspace-write', '--output-last-message', lastMessagePath, '-C', run.worktreePath];
    if (process.env.CODEX_AGENT_MODEL) args.push('--model', process.env.CODEX_AGENT_MODEL);
    args.push('-');
    const grouped = process.platform !== 'win32';
    const child = spawnProcess(command, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: grouped, env: buildAgentEnvironment() });
    const entry = { kind: 'process', child, grouped, cancelled: false, settled: false, cancelTimer: null };
    active.set(run.id, entry);
    store.updateAgentRun(project.id, run.id, { status: 'running', pid: child.pid });
    store.addAgentRunEvent(project.id, run.id, 'started', `Codex started in ${run.worktreePath}.`);

    let latestMessage = '';
    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const payload = JSON.parse(line);
        const event = readableEvent(payload);
        if (/agent_message|message|completed/i.test(event.kind) && event.message) latestMessage = event.message;
        const sessionId = payload.thread_id || payload.threadId || payload.session_id;
        if (sessionId) store.updateAgentRun(project.id, run.id, { sessionId });
        store.addAgentRunEvent(project.id, run.id, event.kind, event.message, { type: payload.type, itemType: payload.item?.type });
      } catch {
        store.addAgentRunEvent(project.id, run.id, 'output', line);
      }
    });
    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', (line) => line.trim() && store.addAgentRunEvent(project.id, run.id, 'stderr', line));
    child.once('error', (error) => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.cancelTimer) clearTimeout(entry.cancelTimer);
      failRun(project, branch, run, error);
    });
    child.once('close', (code) => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.cancelTimer) clearTimeout(entry.cancelTimer);
      let finalMessage = latestMessage;
      try { if (existsSync(lastMessagePath)) finalMessage = readFileSync(lastMessagePath, 'utf8'); } catch { /* Event output remains the fallback. */ }
      finishRun(project, branch, run, { exitCode: code ?? 1, cancelled: entry.cancelled, finalMessage });
    });
    child.stdin.end(buildAgentPrompt(project, branch, contexts, run.task));
  }

  async function execute(project, branch, contexts, run) {
    try {
      const prepared = prepareWorktree(project.repoPath, run.worktreePath, project.integration?.headCommit || 'HEAD');
      run = store.updateAgentRun(project.id, run.id, { status: 'running', baseCommit: prepared.baseCommit, worktreePath: run.worktreePath });
      store.addAgentRunEvent(project.id, run.id, 'worktree', `Created isolated worktree from ${prepared.baseCommit.slice(0, 8)}.`);
      if (adapter === 'demo') runDemo(project, branch, run);
      else runCodex(project, branch, contexts, run);
    } catch (error) {
      failRun(project, branch, run, error);
    }
  }

  function start(projectId, branchId, task) {
    const value = String(task || '').trim();
    if (!value) throw new Error('Describe what the agent should accomplish');
    if (value.length > MAX_TASK_CHARS) throw new Error(`Agent task must be ${MAX_TASK_CHARS} characters or fewer`);
    const project = store.getProject(projectId);
    const branch = project?.branches.find((item) => item.id === branchId);
    if (!project || !branch) throw new Error('Project or branch not found');
    if (!project.repoPath) throw new Error('Connect a Git repository before starting an agent');
    const info = adapterInfo();
    if (!info.available) throw new Error(info.error || `${info.name} is unavailable`);
    const id = randomUUID();
    const worktreePath = join(dirname(project.repoPath), '.threadline-worktrees', basename(project.repoPath), projectId, `${branchId}-${id.slice(0, 8)}`);
    const run = store.createAgentRun(projectId, branchId, { id, adapter: info.id, task: value, worktreePath });
    const contexts = store.inheritedContexts(projectId, branchId);
    queueMicrotask(() => execute(project, branch, contexts, run));
    return run;
  }

  function control(projectId, runId, action) {
    const run = store.getAgentRun(projectId, runId);
    if (!run) throw new Error('Agent run not found');
    if (!activeStatuses.has(run.status)) throw new Error('This agent run has already finished');
    const entry = active.get(runId);
    if (!entry) throw new Error('The agent process is no longer attached to this Threadline session');
    if (action === 'pause') {
      if (run.status !== 'running') throw new Error('Only a running agent can be paused');
      if (entry.kind === 'process') signalProcess(entry, 'SIGSTOP');
      else entry.paused = true;
      store.addAgentRunEvent(projectId, runId, 'paused', 'Run paused by the user.');
      return store.updateAgentRun(projectId, runId, { status: 'paused' });
    }
    if (action === 'resume') {
      if (run.status !== 'paused') throw new Error('Only a paused agent can be resumed');
      if (entry.kind === 'process') signalProcess(entry, 'SIGCONT');
      else entry.paused = false;
      store.addAgentRunEvent(projectId, runId, 'resumed', 'Run resumed by the user.');
      return store.updateAgentRun(projectId, runId, { status: 'running' });
    }
    if (action === 'cancel') {
      entry.cancelled = true;
      store.addAgentRunEvent(projectId, runId, 'cancelling', 'Cancellation requested by the user.');
      if (entry.kind === 'process') {
        signalProcess(entry, 'SIGTERM');
        entry.cancelTimer = setTimeout(() => {
          if (!entry.settled) signalProcess(entry, 'SIGKILL');
        }, 5_000);
      }
      return store.getAgentRun(projectId, runId);
    }
    throw new Error('Action must be pause, resume, or cancel');
  }

  async function integrate(projectId, runId, input = {}) {
    const project = store.getProject(projectId);
    const run = store.getAgentRun(projectId, runId);
    if (!project || !run) throw integrationError('Agent run not found', 404);
    if (run.integration?.commit) return { project, run, integration: run.integration };
    if (run.status !== 'completed') throw integrationError('Only a completed agent run can be integrated');
    if (!run.worktreePath || !run.baseCommit || !existsSync(run.worktreePath)) throw integrationError('The isolated agent worktree is no longer available');

    const selectedFiles = [...new Set(Array.isArray(input.filePaths) ? input.filePaths : [])];
    if (!selectedFiles.length) throw integrationError('Select at least one changed file');
    if (selectedFiles.some((file) => !safeRelativePath(file))) throw integrationError('Selected files must be safe repository-relative paths');
    const currentFiles = changedFiles(run.worktreePath, run.baseCommit);
    const currentSet = new Set(currentFiles);
    if (selectedFiles.some((file) => !currentSet.has(file))) throw integrationError('Selected files no longer match the agent worktree');

    const branchName = project.integration?.branchName || `threadline/${slug(project.name)}-${project.id.slice(0, 6)}`;
    const workspacePath = project.integration?.workspacePath || join(stateRoot, 'projects', project.id, 'workspace');
    const sourceRoot = git(project.repoPath, ['rev-parse', '--show-toplevel']);
    let branchHead = project.integration?.headCommit || '';
    const branchCheck = gitResult(sourceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    if (branchCheck.status !== 0) git(sourceRoot, ['branch', branchName, run.baseCommit]);
    branchHead = git(sourceRoot, ['rev-parse', branchName]);

    if (!existsSync(workspacePath)) {
      mkdirSync(dirname(workspacePath), { recursive: true });
      gitResult(sourceRoot, ['worktree', 'prune']);
      git(sourceRoot, ['worktree', 'add', workspacePath, branchName], { timeout: 60_000 });
    }
    const workspaceRoot = git(workspacePath, ['rev-parse', '--show-toplevel']);
    if (realpathSync(workspaceRoot) !== realpathSync(workspacePath)) throw integrationError('Threadline integration workspace is invalid');
    const workspaceBranch = git(workspacePath, ['branch', '--show-current']);
    if (workspaceBranch !== branchName) throw integrationError('Threadline integration workspace is attached to the wrong branch');
    if (git(workspacePath, ['status', '--porcelain'])) throw integrationError('Threadline integration workspace is not clean');
    const workspaceHead = git(workspacePath, ['rev-parse', 'HEAD']);
    if (workspaceHead !== branchHead) throw integrationError('Threadline integration workspace is out of date');

    if (!project.integration?.branchName) {
      store.updateProjectIntegration(projectId, { branchName, headCommit: branchHead, workspacePath, updatedAt: new Date().toISOString() });
    }

    const patch = createSelectedPatch(run.worktreePath, run.baseCommit, selectedFiles);
    if (!patch.length) throw integrationError('Selected files do not contain an applicable change');
    const applied = gitResult(workspacePath, ['apply', '--3way', '--index', '--binary', '-'], { input: patch, encoding: null, timeout: 60_000 });
    if (applied.status !== 0) {
      const conflicts = git(workspacePath, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      git(workspacePath, ['reset', '--hard', branchHead]);
      git(workspacePath, ['clean', '-fd']);
      store.addAgentRunEvent(projectId, runId, 'conflict', conflicts.length ? `Integration conflicts in ${conflicts.join(', ')}.` : 'The selected patch could not be applied to the latest project branch.');
      throw integrationError('Selected changes conflict with the latest project branch', 409, { conflicts });
    }
    const staged = gitResult(workspacePath, ['diff', '--cached', '--quiet']);
    if (staged.status === 0) throw integrationError('Selected changes are already present on the project branch');
    if (staged.status !== 1) throw integrationError(staged.stderr.trim() || 'Could not verify staged integration changes');

    const branch = project.branches.find((item) => item.id === run.branchId);
    const commitMessage = String(input.commitMessage || `Threadline: accept ${branch?.name || 'agent run'}`).trim().slice(0, 200);
    if (!commitMessage) throw integrationError('Commit message is required');
    const committed = gitResult(workspacePath, ['commit', '-m', commitMessage], {
      timeout: 60_000,
      env: {
        GIT_AUTHOR_NAME: 'Threadline', GIT_AUTHOR_EMAIL: 'threadline@local',
        GIT_COMMITTER_NAME: 'Threadline', GIT_COMMITTER_EMAIL: 'threadline@local'
      }
    });
    if (committed.status !== 0) {
      git(workspacePath, ['reset', '--hard', branchHead]);
      throw integrationError(committed.stderr.trim() || 'Could not commit the integrated changes');
    }
    const commit = git(workspacePath, ['rev-parse', 'HEAD']);
    const integratedAt = new Date().toISOString();
    const integration = { branchName, commit, files: selectedFiles, integratedAt };
    store.updateAgentRun(projectId, runId, { integration });
    store.addAgentRunEvent(projectId, runId, 'integrated', `Integrated ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} as ${commit.slice(0, 8)}.`);
    store.updateProjectIntegration(projectId, { branchName, headCommit: commit, workspacePath, updatedAt: integratedAt });
    const snapshot = await repositoryInspector(workspacePath);
    store.updateRepositorySnapshot(projectId, { ...snapshot, root: project.repoPath, name: basename(project.repoPath), integrationWorkspace: workspacePath }, { preserveRepoPath: true });
    return { project: store.getProject(projectId), run: store.getAgentRun(projectId, runId), integration };
  }

  function verify(projectId, runId, input = {}) {
    const project = store.getProject(projectId);
    const run = store.getAgentRun(projectId, runId);
    if (!project || !run) throw integrationError('Agent run not found', 404);
    if (run.status !== 'completed') throw integrationError('Only a completed agent run can be verified');
    if (run.verification?.status === 'running' && active.has(`verify:${runId}`)) throw integrationError('A verification is already running for this run');
    if (!run.worktreePath || !existsSync(run.worktreePath)) throw integrationError('The isolated agent worktree is no longer available');
    const command = String(input.command || project.verifyCommand || detectVerifyCommand(project.repository)).trim().slice(0, 400);
    if (!command) throw integrationError('Add a test script to package.json or set a verify command for this project');
    const startedMs = Date.now();
    // Verification runs from Threadline's parent process on purpose: browser
    // tests and local listeners are blocked inside the agent sandbox. It still
    // executes agent-written code, so server credentials stay scrubbed.
    const script = `if [ -f package-lock.json ] && [ ! -d node_modules ]; then npm ci --no-audit --no-fund; fi\n${command}`;
    const child = spawnProcess('/bin/sh', ['-c', script], {
      cwd: run.worktreePath, env: buildAgentEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'
    });
    const entry = { kind: 'process', child, grouped: process.platform !== 'win32', settled: false, cancelTimer: null };
    active.set(`verify:${runId}`, entry);
    store.updateAgentRun(projectId, runId, { verification: { command, status: 'running', mode: 'worktree', startedAt: new Date(startedMs).toISOString() } });
    store.addAgentRunEvent(projectId, runId, 'verify', `Verification started in the isolated worktree: ${command}`);
    const emit = (line) => line.trim() && store.addAgentRunEvent(projectId, runId, 'verify', line);
    createInterface({ input: child.stdout }).on('line', emit);
    createInterface({ input: child.stderr }).on('line', emit);
    const finish = (status, exitCode) => {
      if (entry.settled) return;
      entry.settled = true;
      active.delete(`verify:${runId}`);
      const verification = { command, status, mode: 'worktree', exitCode, durationMs: Date.now() - startedMs, startedAt: new Date(startedMs).toISOString(), endedAt: new Date().toISOString() };
      store.updateAgentRun(projectId, runId, { verification });
      store.addAgentRunEvent(projectId, runId, 'verify', status === 'error'
        ? `Verification could not run: ${command}`
        : `Verification ${status} in ${Math.round(verification.durationMs / 1000)}s: ${command}`);
      if (status === 'failed') {
        const branch = store.getProject(projectId)?.branches.find((item) => item.id === run.branchId);
        if (branch) store.createAttentionItem(projectId, {
          branchId: branch.id, runId, kind: 'failure', severity: 'high',
          title: `${branch.name} verification failed`,
          detail: `${command} exited with code ${exitCode}. Review the verify output on the run.`
        });
      }
    };
    child.once('error', (error) => { store.addAgentRunEvent(projectId, runId, 'warning', error.message); finish('error', null); });
    child.once('close', (code) => finish(code === 0 ? 'passed' : 'failed', code ?? 1));
    return store.getAgentRun(projectId, runId);
  }

  function shutdown() {
    for (const entry of active.values()) {
      if (entry.kind === 'process') {
        entry.settled = true;
        if (entry.cancelTimer) clearTimeout(entry.cancelTimer);
        signalProcess(entry, 'SIGTERM');
      }
      else if (entry.timer) clearTimeout(entry.timer);
    }
    active.clear();
  }

  return { adapterInfo, start, control, integrate, verify, shutdown };
}
