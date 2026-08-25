import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

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

export function prepareGitWorktree(repoPath, worktreePath) {
  const root = git(repoPath, ['rev-parse', '--show-toplevel']);
  const baseCommit = git(root, ['rev-parse', 'HEAD']);
  mkdirSync(dirname(worktreePath), { recursive: true });
  git(root, ['worktree', 'add', '--detach', worktreePath, baseCommit], { timeout: 60_000 });
  return { root, baseCommit };
}

export function summarizeGitWorktree(worktreePath, baseCommit) {
  if (!worktreePath || !baseCommit || !existsSync(worktreePath)) return { files: [], diffStat: '', diff: '' };
  const committedFiles = git(worktreePath, ['diff', '--name-only', baseCommit, 'HEAD']).split('\n').filter(Boolean);
  const statusLines = git(worktreePath, ['status', '--short']).split('\n').filter(Boolean);
  const workingFiles = statusLines.map((line) => line.replace(/^\s?\S{1,2}\s+/, '')).filter(Boolean);
  const untrackedFiles = statusLines.filter((line) => line.startsWith('?? ')).map((line) => line.slice(3));
  const files = [...new Set([...committedFiles, ...workingFiles])].slice(0, 100);
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
      cachedInfo = { id: 'demo', name: 'Demo agent', available: true, version: 'local', safety: 'isolated-worktree' };
      return cachedInfo;
    }
    const result = checkProcess(command, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    cachedInfo = {
      id: 'codex',
      name: 'Codex CLI',
      available: result.status === 0,
      version: result.status === 0 ? result.stdout.trim() : '',
      error: result.status === 0 ? '' : (result.stderr?.trim() || 'Codex CLI is not available'),
      safety: 'workspace-write'
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
      const prepared = prepareWorktree(project.repoPath, run.worktreePath);
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

  return { adapterInfo, start, control, shutdown };
}
