import { randomUUID } from 'node:crypto';
import { normalizeChatDirections, taskBranchName } from './store.js';
import { formatRulesSection } from './documents.js';
import { repositoryContext } from './repository.js';

const MAX_TOOL_ROUNDS = 4;
const TURN_BUDGET_MS = 120_000;
const INTEGRATE_BUDGET_MS = 90_000;
const SHIP_TOOLS = new Set(['create_pull_request', 'merge_pull_request', 'trigger_deployment', 'rollback_deployment', 'set_env_var']);

const TOOLS = [
  {
    type: 'function', name: 'start_agent_run',
    description: 'Start an isolated coding-agent run on this conversation branch. Returns immediately; the run continues in the background.',
    parameters: { type: 'object', properties: { task: { type: 'string', description: 'One concrete, verifiable objective for the agent.' } }, required: ['task'], additionalProperties: false }
  },
  {
    type: 'function', name: 'get_run_status',
    description: 'Check the current status, summary, changed files, and verification state of an agent run.',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false }
  },
  {
    type: 'function', name: 'verify_run',
    description: 'Run the project verify command (tests) against a completed run. Starts in the background.',
    parameters: { type: 'object', properties: { runId: { type: 'string' }, command: { type: 'string', description: 'Optional one-off command override.' } }, required: ['runId'], additionalProperties: false }
  },
  {
    type: 'function', name: 'integrate_run',
    description: 'Commit selected whole files from a completed run onto the Threadline project branch (safe, reversible, never the default branch).',
    parameters: { type: 'object', properties: { runId: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, commitMessage: { type: 'string' } }, required: ['runId', 'files', 'commitMessage'], additionalProperties: false }
  },
  {
    type: 'function', name: 'propose_directions',
    description: 'Offer the user 2-3 genuinely different directions to branch the conversation. Use ONLY at open decisions where directions differ materially; include your reasoning in each summary.',
    parameters: {
      type: 'object',
      properties: {
        directions: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, summary: { type: 'string' } }, required: ['label', 'summary'], additionalProperties: false } },
        recommendedLabel: { type: 'string' }
      },
      required: ['directions', 'recommendedLabel'], additionalProperties: false
    }
  },
  {
    type: 'function', name: 'create_pull_request',
    description: 'Propose opening a pull request from the Threadline project branch into the default branch. Requires explicit user approval.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'], additionalProperties: false }
  },
  {
    type: 'function', name: 'merge_pull_request',
    description: 'Propose merging an open pull request. Requires explicit user approval.',
    parameters: { type: 'object', properties: { number: { type: 'number' } }, required: ['number'], additionalProperties: false }
  },
  {
    type: 'function', name: 'trigger_deployment',
    description: 'Propose a Vercel production deployment of the project. Requires explicit user approval.',
    parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Git branch or ref to deploy.' } }, required: ['ref'], additionalProperties: false }
  },
  {
    type: 'function', name: 'rollback_deployment',
    description: 'Propose rolling production back to a previous deployment. Requires explicit user approval.',
    parameters: { type: 'object', properties: { deploymentId: { type: 'string' } }, required: ['deploymentId'], additionalProperties: false }
  },
  {
    type: 'function', name: 'set_env_var',
    description: 'Propose adding an environment variable to the Vercel project. Never include the value; the user enters it in the approval card.',
    parameters: { type: 'object', properties: { key: { type: 'string' }, target: { type: 'array', items: { type: 'string', enum: ['production', 'preview', 'development'] } } }, required: ['key'], additionalProperties: false }
  }
];

function extractText(payload) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const parts = (payload.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text);
  return parts.join('\n').trim();
}

export function collectPath(chatNodes = [], leafId) {
  const byId = new Map(chatNodes.map((node) => [node.id, node]));
  const path = [];
  let cursor = byId.get(leafId);
  while (cursor && path.length < 1_000) {
    path.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
  }
  return path;
}

function pathMessages(project, path) {
  const byId = new Map(project.chatNodes.map((node) => [node.id, node]));
  return path.slice(-40).map((node) => {
    if (node.role === 'assistant') {
      const directions = node.directions?.length ? `\n[Directions offered: ${node.directions.map((item) => item.label).join(' | ')}]` : '';
      return { role: 'assistant', content: `${node.content}${directions}`.slice(0, 4_000) };
    }
    if (node.role === 'notice') return { role: 'user', content: `[Update] ${node.content}`.slice(0, 4_000) };
    const direction = node.directionId ? byId.get(node.parentId)?.directions?.find((item) => item.id === node.directionId) : null;
    const prefix = direction ? `[Chose direction: ${direction.label}] ` : '';
    return { role: 'user', content: `${prefix}${node.content}`.slice(0, 4_000) };
  });
}

