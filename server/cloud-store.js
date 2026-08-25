import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { defaultIntent } from './store.js';

const { Pool } = pg;
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'paused']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const BRANCH_STATUSES = new Set(['ready', 'active', 'review', 'merged', 'blocked']);
const REASONING_KINDS = new Set(['approach', 'evidence', 'assumption', 'question', 'counterpoint', 'decision']);
const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);

function visibleProject(document) {
  if (!document) return null;
  const project = clone(document);
  project.checkpoints = (project.checkpoints || []).map(({ snapshot: _snapshot, ...checkpoint }) => checkpoint);
  project.events = (project.events || []).slice(0, 30);
  project.agentRuns = (project.agentRuns || []).slice(0, 50).map((run) => ({ ...run, events: (run.events || []).slice(-12) }));
  project.attentionItems = (project.attentionItems || []).slice(0, 100);
  delete project.nextEventId;
  return project;
}

function addEvent(project, kind, summary) {
  project.events ||= [];
  project.events.unshift({ id: randomUUID(), kind, summary, createdAt: now() });
  project.events = project.events.slice(0, 100);
}

function inherited(project, branchId, includePrivate = false) {
  const branches = new Map(project.branches.map((branch) => [branch.id, branch]));
  const ancestry = new Set();
  let cursor = branches.get(branchId);
  while (cursor) {
    ancestry.add(cursor.id);
    cursor = cursor.parentId ? branches.get(cursor.parentId) : null;
  }
  return project.contexts.filter((item) => {
    if (!includePrivate && item.sensitivity !== 'shared') return false;
    return item.scope === 'project' || ancestry.has(item.branchId);
  });
}

function normalizeRun(run) {
  return {
    events: [], files: [], diffStat: '', diff: '', summary: '', eventCursor: 0,
    sandboxName: null, commandId: null, sessionId: null, pid: null, exitCode: null,
    startedAt: null, endedAt: null,
    ...run
  };
}

