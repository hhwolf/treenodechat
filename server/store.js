import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const now = () => new Date().toISOString();
const parse = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

export const defaultIntent = (brief = '') => ({
  objective: brief || 'Define what this project should accomplish.',
  audience: 'Senior engineers and technical solo founders working in an existing codebase.',
  outcome: 'A reviewed, tested change that can be understood and safely reversed.',
  avoid: 'Unrelated refactors, private data, hidden state, and irreversible actions without approval.',
  format: 'A concise implementation plan, reviewable changes, tests, and a decision summary.',
  qualityBar: 'Another engineer can understand the intent, verify the result, and recover from a mistake.',
  questions: [
    'Which behavior matters most to preserve?',
    'What evidence will prove this change works?',
    'What information is off-limits to agents?'
  ]
});

export function createStore(path = ':memory:', { seed = false } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL DEFAULT '',
      intent_json TEXT NOT NULL,
      repo_snapshot_json TEXT NOT NULL DEFAULT '{}',
      repo_scanned_at TEXT,
      integration_json TEXT NOT NULL DEFAULT '{}',
      verify_command TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ready',
      output_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contexts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('project', 'branch')),
      sensitivity TEXT NOT NULL DEFAULT 'shared' CHECK(sensitivity IN ('shared', 'private', 'restricted')),
      source TEXT NOT NULL DEFAULT 'User',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reasoning_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('approach', 'evidence', 'assumption', 'question', 'counterpoint', 'decision')),
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'confirmed', 'rejected')),
      source_label TEXT NOT NULL DEFAULT 'Threadline analysis',
      confidence TEXT CHECK(confidence IN ('low', 'medium', 'high')),
      created_by TEXT NOT NULL DEFAULT 'model' CHECK(created_by IN ('user', 'model', 'system')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL,
      adapter TEXT NOT NULL DEFAULT 'codex',
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
      task TEXT NOT NULL,
      worktree_path TEXT NOT NULL DEFAULT '',
      base_commit TEXT,
      session_id TEXT,
      pid INTEGER,
      sandbox_name TEXT,
      command_id TEXT,
      event_cursor INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      summary TEXT NOT NULL DEFAULT '',
      files_json TEXT NOT NULL DEFAULT '[]',
      diff_stat TEXT NOT NULL DEFAULT '',
      diff_text TEXT NOT NULL DEFAULT '',
      integration_json TEXT NOT NULL DEFAULT '{}',
      verification_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attention_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      branch_id TEXT,
      run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('review', 'failure', 'decision', 'permission')),
      severity TEXT NOT NULL DEFAULT 'normal' CHECK(severity IN ('normal', 'high')),
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_runs_project_branch ON agent_runs(project_id, branch_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS agent_run_events_run ON agent_run_events(run_id, id DESC);
    CREATE INDEX IF NOT EXISTS attention_items_project_status ON attention_items(project_id, status, created_at DESC);
  `);

  const projectColumns = new Set(db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name));
  if (!projectColumns.has('repo_snapshot_json')) db.exec("ALTER TABLE projects ADD COLUMN repo_snapshot_json TEXT NOT NULL DEFAULT '{}'");
  if (!projectColumns.has('repo_scanned_at')) db.exec('ALTER TABLE projects ADD COLUMN repo_scanned_at TEXT');
  if (!projectColumns.has('integration_json')) db.exec("ALTER TABLE projects ADD COLUMN integration_json TEXT NOT NULL DEFAULT '{}'");
  if (!projectColumns.has('verify_command')) db.exec("ALTER TABLE projects ADD COLUMN verify_command TEXT NOT NULL DEFAULT ''");
  const runColumns = new Set(db.prepare('PRAGMA table_info(agent_runs)').all().map((column) => column.name));
  if (!runColumns.has('sandbox_name')) db.exec('ALTER TABLE agent_runs ADD COLUMN sandbox_name TEXT');
  if (!runColumns.has('command_id')) db.exec('ALTER TABLE agent_runs ADD COLUMN command_id TEXT');
  if (!runColumns.has('event_cursor')) db.exec('ALTER TABLE agent_runs ADD COLUMN event_cursor INTEGER NOT NULL DEFAULT 0');
  if (!runColumns.has('integration_json')) db.exec("ALTER TABLE agent_runs ADD COLUMN integration_json TEXT NOT NULL DEFAULT '{}'");
  if (!runColumns.has('verification_json')) db.exec("ALTER TABLE agent_runs ADD COLUMN verification_json TEXT NOT NULL DEFAULT '{}'");

  const event = (projectId, kind, summary) => {
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(randomUUID(), projectId, kind, summary, now());
  };

  const rowToBranch = (row) => ({
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    name: row.name,
    purpose: row.purpose,
    status: row.status,
    output: parse(row.output_json, { summary: '', changes: [] }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  const rowToContext = (row) => ({
    id: row.id,
    projectId: row.project_id,
    branchId: row.branch_id,
    label: row.label,
    value: row.value,
    scope: row.scope,
    sensitivity: row.sensitivity,
    source: row.source,
    createdAt: row.created_at
  });

  const rowToReasoningItem = (row) => ({
    id: row.id,
    projectId: row.project_id,
    branchId: row.branch_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    status: row.status,
    sourceLabel: row.source_label,
    confidence: row.confidence,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  const rowToVerification = (row) => {
    const verification = parse(row.verification_json, {});
    return verification.status ? verification : null;
  };

  const rowToAgentRun = (row, events = []) => ({
    id: row.id,
    projectId: row.project_id,
    branchId: row.branch_id,
    adapter: row.adapter,
    status: row.status,
    task: row.task,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    sessionId: row.session_id,
    pid: row.pid,
    sandboxName: row.sandbox_name,
    commandId: row.command_id,
    eventCursor: Number(row.event_cursor || 0),
    exitCode: row.exit_code,
    summary: row.summary,
    files: parse(row.files_json, []),
    diffStat: row.diff_stat,
    diff: row.diff_text,
    integration: parse(row.integration_json, {}),
    verification: rowToVerification(row),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    events
  });

  const rowToAttentionItem = (row) => ({
    id: row.id,
    projectId: row.project_id,
    branchId: row.branch_id,
    runId: row.run_id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  });

  function listProjects() {
    return db.prepare(`
      SELECT p.id, p.name, p.repo_path, p.updated_at,
        (SELECT COUNT(*) FROM branches b WHERE b.project_id = p.id) AS branch_count
      FROM projects p ORDER BY p.updated_at DESC
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      repoPath: row.repo_path,
      updatedAt: row.updated_at,
      branchCount: Number(row.branch_count)
    }));
  }

  function getProject(projectId) {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!row) return null;
    const branches = db.prepare('SELECT * FROM branches WHERE project_id = ? ORDER BY created_at').all(projectId).map(rowToBranch);
    const contexts = db.prepare('SELECT * FROM contexts WHERE project_id = ? ORDER BY created_at').all(projectId).map(rowToContext);
    const reasoning = db.prepare("SELECT * FROM reasoning_items WHERE project_id = ? AND status != 'rejected' ORDER BY created_at").all(projectId).map(rowToReasoningItem);
    const checkpoints = db.prepare('SELECT id, project_id, name, created_at FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC').all(projectId).map((item) => ({
      id: item.id,
      projectId: item.project_id,
      name: item.name,
      createdAt: item.created_at
    }));
    const events = db.prepare('SELECT id, kind, summary, created_at FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT 30').all(projectId).map((item) => ({
      id: item.id,
      kind: item.kind,
      summary: item.summary,
      createdAt: item.created_at
    }));
    const runRows = db.prepare('SELECT * FROM agent_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50').all(projectId);
    const eventsByRun = new Map();
    const recentRunEvents = db.prepare('SELECT id, run_id, kind, message, created_at FROM agent_run_events WHERE project_id = ? ORDER BY id DESC LIMIT 600').all(projectId);
    for (const item of recentRunEvents) {
      const collected = eventsByRun.get(item.run_id) || [];
      if (collected.length < 12) collected.unshift({
        id: item.id,
        kind: item.kind,
        message: item.message,
        createdAt: item.created_at
      });
      eventsByRun.set(item.run_id, collected);
    }
    const agentRuns = runRows.map((run) => rowToAgentRun(run, eventsByRun.get(run.id) || []));
    const attentionItems = db.prepare('SELECT * FROM attention_items WHERE project_id = ? ORDER BY status, created_at DESC LIMIT 100').all(projectId).map(rowToAttentionItem);
    return {
      id: row.id,
      name: row.name,
      repoPath: row.repo_path,
      intent: parse(row.intent_json, defaultIntent()),
      repository: parse(row.repo_snapshot_json, {}),
      integration: parse(row.integration_json, {}),
      verifyCommand: row.verify_command || '',
      branches,
      contexts,
      reasoning,
      checkpoints,
      events,
      agentRuns,
      attentionItems,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function touchProject(projectId) {
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), projectId);
  }

  function createAgentRun(projectId, branchId, input) {
    const branch = db.prepare('SELECT id FROM branches WHERE id = ? AND project_id = ?').get(branchId, projectId);
    if (!branch) throw new Error('Branch not found');
    const active = db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE project_id = ? AND status IN ('queued', 'running', 'paused')").get(projectId);
    if (Number(active.count) >= 5) throw new Error('This project already has five active agent runs');
    const branchActive = db.prepare("SELECT id FROM agent_runs WHERE project_id = ? AND branch_id = ? AND status IN ('queued', 'running', 'paused')").get(projectId, branchId);
    if (branchActive) throw new Error('This branch already has an active agent run');
    const id = input.id || randomUUID();
    const timestamp = now();
    db.prepare(`INSERT INTO agent_runs (
      id, project_id, branch_id, adapter, status, task, worktree_path, base_commit,
      session_id, pid, sandbox_name, command_id, event_cursor, exit_code, summary, files_json, diff_stat, diff_text,
      started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, NULL, NULL, ?, ?, 0, NULL, '', '[]', '', '', NULL, NULL, ?, ?)`)
      .run(id, projectId, branchId, input.adapter || 'codex', input.task, input.worktreePath || '', input.baseCommit || null, input.sandboxName || null, input.commandId || null, timestamp, timestamp);
    db.prepare("UPDATE branches SET status = 'active', updated_at = ? WHERE id = ?").run(timestamp, branchId);
    touchProject(projectId);
    event(projectId, 'agent', `Queued ${input.adapter || 'Codex'} for a focused run.`);
    return getAgentRun(projectId, id);
  }

  function getAgentRun(projectId, runId) {
    const row = db.prepare('SELECT * FROM agent_runs WHERE id = ? AND project_id = ?').get(runId, projectId);
    if (!row) return null;
    return rowToAgentRun(row, listAgentRunEvents(projectId, runId));
  }

  function updateAgentRun(projectId, runId, updates) {
    const current = db.prepare('SELECT * FROM agent_runs WHERE id = ? AND project_id = ?').get(runId, projectId);
    if (!current) return null;
    const timestamp = now();
    const status = updates.status ?? current.status;
    const startedAt = updates.startedAt ?? current.started_at ?? (status === 'running' ? timestamp : null);
    const endedAt = updates.endedAt ?? current.ended_at ?? (['completed', 'failed', 'cancelled'].includes(status) ? timestamp : null);
    db.prepare(`UPDATE agent_runs SET status = ?, worktree_path = ?, base_commit = ?, session_id = ?, pid = ?, sandbox_name = ?, command_id = ?, event_cursor = ?, exit_code = ?, summary = ?, files_json = ?, diff_stat = ?, diff_text = ?, integration_json = ?, verification_json = ?, started_at = ?, ended_at = ?, updated_at = ? WHERE id = ? AND project_id = ?`).run(
      status,
      updates.worktreePath ?? current.worktree_path,
      updates.baseCommit ?? current.base_commit,
      updates.sessionId ?? current.session_id,
      updates.pid === undefined ? current.pid : updates.pid,
      updates.sandboxName ?? current.sandbox_name,
      updates.commandId ?? current.command_id,
      updates.eventCursor ?? current.event_cursor,
      updates.exitCode === undefined ? current.exit_code : updates.exitCode,
      updates.summary ?? current.summary,
      JSON.stringify(updates.files ?? parse(current.files_json, [])),
      updates.diffStat ?? current.diff_stat,
      updates.diff ?? current.diff_text,
      JSON.stringify(updates.integration ?? parse(current.integration_json, {})),
      JSON.stringify(updates.verification ?? parse(current.verification_json, {})),
      startedAt,
      endedAt,
      timestamp,
      runId,
      projectId
    );
    if (updates.status === 'completed' || updates.status === 'failed' || updates.status === 'cancelled') {
      db.prepare("UPDATE branches SET status = 'review', updated_at = ? WHERE id = ? AND project_id = ?").run(timestamp, current.branch_id, projectId);
    }
    touchProject(projectId);
    return getAgentRun(projectId, runId);
  }

  function addAgentRunEvent(projectId, runId, kind, message, payload = {}) {
    const run = db.prepare('SELECT id FROM agent_runs WHERE id = ? AND project_id = ?').get(runId, projectId);
    if (!run) return null;
    const result = db.prepare('INSERT INTO agent_run_events (run_id, project_id, kind, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      runId,
      projectId,
      kind,
      String(message || kind).slice(0, 4_000),
      JSON.stringify(payload),
      now()
    );
    return Number(result.lastInsertRowid);
  }

  function listAgentRunEvents(projectId, runId, after = 0) {
    return db.prepare('SELECT id, kind, message, payload_json, created_at FROM agent_run_events WHERE run_id = ? AND project_id = ? AND id > ? ORDER BY id LIMIT 200').all(runId, projectId, Number(after) || 0).map((item) => ({
      id: item.id,
      kind: item.kind,
      message: item.message,
      payload: parse(item.payload_json, {}),
      createdAt: item.created_at
    }));
  }

  function createAttentionItem(projectId, input) {
    const existing = input.runId ? db.prepare("SELECT * FROM attention_items WHERE project_id = ? AND run_id = ? AND kind = ? AND status = 'open'").get(projectId, input.runId, input.kind) : null;
    if (existing) return rowToAttentionItem(existing);
    const id = randomUUID();
    db.prepare('INSERT INTO attention_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      id,
      projectId,
      input.branchId || null,
      input.runId || null,
      input.kind,
      input.severity || 'normal',
      input.title,
      input.detail || '',
      'open',
      now()
    );
    touchProject(projectId);
    return rowToAttentionItem(db.prepare('SELECT * FROM attention_items WHERE id = ?').get(id));
  }

  function resolveAttentionItem(projectId, itemId, status = 'resolved') {
    if (status !== 'resolved') throw new Error('Attention items can only be resolved');
    const current = db.prepare('SELECT * FROM attention_items WHERE id = ? AND project_id = ?').get(itemId, projectId);
    if (!current) return null;
    db.prepare("UPDATE attention_items SET status = 'resolved', resolved_at = ? WHERE id = ? AND project_id = ?").run(now(), itemId, projectId);
    touchProject(projectId);
    event(projectId, 'attention', `${current.title} resolved.`);
    return getProject(projectId);
  }

  function recoverInterruptedRuns() {
    const interrupted = db.prepare("SELECT * FROM agent_runs WHERE status IN ('queued', 'running', 'paused')").all();
    for (const run of interrupted) {
      updateAgentRun(run.project_id, run.id, { status: 'failed', summary: 'Threadline restarted before this run finished.', pid: null, exitCode: null });
      addAgentRunEvent(run.project_id, run.id, 'failed', 'Run interrupted by a Threadline restart.');
      createAttentionItem(run.project_id, {
        branchId: run.branch_id,
        runId: run.id,
        kind: 'failure',
        severity: 'high',
        title: 'Agent run was interrupted',
        detail: 'Threadline restarted before the run finished. Review the isolated worktree before retrying.'
      });
    }
    return interrupted.length;
  }

  function createProject({ name, repoPath = '', brief = '', intent, repository = {} }) {
    const id = randomUUID();
    const timestamp = now();
    const projectIntent = { ...defaultIntent(brief), ...(intent || {}) };
    db.prepare('INSERT INTO projects (id, name, repo_path, intent_json, repo_snapshot_json, repo_scanned_at, integration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, name || 'Untitled project', repoPath, JSON.stringify(projectIntent), JSON.stringify(repository), repository.scannedAt || null, '{}', timestamp, timestamp
    );
    const mainId = randomUUID();
    db.prepare('INSERT INTO branches VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)').run(
      mainId,
      id,
      'Main',
      'Deliver the approved project intent.',
      'active',
      JSON.stringify({ summary: 'Mainline work starts here.', changes: [] }),
      timestamp,
      timestamp
    );
    db.prepare('INSERT INTO contexts VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(), id, 'Repository boundary', repoPath || 'No repository selected', 'project', 'shared', 'Project setup', timestamp
    );
    event(id, 'project', 'Project created from a structured intent.');
    return getProject(id);
  }

  function updateIntent(projectId, intent) {
    const project = getProject(projectId);
    if (!project) return null;
    const updated = { ...project.intent, ...intent };
    db.prepare('UPDATE projects SET intent_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updated), now(), projectId);
    event(projectId, 'intent', 'Intent updated; descendant branches may need review.');
    return getProject(projectId);
  }

  function updateRepositorySnapshot(projectId, repository, { preserveRepoPath = false } = {}) {
    const project = getProject(projectId);
    if (!project) return null;
    db.prepare('UPDATE projects SET repo_path = ?, repo_snapshot_json = ?, repo_scanned_at = ?, integration_json = ?, updated_at = ? WHERE id = ?').run(
      preserveRepoPath ? project.repoPath : repository.root,
      JSON.stringify(repository),
      repository.scannedAt,
      preserveRepoPath || project.repoPath === repository.root ? JSON.stringify(project.integration || {}) : '{}',
      now(),
      projectId
    );
    event(projectId, 'repository', `Scanned ${repository.fileCount} tracked files on ${repository.branch}.`);
    return getProject(projectId);
  }

  function updateProjectIntegration(projectId, integration) {
    if (!getProject(projectId)) return null;
    db.prepare('UPDATE projects SET integration_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(integration || {}), now(), projectId);
    event(projectId, 'integration', integration?.headCommit
      ? `Project code advanced on ${integration.branchName} at ${integration.headCommit.slice(0, 8)}.`
      : 'Project integration workspace initialized.');
    return getProject(projectId);
  }

  function updateProjectSettings(projectId, { verifyCommand } = {}) {
    if (!getProject(projectId)) return null;
    db.prepare('UPDATE projects SET verify_command = ?, updated_at = ? WHERE id = ?').run(String(verifyCommand || '').trim().slice(0, 400), now(), projectId);
    event(projectId, 'settings', verifyCommand ? 'Verify command updated.' : 'Verify command cleared.');
    return getProject(projectId);
  }

  function createBranch(projectId, { parentId, name, purpose = '', context = '' }) {
    if (!getProject(projectId)) return null;
    const parent = db.prepare('SELECT * FROM branches WHERE id = ? AND project_id = ?').get(parentId, projectId);
    if (!parent) throw new Error('Parent branch not found');
    const id = randomUUID();
    const timestamp = now();
    db.prepare('INSERT INTO branches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      projectId,
      parentId,
      name || 'New branch',
      purpose,
      'ready',
      JSON.stringify({ summary: 'No output yet.', changes: [] }),
      timestamp,
      timestamp
    );
    if (context.trim()) {
      db.prepare('INSERT INTO contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID(), projectId, id, 'Branch direction', context.trim(), 'branch', 'shared', 'Branch setup', timestamp
      );
    }
    event(projectId, 'branch', `Forked ${name || 'New branch'} from ${parent.name}.`);
    return getProject(projectId);
  }

  function updateBranch(projectId, branchId, updates) {
    const current = db.prepare('SELECT * FROM branches WHERE id = ? AND project_id = ?').get(branchId, projectId);
    if (!current) return null;
    const output = updates.output ? { ...parse(current.output_json, {}), ...updates.output } : parse(current.output_json, {});
    db.prepare(`UPDATE branches SET name = ?, purpose = ?, status = ?, output_json = ?, updated_at = ? WHERE id = ? AND project_id = ?`).run(
      updates.name ?? current.name,
      updates.purpose ?? current.purpose,
      updates.status ?? current.status,
      JSON.stringify(output),
      now(),
      branchId,
      projectId
    );
    event(projectId, 'branch', `${updates.name || current.name} updated.`);
    return getProject(projectId);
  }

  function createContext(projectId, input) {
    if (!getProject(projectId)) return null;
    if (input.scope === 'branch' && !input.branchId) throw new Error('Branch context requires a branch');
    const timestamp = now();
    db.prepare('INSERT INTO contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(),
      projectId,
      input.scope === 'branch' ? input.branchId : null,
      input.label,
      input.value,
      input.scope || 'project',
      input.sensitivity || 'shared',
      input.source || 'User',
      timestamp
    );
    event(projectId, 'context', `${input.label} added at ${input.scope || 'project'} scope.`);
    return getProject(projectId);
  }

  function inheritedContexts(projectId, branchId, { includePrivate = false } = {}) {
    const project = getProject(projectId);
    if (!project) return [];
    const branchMap = new Map(project.branches.map((branch) => [branch.id, branch]));
    const ancestry = new Set();
    let cursor = branchMap.get(branchId);
    while (cursor) {
      ancestry.add(cursor.id);
      cursor = cursor.parentId ? branchMap.get(cursor.parentId) : null;
    }
    return project.contexts.filter((item) => {
      if (!includePrivate && item.sensitivity !== 'shared') return false;
      return item.scope === 'project' || ancestry.has(item.branchId);
    });
  }

  function replaceReasoningProposals(projectId, items = []) {
    if (!getProject(projectId)) return null;
    const allowedKinds = new Set(['approach', 'evidence', 'assumption', 'question', 'counterpoint', 'decision']);
    const confirmedKeys = new Set(db.prepare("SELECT kind, title FROM reasoning_items WHERE project_id = ? AND status = 'confirmed'").all(projectId).map((item) => `${item.kind}:${item.title.trim().toLowerCase()}`));
    const timestamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("DELETE FROM reasoning_items WHERE project_id = ? AND status = 'proposed'").run(projectId);
      const insert = db.prepare('INSERT INTO reasoning_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const item of items.slice(0, 12)) {
        if (!allowedKinds.has(item.kind) || !item.title?.trim() || !item.summary?.trim()) continue;
        if (confirmedKeys.has(`${item.kind}:${item.title.trim().toLowerCase()}`)) continue;
        insert.run(
          randomUUID(),
          projectId,
          item.branchId || null,
          item.kind,
          item.title.trim(),
          item.summary.trim(),
          'proposed',
          item.sourceLabel || 'Threadline analysis',
          ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : null,
          item.createdBy === 'user' ? 'user' : 'model',
          timestamp,
          timestamp
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    event(projectId, 'reasoning', 'Reasoning focus refreshed; interpretive items are awaiting review.');
    return getProject(projectId);
  }

  function resolveReasoningItem(projectId, itemId, status) {
    if (!['confirmed', 'rejected'].includes(status)) throw new Error('Reasoning item must be confirmed or rejected');
    const current = db.prepare('SELECT * FROM reasoning_items WHERE id = ? AND project_id = ?').get(itemId, projectId);
    if (!current) return null;
    db.prepare('UPDATE reasoning_items SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?').run(status, now(), itemId, projectId);
    event(projectId, 'reasoning', `${current.title} ${status === 'confirmed' ? 'confirmed' : 'dismissed'}.`);
    return getProject(projectId);
  }

  function addReasoningChallenge(projectId) {
    const project = getProject(projectId);
    if (!project) return null;
    const existing = project.reasoning.find((item) => item.kind === 'counterpoint' && item.status === 'proposed');
    if (existing) return project;
    const timestamp = now();
    db.prepare('INSERT INTO reasoning_items VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(),
      projectId,
      'counterpoint',
      'What would make the preferred path fail?',
      `Look for a case where “${project.intent.objective}” conflicts with the behavior that must be preserved. Identify the smallest test or source that could disprove the current direction.`,
      'proposed',
      'Project intent · generated challenge',
      'medium',
      'model',
      timestamp,
      timestamp
    );
    event(projectId, 'reasoning', 'Added a counterpoint to challenge the current frame.');
    return getProject(projectId);
  }

  function createCheckpoint(projectId, name = 'Manual checkpoint') {
    const project = getProject(projectId);
    if (!project) return null;
    const id = randomUUID();
    db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?)').run(id, projectId, name, JSON.stringify(project), now());
    event(projectId, 'checkpoint', `${name} created.`);
    return getProject(projectId);
  }

  function restoreCheckpoint(projectId, checkpointId) {
    const row = db.prepare('SELECT * FROM checkpoints WHERE id = ? AND project_id = ?').get(checkpointId, projectId);
    if (!row) return null;
    const snapshot = parse(row.snapshot_json, null);
    if (!snapshot) throw new Error('Checkpoint is unreadable');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE projects SET name = ?, repo_path = ?, intent_json = ?, repo_snapshot_json = ?, repo_scanned_at = ?, updated_at = ? WHERE id = ?').run(
        snapshot.name, snapshot.repoPath, JSON.stringify(snapshot.intent), JSON.stringify(snapshot.repository || {}), snapshot.repository?.scannedAt || null, now(), projectId
      );
      db.prepare('DELETE FROM contexts WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM reasoning_items WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM branches WHERE project_id = ?').run(projectId);
      for (const branch of snapshot.branches) {
        db.prepare('INSERT INTO branches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          branch.id, projectId, branch.parentId, branch.name, branch.purpose, branch.status, JSON.stringify(branch.output), branch.createdAt, branch.updatedAt
        );
      }
      for (const context of snapshot.contexts) {
        db.prepare('INSERT INTO contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          context.id, projectId, context.branchId, context.label, context.value, context.scope, context.sensitivity, context.source, context.createdAt
        );
      }
      for (const item of snapshot.reasoning || []) {
        db.prepare('INSERT INTO reasoning_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          item.id, projectId, item.branchId, item.kind, item.title, item.summary, item.status, item.sourceLabel, item.confidence, item.createdBy, item.createdAt, item.updatedAt
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    event(projectId, 'restore', `Restored ${row.name}; the checkpoint remains available.`);
    return getProject(projectId);
  }

  function mergeBranch(projectId, sourceId, targetId, acceptedIds = []) {
    const project = getProject(projectId);
    if (!project) return null;
    const source = project.branches.find((branch) => branch.id === sourceId);
    const target = project.branches.find((branch) => branch.id === targetId);
    if (!source || !target) throw new Error('Source or target branch not found');
    const accepted = (source.output.changes || []).filter((change) => acceptedIds.includes(change.id));
    if (!accepted.length) throw new Error('Select at least one change to merge');
    createCheckpoint(projectId, `Before merging ${source.name}`);
    const existing = target.output.changes || [];
    const output = {
      ...target.output,
      summary: `${target.output.summary || ''}\nMerged ${accepted.length} change${accepted.length === 1 ? '' : 's'} from ${source.name}.`.trim(),
      changes: [...existing, ...accepted.map((change) => ({ ...change, mergedFrom: source.id }))]
    };
    db.prepare('UPDATE branches SET output_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(output), now(), targetId);
    db.prepare('UPDATE branches SET status = ?, updated_at = ? WHERE id = ?').run('merged', now(), sourceId);
    event(projectId, 'merge', `Merged ${accepted.length} selected changes from ${source.name} into ${target.name}.`);
    return getProject(projectId);
  }

  function seedDemo() {
    if (listProjects().length) return;
    const project = createProject({
      name: 'Threadline V2',
      repoPath: '/projects/treenodechat',
      brief: 'Build a simpler persistent workspace for large AI-assisted coding projects.',
      intent: {
        audience: 'Senior engineers and technical solo founders using coding agents on multi-day work.',
        outcome: 'Humans and agents share a durable understanding of intent, context, parallel work, decisions, and changes.',
        avoid: 'Chat-only state, hidden context, unrelated refactors, private information, and irreversible actions without approval.',
        format: 'A focused local-first product with inspectable branches, context, comparisons, merges, and checkpoints.',
        qualityBar: 'A developer can resume work in under one minute without restating project context.',
        questions: ['Which repository action should require approval?', 'What result proves the first coding workflow is complete?']
      }
    });
    const main = project.branches[0];
    let updated = createBranch(project.id, {
      parentId: main.id,
      name: 'Simplify workspace',
      purpose: 'Reduce the default interface to intent, branches, current output, and next action.',
      context: 'Advanced context and recovery tools remain one click away.'
    });
    const simplify = updated.branches.find((branch) => branch.name === 'Simplify workspace');
    updateBranch(project.id, simplify.id, {
      status: 'review',
      output: {
        summary: 'A progressive workspace that reveals complexity only when the project needs it.',
        changes: [
          { id: 'change-navigation', title: 'Simplify navigation', detail: 'Keep Intent and Branches visible; move context and history behind Advanced.', selected: true },
          { id: 'change-focus', title: 'Add a single focus surface', detail: 'Show the current branch output and next action without dashboard noise.', selected: true }
        ]
      }
    });
    updated = createBranch(project.id, {
      parentId: main.id,
      name: 'Persistent API',
      purpose: 'Persist project state and expose a local API for future model adapters.',
      context: 'Use local SQLite; model credentials never reach the browser.'
    });
    const apiBranch = updated.branches.find((branch) => branch.name === 'Persistent API');
    updateBranch(project.id, apiBranch.id, {
      status: 'active',
      output: {
        summary: 'SQLite-backed projects, branches, context, checkpoints, and activity.',
        changes: [{ id: 'change-api', title: 'Add local project API', detail: 'Persist state through explicit endpoints instead of modal simulations.', selected: true }]
      }
    });
    createContext(project.id, { label: 'Autonomy boundary', value: 'Shared repository information is available. Private or restricted information is excluded. External and irreversible actions require approval.', scope: 'project', sensitivity: 'shared', source: 'Product intent' });
    replaceReasoningProposals(project.id, [
      { kind: 'approach', title: 'Add a calm Focus view', summary: 'Lead with the current question, a few alternatives, evidence, and the next decision instead of exposing a full graph.', sourceLabel: 'Product intent', confidence: 'high' },
      { kind: 'approach', title: 'Keep branches as execution lanes', summary: 'Use the existing tree for isolated work while Focus explains why each direction exists and how the alternatives differ.', sourceLabel: 'Existing branch model', confidence: 'high' },
      { kind: 'evidence', title: 'Progressive disclosure is already a constraint', summary: 'The current design deliberately keeps context, recovery, and activity behind Advanced.', sourceLabel: 'DESIGN.md', confidence: 'high' },
      { kind: 'assumption', title: 'A compact reasoning brief is enough for V3', summary: 'Users will gain more from a small source-backed reasoning surface than from a free-form graph canvas in the base workflow.', sourceLabel: 'Product research synthesis', confidence: 'medium' },
      { kind: 'question', title: 'How should we measure better reasoning?', summary: 'Define a task that tests whether users notice alternatives and contradictions faster than they do in a transcript.', sourceLabel: 'Success criteria', confidence: 'medium' }
    ]);
    createCheckpoint(project.id, 'V2 direction locked');
  }

  if (seed) seedDemo();

  return {
    mode: 'local',
    db,
    close: () => db.close(),
    listProjects,
    getProject,
    createProject,
    updateIntent,
    updateRepositorySnapshot,
    updateProjectIntegration,
    updateProjectSettings,
    createBranch,
    updateBranch,
    createContext,
    inheritedContexts,
    replaceReasoningProposals,
    resolveReasoningItem,
    addReasoningChallenge,
    createCheckpoint,
    restoreCheckpoint,
    mergeBranch,
    createAgentRun,
    getAgentRun,
    updateAgentRun,
    addAgentRunEvent,
    listAgentRunEvents,
    createAttentionItem,
    resolveAttentionItem,
    recoverInterruptedRuns,
    seedDemo
  };
}