function runsDigest(project, engineBranchId) {
  const runs = project.agentRuns
    .filter((run) => !engineBranchId || run.branchId === engineBranchId)
    .slice(0, 3)
    .map((run) => ({
      runId: run.id, status: run.status, task: (run.task || '').slice(0, 200), summary: (run.summary || '').slice(0, 400),
      files: (run.files || []).slice(0, 20),
      verification: run.verification ? { status: run.verification.status, command: run.verification.command } : null,
      integratedCommit: run.integration?.commit || null
    }));
  return runs.length ? `Recent agent runs on this thread:\n${JSON.stringify(runs)}` : 'No agent runs on this thread yet.';
}

function buildSystemPrompt(project, engineBranchId) {
  const repository = repositoryContext(project.repository);
  return [
    `You are Threadline, the orchestrator for the project "${project.name}". You converse with the user and get real work done by deploying coding agents and tools. Be concrete, honest about uncertainty, and concise.`,
    `Tool policy:
- start_agent_run for any code change or investigation that needs the repository; keep each task narrow and verifiable. Runs continue in the background — never claim results you have not read via get_run_status, and never fabricate run output.
- verify_run after a run completes when tests would add confidence; integrate_run only for reviewed changes the user asked to accept.
- create_pull_request / merge_pull_request / trigger_deployment / rollback_deployment / set_env_var only PROPOSE the action; each requires the user's explicit approval in the interface. Say clearly what you proposed and why.
- propose_directions only at genuinely open decisions where 2-3 directions differ materially (for example a deep-research path versus a practical build path). Give reasoning in each summary and recommend one. Otherwise just answer.`,
    `Project intent:
Objective: ${project.intent.objective}
Desired outcome: ${project.intent.outcome}
Quality bar: ${project.intent.qualityBar}
Avoid: ${project.intent.avoid}`,
    formatRulesSection(project.documents, 6_000),
    repository ? `Repository context: ${JSON.stringify(repository).slice(0, 6_000)}` : 'No repository is connected yet; suggest connecting one before starting agents.',
    runsDigest(project, engineBranchId),
    'Never expose chain-of-thought; share conclusions, evidence, assumptions, and uncertainty instead.'
  ].filter(Boolean).join('\n\n');
}

function localFallback(project, userNode) {
  return {
    source: 'local',
    content: `The model provider is not configured, so I cannot orchestrate this yet. Set OPENAI_API_KEY and OPENAI_MODEL, then resend your message.\n\nWhat I can already see: the project intent is "${project.intent.objective}", ${project.documents.length} rules document${project.documents.length === 1 ? '' : 's'} and ${project.agentRuns.length} agent run${project.agentRuns.length === 1 ? '' : 's'} are stored. Your message was: "${userNode.content.slice(0, 200)}"`,
    directions: [],
    actions: [],
    engineBranchId: null,
    assistantNodeId: randomUUID()
  };
}