export function createCloudStore(connectionString = process.env.DATABASE_URL, options = {}) {
  if (!connectionString && !options.pool) throw new Error('DATABASE_URL is required for hosted Threadline');
  const pool = options.pool || new Pool({ connectionString, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  if (!options.pool || options.attachPool) attachDatabasePool(pool);
  let initialization;

  const initialize = () => {
    initialization ||= pool.query(`
      CREATE TABLE IF NOT EXISTS threadline_projects (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        repo_location TEXT NOT NULL DEFAULT '',
        document JSONB NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS threadline_projects_updated_at
        ON threadline_projects(updated_at DESC);
    `);
    return initialization;
  };

  async function listProjects() {
    await initialize();
    const result = await pool.query('SELECT id, name, repo_location, document, updated_at FROM threadline_projects ORDER BY updated_at DESC');
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      repoPath: row.repo_location,
      updatedAt: row.updated_at.toISOString(),
      branchCount: Array.isArray(row.document?.branches) ? row.document.branches.length : 0
    }));
  }

  async function readRaw(projectId, client = pool) {
    await initialize();
    const result = await client.query('SELECT document FROM threadline_projects WHERE id = $1', [projectId]);
    return result.rows[0]?.document || null;
  }

  async function getProject(projectId) {
    return visibleProject(await readRaw(projectId));
  }

  async function mutate(projectId, transform) {
    await initialize();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT document FROM threadline_projects WHERE id = $1 FOR UPDATE', [projectId]);
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const project = result.rows[0].document;
      const output = await transform(project);
      project.updatedAt = now();
      await client.query(
        'UPDATE threadline_projects SET name = $2, repo_location = $3, document = $4::jsonb, version = version + 1, updated_at = NOW() WHERE id = $1',
        [projectId, project.name, project.repoPath || '', JSON.stringify(project)]
      );
      await client.query('COMMIT');
      return output === undefined ? visibleProject(project) : output;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function createProject({ name, repoPath = '', brief = '', intent, repository = {} }) {
    await initialize();
    const id = randomUUID();
    const timestamp = now();
    const mainId = randomUUID();
    const project = {
      id,
      name: String(name || 'Untitled project').slice(0, 160),
      repoPath,
      intent: { ...defaultIntent(brief), ...(intent || {}) },
      repository,
      branches: [{
        id: mainId, projectId: id, parentId: null, name: 'Main', purpose: 'Deliver the approved project intent.',
        status: 'active', output: { summary: 'Mainline work starts here.', changes: [] }, createdAt: timestamp, updatedAt: timestamp
      }],
      contexts: [{
        id: randomUUID(), projectId: id, branchId: null, label: 'Repository boundary', value: repoPath || 'No repository selected',
        scope: 'project', sensitivity: 'shared', source: 'Project setup', createdAt: timestamp
      }],
      reasoning: [], checkpoints: [], agentRuns: [], attentionItems: [], events: [], nextEventId: 1,
      createdAt: timestamp, updatedAt: timestamp
    };
    addEvent(project, 'project', 'Project created from a structured intent.');
    await pool.query(
      'INSERT INTO threadline_projects (id, name, repo_location, document) VALUES ($1, $2, $3, $4::jsonb)',
      [id, project.name, repoPath, JSON.stringify(project)]
    );
    return visibleProject(project);
  }

  async function updateIntent(projectId, intent) {
    return mutate(projectId, (project) => {
      project.intent = { ...project.intent, ...intent };
      addEvent(project, 'intent', 'Intent updated; descendant branches may need review.');
    });
  }

  async function updateRepositorySnapshot(projectId, repository) {
    return mutate(projectId, (project) => {
      project.repoPath = repository.root || project.repoPath;
      project.repository = repository;
      addEvent(project, 'repository', `Scanned ${repository.fileCount || 0} tracked files on ${repository.branch || 'the default branch'}.`);
    });
  }

  async function createBranch(projectId, { parentId, name, purpose = '', context = '' }) {
    return mutate(projectId, (project) => {
      const parent = project.branches.find((branch) => branch.id === parentId);
      if (!parent) throw new Error('Parent branch not found');
      const timestamp = now();
      const branch = {
        id: randomUUID(), projectId, parentId, name: String(name || 'New branch').slice(0, 160), purpose: String(purpose).slice(0, 2_000),
        status: 'ready', output: { summary: 'No output yet.', changes: [] }, createdAt: timestamp, updatedAt: timestamp
      };
      project.branches.push(branch);
      if (String(context).trim()) project.contexts.push({
        id: randomUUID(), projectId, branchId: branch.id, label: 'Branch direction', value: String(context).trim().slice(0, 10_000),
        scope: 'branch', sensitivity: 'shared', source: 'Branch setup', createdAt: timestamp
      });
      addEvent(project, 'branch', `Forked ${branch.name} from ${parent.name}.`);
    });
  }

  async function updateBranch(projectId, branchId, updates) {
    return mutate(projectId, (project) => {
      const branch = project.branches.find((item) => item.id === branchId);
      if (!branch) return null;
      if (updates.status && !BRANCH_STATUSES.has(updates.status)) throw new Error('Branch status is invalid');
      branch.name = updates.name ?? branch.name;
      branch.purpose = updates.purpose ?? branch.purpose;
      branch.status = updates.status ?? branch.status;
      if (updates.output) branch.output = { ...branch.output, ...updates.output };
      branch.updatedAt = now();
      addEvent(project, 'branch', `${branch.name} updated.`);
    });
  }

  async function createContext(projectId, input) {
    return mutate(projectId, (project) => {
      const scope = input.scope || 'project';
      const sensitivity = input.sensitivity || 'shared';
      if (!['project', 'branch'].includes(scope)) throw new Error('Context scope is invalid');
      if (!['shared', 'private', 'restricted'].includes(sensitivity)) throw new Error('Context sensitivity is invalid');
      if (scope === 'branch' && !project.branches.some((branch) => branch.id === input.branchId)) throw new Error('Branch context requires a branch');
      const context = {
        id: randomUUID(), projectId, branchId: scope === 'branch' ? input.branchId : null,
        label: String(input.label || '').trim().slice(0, 160), value: String(input.value || '').trim().slice(0, 10_000),
        scope, sensitivity, source: String(input.source || 'User').slice(0, 160), createdAt: now()
      };
      if (!context.label || !context.value) throw new Error('Context requires a label and information');
      project.contexts.push(context);
      addEvent(project, 'context', `${context.label} added at ${scope} scope.`);
    });
  }

  async function inheritedContexts(projectId, branchId, { includePrivate = false } = {}) {
    const project = await readRaw(projectId);
    return project ? inherited(project, branchId, includePrivate) : [];
  }

  async function replaceReasoningProposals(projectId, items = []) {
    return mutate(projectId, (project) => {
      const confirmed = new Set(project.reasoning.filter((item) => item.status === 'confirmed').map((item) => `${item.kind}:${item.title.trim().toLowerCase()}`));
      project.reasoning = project.reasoning.filter((item) => item.status !== 'proposed');
      for (const item of items.slice(0, 12)) {
        if (!REASONING_KINDS.has(item.kind) || !item.title?.trim() || !item.summary?.trim()) continue;
        if (confirmed.has(`${item.kind}:${item.title.trim().toLowerCase()}`)) continue;
        const timestamp = now();
        project.reasoning.push({
          id: randomUUID(), projectId, branchId: project.branches.some((branch) => branch.id === item.branchId) ? item.branchId : null,
          kind: item.kind, title: item.title.trim().slice(0, 100), summary: item.summary.trim().slice(0, 500), status: 'proposed',
          sourceLabel: String(item.sourceLabel || 'Threadline analysis').slice(0, 160),
          confidence: ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : null,
          createdBy: item.createdBy === 'user' ? 'user' : 'model', createdAt: timestamp, updatedAt: timestamp
        });
      }
      addEvent(project, 'reasoning', 'Reasoning focus refreshed; interpretive items are awaiting review.');
    });
  }

  async function resolveReasoningItem(projectId, itemId, status) {
    if (!['confirmed', 'rejected'].includes(status)) throw new Error('Reasoning item must be confirmed or rejected');
    return mutate(projectId, (project) => {
      const item = project.reasoning.find((entry) => entry.id === itemId);
      if (!item) return null;
      item.status = status;
      item.updatedAt = now();
      addEvent(project, 'reasoning', `${item.title} ${status === 'confirmed' ? 'confirmed' : 'dismissed'}.`);
    });
  }

  async function addReasoningChallenge(projectId) {
    return mutate(projectId, (project) => {
      if (project.reasoning.some((item) => item.kind === 'counterpoint' && item.status === 'proposed')) return;
      const timestamp = now();
      project.reasoning.push({
        id: randomUUID(), projectId, branchId: null, kind: 'counterpoint', title: 'What would make the preferred path fail?',
        summary: `Look for a case where “${project.intent.objective}” conflicts with behavior that must be preserved. Identify the smallest test or source that could disprove the current direction.`,
        status: 'proposed', sourceLabel: 'Project intent · generated challenge', confidence: 'medium', createdBy: 'model', createdAt: timestamp, updatedAt: timestamp
      });
      addEvent(project, 'reasoning', 'Added a counterpoint to challenge the current frame.');
    });
  }

  function checkpoint(project, name) {
    const snapshot = clone({
      name: project.name,
      repoPath: project.repoPath,
      intent: project.intent,
      repository: project.repository,
      branches: project.branches,
      contexts: project.contexts,
      reasoning: project.reasoning
    });
    project.checkpoints.unshift({ id: randomUUID(), projectId: project.id, name, snapshot, createdAt: now() });
    project.checkpoints = project.checkpoints.slice(0, 30);
  }

  async function createCheckpoint(projectId, name = 'Manual checkpoint') {
    return mutate(projectId, (project) => {
      checkpoint(project, String(name || 'Manual checkpoint').slice(0, 160));
      addEvent(project, 'checkpoint', `${name || 'Manual checkpoint'} created.`);
    });
  }

  async function restoreCheckpoint(projectId, checkpointId) {
    return mutate(projectId, (project) => {
      const selected = project.checkpoints.find((item) => item.id === checkpointId);
      if (!selected?.snapshot) return null;
      const snapshot = clone(selected.snapshot);
      project.name = snapshot.name;
      project.repoPath = snapshot.repoPath;
      project.intent = snapshot.intent;
      project.repository = snapshot.repository;
      project.branches = snapshot.branches;
      project.contexts = snapshot.contexts;
      project.reasoning = snapshot.reasoning || [];
      addEvent(project, 'restore', `Restored ${selected.name}; the checkpoint remains available.`);
    });
  }

  async function mergeBranch(projectId, sourceId, targetId, acceptedIds = []) {
    return mutate(projectId, (project) => {
      const source = project.branches.find((branch) => branch.id === sourceId);
      const target = project.branches.find((branch) => branch.id === targetId);
      if (!source || !target) throw new Error('Source or target branch not found');
      const accepted = (source.output.changes || []).filter((change) => acceptedIds.includes(change.id));
      if (!accepted.length) throw new Error('Select at least one change to merge');
      checkpoint(project, `Before merging ${source.name}`);
      target.output = {
        ...target.output,
        summary: `${target.output.summary || ''}\nMerged ${accepted.length} change${accepted.length === 1 ? '' : 's'} from ${source.name}.`.trim(),
        changes: [...(target.output.changes || []), ...accepted.map((change) => ({ ...change, mergedFrom: source.id }))]
      };
      target.updatedAt = now();
      source.status = 'merged';
      source.updatedAt = now();
      addEvent(project, 'merge', `Merged ${accepted.length} selected changes from ${source.name} into ${target.name}.`);
    });
  }

  async function createAgentRun(projectId, branchId, input) {
    let created;
    await mutate(projectId, (project) => {
      const branch = project.branches.find((item) => item.id === branchId);
      if (!branch) throw new Error('Branch not found');
      if (project.agentRuns.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length >= 5) throw new Error('This project already has five active agent runs');
      if (project.agentRuns.some((run) => run.branchId === branchId && ACTIVE_RUN_STATUSES.has(run.status))) throw new Error('This branch already has an active agent run');
      const timestamp = now();
      created = normalizeRun({
        id: input.id || randomUUID(), projectId, branchId, adapter: input.adapter || 'codex', status: 'queued',
        task: input.task, worktreePath: input.worktreePath || '', baseCommit: input.baseCommit || null,
        sandboxName: input.sandboxName || null, commandId: input.commandId || null, createdAt: timestamp, updatedAt: timestamp
      });
      project.agentRuns.unshift(created);
      branch.status = 'active';
      branch.updatedAt = timestamp;
      addEvent(project, 'agent', `Queued ${created.adapter === 'codex' ? 'Codex' : created.adapter} for a focused run.`);
    });
    return clone(created);
  }

  async function getAgentRun(projectId, runId) {
    const project = await readRaw(projectId);
    const run = project?.agentRuns.find((item) => item.id === runId);
    return run ? clone(run) : null;
  }

  async function updateAgentRun(projectId, runId, updates) {
    let updated;
    await mutate(projectId, (project) => {
      const run = project.agentRuns.find((item) => item.id === runId);
      if (!run) return null;
      const timestamp = now();
      Object.assign(run, updates, { updatedAt: timestamp });
      if (run.status === 'running' && !run.startedAt) run.startedAt = timestamp;
      if (TERMINAL_RUN_STATUSES.has(run.status) && !run.endedAt) run.endedAt = timestamp;
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        const branch = project.branches.find((item) => item.id === run.branchId);
        if (branch) { branch.status = 'review'; branch.updatedAt = timestamp; }
      }
      updated = clone(run);
    });
    return updated || null;
  }

  async function addAgentRunEvent(projectId, runId, kind, message, payload = {}) {
    let eventId = null;
    await mutate(projectId, (project) => {
      const run = project.agentRuns.find((item) => item.id === runId);
      if (!run) return null;
      eventId = project.nextEventId || 1;
      project.nextEventId = eventId + 1;
      run.events ||= [];
      run.events.push({ id: eventId, kind, message: String(message || kind).slice(0, 4_000), payload, createdAt: now() });
      run.events = run.events.slice(-600);
    });
    return eventId;
  }

  async function appendAgentRunEvents(projectId, runId, events, eventCursor) {
    return mutate(projectId, (project) => {
      const run = project.agentRuns.find((item) => item.id === runId);
      if (!run || Number(eventCursor) <= Number(run.eventCursor || 0)) return;
      run.events ||= [];
      for (const event of events) {
        const id = project.nextEventId || 1;
        project.nextEventId = id + 1;
        run.events.push({
          id, kind: event.kind || 'progress', message: String(event.message || event.kind || 'progress').slice(0, 4_000),
          payload: event.payload || {}, createdAt: now()
        });
      }
      run.events = run.events.slice(-600);
      run.eventCursor = Number(eventCursor) || run.eventCursor || 0;
      run.updatedAt = now();
    });
  }

  async function listAgentRunEvents(projectId, runId, after = 0) {
    const run = await getAgentRun(projectId, runId);
    return run ? (run.events || []).filter((event) => event.id > (Number(after) || 0)).slice(0, 200) : null;
  }

  async function createAttentionItem(projectId, input) {
    let item;
    await mutate(projectId, (project) => {
      const existing = input.runId ? project.attentionItems.find((entry) => entry.runId === input.runId && entry.kind === input.kind && entry.status === 'open') : null;
      if (existing) { item = clone(existing); return; }
      item = {
        id: randomUUID(), projectId, branchId: input.branchId || null, runId: input.runId || null,
        kind: input.kind || 'decision', severity: input.severity === 'high' ? 'high' : 'normal',
        title: String(input.title || 'Review required').slice(0, 200), detail: String(input.detail || '').slice(0, 4_000),
        status: 'open', createdAt: now(), resolvedAt: null
      };
      project.attentionItems.unshift(item);
    });
    return item;
  }

  async function resolveAttentionItem(projectId, itemId) {
    return mutate(projectId, (project) => {
      const item = project.attentionItems.find((entry) => entry.id === itemId);
      if (!item) return null;
      item.status = 'resolved';
      item.resolvedAt = now();
      addEvent(project, 'attention', `${item.title} resolved.`);
    });
  }

  return {
    mode: 'cloud',
    close: () => pool.end(),
    listProjects, getProject, createProject, updateIntent, updateRepositorySnapshot,
    createBranch, updateBranch, createContext, inheritedContexts,
    replaceReasoningProposals, resolveReasoningItem, addReasoningChallenge,
    createCheckpoint, restoreCheckpoint, mergeBranch,
    createAgentRun, getAgentRun, updateAgentRun, addAgentRunEvent, appendAgentRunEvents, listAgentRunEvents,
    createAttentionItem, resolveAttentionItem,
    recoverInterruptedRuns: async () => 0,
    seedDemo: async () => {}
  };
}