export function createOrchestrator(store, {
  agentRuntime,
  fetchImpl = fetch,
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_MODEL || 'gpt-5.6-sol',
  reasoningEffort = process.env.OPENAI_REASONING_EFFORT || 'medium'
} = {}) {
  async function ensureEngineBranch(project, state, task) {
    if (state.engineBranchId) return state.engineBranchId;
    const parent = project.branches.find((branch) => !branch.parentId) || project.branches[0];
    const name = taskBranchName(task, project.branches.map((branch) => branch.name));
    const updated = await store.createBranch(project.id, { parentId: parent.id, name, purpose: String(task).slice(0, 2_000) });
    state.engineBranchId = updated.branches.find((branch) => branch.name === name).id;
    return state.engineBranchId;
  }

  async function executeTool(project, state, call) {
    let args = {};
    try { args = JSON.parse(call.arguments || '{}'); } catch { /* treated as empty arguments below */ }
    if (call.name === 'set_env_var') args = { key: args.key, target: args.target };
    const record = {
      id: randomUUID(), tool: call.name, args: JSON.stringify(args).length > 2_000 ? {} : args,
      status: 'done', runId: null, result: '', createdAt: new Date().toISOString()
    };
    state.actions.push(record);
    try {
      if (call.name === 'start_agent_run') {
        const task = String(args.task || '').trim().slice(0, 4_000);
        if (!task) throw new Error('task is required');
        const branchId = await ensureEngineBranch(project, state, task);
        const run = await agentRuntime.start(project.id, branchId, task);
        await store.updateAgentRun(project.id, run.id, { nodeId: state.assistantNodeId });
        record.status = 'started';
        record.runId = run.id;
        record.result = `run ${run.id} started`;
        return { runId: run.id, status: 'running', note: 'The run continues in the background. Use get_run_status to check on it later; do not wait or guess its outcome.' };
      }
      if (call.name === 'get_run_status') {
        await agentRuntime.refresh?.(project.id, String(args.runId || ''));
        const run = await store.getAgentRun(project.id, String(args.runId || ''));
        if (!run) throw new Error('run not found');
        record.runId = run.id;
        record.result = run.status;
        return {
          runId: run.id, status: run.status, summary: (run.summary || '').slice(0, 1_000),
          files: (run.files || []).slice(0, 20), exitCode: run.exitCode,
          verification: run.verification ? { status: run.verification.status, command: run.verification.command, exitCode: run.verification.exitCode } : null
        };
      }
      if (call.name === 'verify_run') {
        const run = await agentRuntime.verify(project.id, String(args.runId || ''), args.command ? { command: String(args.command) } : {});
        record.status = 'started';
        record.runId = run.id;
        record.result = `verification started: ${run.verification?.command || ''}`;
        return { runId: run.id, verification: 'running', note: 'Verification runs in the background; check with get_run_status.' };
      }
      if (call.name === 'integrate_run') {
        const runId = String(args.runId || '');
        record.runId = runId;
        const pending = agentRuntime.integrate(project.id, runId, {
          filePaths: Array.isArray(args.files) ? args.files : [],
          commitMessage: String(args.commitMessage || '').slice(0, 200)
        });
        const outcome = await Promise.race([
          Promise.resolve(pending).then((result) => ({ result })),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), INTEGRATE_BUDGET_MS))
        ]);
        if (outcome.timeout) {
          Promise.resolve(pending).catch(() => {});
          record.status = 'started';
          record.result = 'integration still running';
          return { status: 'integration_running', note: 'Integration is taking a while; check the run again shortly.' };
        }
        record.result = `integrated as ${outcome.result.integration.commit}`;
        return { commit: outcome.result.integration.commit, branch: outcome.result.integration.branchName, files: outcome.result.integration.files };
      }
      if (call.name === 'propose_directions') {
        const directions = normalizeChatDirections((Array.isArray(args.directions) ? args.directions : [])
          .map((item) => ({ ...item, recommended: item?.label === args.recommendedLabel })));
        if (directions.length < 2) throw new Error('Provide 2 or 3 distinct directions with labels and summaries');
        state.directions = directions;
        state.terminal = true;
        record.result = directions.map((item) => item.label).join(' | ');
        return { status: 'directions_presented', note: 'The user will pick a direction in the interface. Finish your reply with brief framing text only.' };
      }
      if (SHIP_TOOLS.has(call.name)) {
        record.status = 'needs_approval';
        record.result = 'awaiting user approval';
        return { status: 'needs_user_approval', note: 'This action is external and requires the user to approve it in the interface. Explain what you proposed and why, then wait.' };
      }
      throw new Error(`Unknown tool ${call.name}`);
    } catch (error) {
      record.status = 'error';
      record.result = String(error.message || error).slice(0, 2_000);
      return { error: record.result };
    }
  }

  async function runChatTurn(projectId, userNode) {
    const project = await store.getProject(projectId);
    if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
    if (!apiKey || !model) return localFallback(project, userNode);
    const path = collectPath(project.chatNodes, userNode.id);
    const state = {
      assistantNodeId: randomUUID(),
      actions: [],
      directions: [],
      terminal: false,
      engineBranchId: [...path].reverse().find((node) => node.engineBranchId)?.engineBranchId || null
    };
    const system = buildSystemPrompt(project, state.engineBranchId);
    const input = pathMessages(project, path);
    const startedAt = Date.now();
    let text = '';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const finalRound = round === MAX_TOOL_ROUNDS || state.terminal || Date.now() - startedAt > TURN_BUDGET_MS;
      if (finalRound && round > 0) input.push({ role: 'user', content: '[Wrap up now: summarize what you did and what is pending. Do not call tools.]' });
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, instructions: system, input, store: false,
          reasoning: { effort: reasoningEffort },
          ...(finalRound ? {} : { tools: TOOLS, tool_choice: 'auto' })
        })
      });
      if (!response.ok) throw new Error(`Model provider returned ${response.status}`);
      const payload = await response.json();
      const calls = (payload.output || []).filter((item) => item.type === 'function_call');
      text = extractText(payload) || text;
      if (!calls.length || finalRound) break;
      for (const call of calls) {
        input.push({ type: 'function_call', name: call.name, arguments: call.arguments, call_id: call.call_id });
        const result = await executeTool(project, state, call);
        input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
      }
      if (state.terminal) break;
    }

    return {
      source: 'model',
      content: text || (state.directions.length ? 'Choose a direction below to continue.' : 'Done — see the actions above.'),
      directions: state.directions,
      actions: state.actions,
      engineBranchId: state.engineBranchId,
      assistantNodeId: state.assistantNodeId
    };
  }

  return { runChatTurn };
}
