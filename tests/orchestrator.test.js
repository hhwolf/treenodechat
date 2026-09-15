import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPath, createOrchestrator } from '../server/orchestrator.js';
import { createStore } from '../server/store.js';

function textPayload(text) {
  return { output_text: text, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] };
}

function callPayload(name, args, callId = 'call-1') {
  return { output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId }] };
}

function scriptedFetch(pages, requests = []) {
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const page = pages.shift();
    if (!page) throw new Error('Fake model ran out of scripted responses');
    return { ok: true, status: 200, json: async () => page };
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

function setup(t, pages, runtimeOverrides = {}, options = {}) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const project = store.createProject({ name: 'Chat project', repoPath: '/tmp/repo', brief: 'Chat-first orchestration' });
  const agentRuntime = {
    start: (projectId, branchId, task) => store.createAgentRun(projectId, branchId, { adapter: 'test', task, worktreePath: '/tmp/x' }),
    refresh: async () => {},
    verify: (projectId, runId) => store.updateAgentRun(projectId, runId, { verification: { command: 'npm test', status: 'running', mode: 'worktree' } }),
    integrate: async (projectId, runId, input) => ({ integration: { commit: 'commit9', branchName: 'threadline/chat', files: input.filePaths } }),
    ...runtimeOverrides
  };
  const fetchImpl = scriptedFetch(pages);
  const orchestrator = createOrchestrator(store, { agentRuntime, ship: options.ship, fetchImpl, apiKey: 'test-key', model: 'test-model' });
  return { store, project, orchestrator, fetchImpl };
}

test('answers a plain message with project context and no tools executed', async (t) => {
  const { store, project, orchestrator, fetchImpl } = setup(t, [textPayload('Here is the plan.')]);
  const userNode = store.appendChatNode(project.id, { role: 'user', content: 'What should we do first?' });
  const turn = await orchestrator.runChatTurn(project.id, userNode);

  assert.equal(turn.source, 'model');
  assert.equal(turn.content, 'Here is the plan.');
  assert.deepEqual(turn.actions, []);
  assert.deepEqual(turn.directions, []);
  const request = fetchImpl.requests[0].body;
  assert.match(request.instructions, /orchestrator for the project "Chat project"/);
  assert.match(request.instructions, /### CLAUDE\.md/);
  assert.match(request.instructions, /Autonomy: DIRECT/);
  assert.ok(request.tools.some((tool) => tool.name === 'start_agent_run'));
  assert.deepEqual(request.input.at(-1), { role: 'user', content: 'What should we do first?' });
});

test('starts an agent run on an auto-created engine branch and reports back', async (t) => {
  const { store, project, orchestrator, fetchImpl } = setup(t, [
    callPayload('start_agent_run', { task: 'Add a retry helper to the client' }),
    textPayload('Started a run for the retry helper; I will check on it.')
  ]);
  const userNode = store.appendChatNode(project.id, { role: 'user', content: 'Add retry logic' });
  const turn = await orchestrator.runChatTurn(project.id, userNode);

  assert.equal(turn.actions.length, 1);
  assert.equal(turn.actions[0].tool, 'start_agent_run');
  assert.equal(turn.actions[0].status, 'started');
  assert.ok(turn.actions[0].runId);
  assert.ok(turn.engineBranchId);

  const updated = store.getProject(project.id);
  const branch = updated.branches.find((item) => item.id === turn.engineBranchId);
  assert.equal(branch.name, 'Add a retry helper to the');
  const run = store.getAgentRun(project.id, turn.actions[0].runId);
  assert.equal(run.nodeId, turn.assistantNodeId);
  assert.equal(run.task, 'Add a retry helper to the client');

  const second = fetchImpl.requests[1].body;
  const callItem = second.input.find((item) => item.type === 'function_call');
  const outputItem = second.input.find((item) => item.type === 'function_call_output');
  assert.equal(callItem.name, 'start_agent_run');
  assert.match(outputItem.output, /"runId"/);
  assert.match(outputItem.output, /background/);
});

test('presents normalized directions and ends the turn', async (t) => {
  const { store, project, orchestrator, fetchImpl } = setup(t, [
    callPayload('propose_directions', {
      directions: [
        { label: 'Deep research', summary: 'Study existing solvers and derive ranges from first principles.' },
        { label: 'Practical build', summary: 'Ship a minimal trainer now and iterate.' },
        { label: '', summary: 'dropped' }
      ],
      recommendedLabel: 'Practical build'
    })
  ]);
  const userNode = store.appendChatNode(project.id, { role: 'user', content: 'How should we approach the trainer?' });
  const turn = await orchestrator.runChatTurn(project.id, userNode);

  assert.equal(turn.directions.length, 2);
  assert.equal(turn.directions.find((item) => item.label === 'Practical build').recommended, true);
  assert.equal(turn.directions.find((item) => item.label === 'Deep research').recommended, false);
  assert.equal(turn.content, 'Choose a direction below to continue.');
  assert.equal(fetchImpl.requests.length, 1);
});

test('records ship proposals as needing approval without executing anything', async (t) => {
  let shipped = false;
  const { store, project, orchestrator } = setup(t, [
    callPayload('trigger_deployment', { ref: 'threadline/chat' }),
    textPayload('I proposed a production deployment; approve it in the card above.')
  ], { integrate: async () => { shipped = true; throw new Error('must not run'); } });
  const userNode = store.appendChatNode(project.id, { role: 'user', content: 'Deploy it' });
  const turn = await orchestrator.runChatTurn(project.id, userNode);

  assert.equal(shipped, false);
  assert.equal(turn.actions.length, 1);
  assert.equal(turn.actions[0].tool, 'trigger_deployment');
  assert.equal(turn.actions[0].status, 'needs_approval');
  assert.deepEqual(turn.actions[0].args, { ref: 'threadline/chat' });
  assert.match(turn.content, /approve/i);
});

test('forces a final no-tool round when the model keeps calling tools', async (t) => {
  const pages = [];
  for (let index = 0; index < 4; index += 1) pages.push(callPayload('get_run_status', { runId: 'missing' }, `call-${index}`));
  pages.push({
    output_text: 'Ran out of budget; here is where things stand.',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Ran out of budget; here is where things stand.' }] },
      { type: 'function_call', name: 'suggest_next_steps', arguments: JSON.stringify({ steps: [{ label: 'Check the run', prompt: 'Check on run [id] and summarize it.' }, { label: 'Plan next', prompt: 'What should we do next?' }] }), call_id: 'call-final' }
    ]
  });
  const { store, project, orchestrator, fetchImpl } = setup(t, pages);
  const userNode = store.appendChatNode(project.id, { role: 'user', content: 'Loop forever' });
  const turn = await orchestrator.runChatTurn(project.id, userNode);

  assert.equal(turn.content, 'Ran out of budget; here is where things stand.');
  assert.equal(turn.actions.length, 4);
  assert.ok(turn.actions.every((action) => action.status === 'error'));
  const finalRequest = fetchImpl.requests.at(-1).body;
  assert.equal(finalRequest.tools.length, 1);
  assert.equal(finalRequest.tools[0].name, 'suggest_next_steps');
  assert.match(finalRequest.input.at(-1).content, /Wrap up now/);
  assert.equal(turn.nextSteps.length, 2);
  assert.equal(turn.nextSteps[0].label, 'Check the run');
});

test('falls back to a deterministic local reply without a configured model', async (t) => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const project = store.createProject({ name: 'Offline', brief: 'No key' });
  const orchestrator = createOrchestrator(store, { agentRuntime: {}, fetchImpl: async () => { throw new Error('no fetch'); }, apiKey: '', model: '' });
  const userNode = store.appendChatNode(project.id, { role: 'user', content: 'Hello there' });
  const turn = await orchestrator.runChatTurn(project.id, userNode);
  assert.equal(turn.source, 'local');
  assert.match(turn.content, /not configured/);
  assert.match(turn.content, /Hello there/);
});

test('collects the path from root to leaf and reuses the nearest engine branch', async (t) => {
  const { store, project, orchestrator, fetchImpl } = setup(t, [textPayload('Continuing on the same lane.')]);
  const root = store.appendChatNode(project.id, { role: 'user', content: 'Start' });
  const reply = store.appendChatNode(project.id, { role: 'assistant', parentId: root.id, content: 'Working on it.', engineBranchId: project.branches[0].id });
  const followUp = store.appendChatNode(project.id, { role: 'user', parentId: reply.id, content: 'Keep going' });

  const path = collectPath(store.getProject(project.id).chatNodes, followUp.id);
  assert.deepEqual(path.map((node) => node.id), [root.id, reply.id, followUp.id]);

  const turn = await orchestrator.runChatTurn(project.id, followUp);
  assert.equal(turn.engineBranchId, project.branches[0].id);
  const request = fetchImpl.requests[0].body;
  assert.equal(request.input.length, 3);
  assert.equal(request.input[1].role, 'assistant');
});

test('captures suggested next steps without recording actions and normalizes them', async (t) => {
  const steps = [
    { label: 'Refine the rules', prompt: 'Update CLAUDE.md to require [convention].' },
    { label: 'Run an agent', prompt: 'Run an agent to add [feature] and verify it.' },
    { label: 'Verify', prompt: 'Verify the latest run with the tests.' },
    { label: 'Ship', prompt: 'Open a pull request for the accepted work.' },
    { label: 'Extra', prompt: 'One over the cap.' },
    { label: 'No prompt here' }
  ];
  const { store, project, orchestrator, fetchImpl } = setup(t, [
    callPayload('suggest_next_steps', { steps }),
    textPayload('Here is my answer, with follow-ups attached.')
  ]);
  const userNode = store.appendChatNode(project.id, { role: 'user', content: 'What now?' });
  const turn = await orchestrator.runChatTurn(project.id, userNode);

  assert.equal(turn.actions.length, 0);
  assert.equal(turn.nextSteps.length, 4);
  assert.equal(turn.nextSteps[0].prompt, 'Update CLAUDE.md to require [convention].');
  assert.ok(turn.nextSteps.every((step) => step.id && step.label && step.prompt));
  const second = fetchImpl.requests[1].body;
  assert.match(second.input.find((item) => item.type === 'function_call_output').output, /noted/);
});

test('suppresses next steps when directions are proposed', async (t) => {
  const { store, project, orchestrator } = setup(t, [{
    output: [
      { type: 'function_call', name: 'propose_directions', arguments: JSON.stringify({ directions: [{ label: 'Deep', summary: 'Go deep.' }, { label: 'Fast', summary: 'Go fast.' }], recommendedLabel: 'Fast' }), call_id: 'call-d' },
      { type: 'function_call', name: 'suggest_next_steps', arguments: JSON.stringify({ steps: [{ label: 'Also this', prompt: 'Should be suppressed.' }] }), call_id: 'call-s' }
    ]
  }]);
  const userNode = store.appendChatNode(project.id, { role: 'user', content: 'Which way?' });
  const turn = await orchestrator.runChatTurn(project.id, userNode);
  assert.equal(turn.directions.length, 2);
  assert.deepEqual(turn.nextSteps, []);
});

test('direct mode opens pull requests itself but still gates the release', async (t) => {
  const shipCalls = [];
  const ship = {
    createPullRequest: async (project, input) => { shipCalls.push(input); return { number: 12, url: 'https://github.com/o/r/pull/12', title: input.title }; }
  };
  const { store, project, orchestrator } = setup(t, [
    callPayload('create_pull_request', { title: 'Ship the drill summary' }),
    callPayload('ship_release', { title: 'Release the drill summary' }, 'call-2'),
    textPayload('Pull request opened; approve the release card to go live.')
  ], {}, { ship });
  const userNode = store.appendChatNode(project.id, { role: 'user', content: 'Ship it' });
  const turn = await orchestrator.runChatTurn(project.id, userNode);

  assert.equal(shipCalls.length, 1);
  assert.equal(shipCalls[0].title, 'Ship the drill summary');
  const prAction = turn.actions.find((action) => action.tool === 'create_pull_request');
  assert.equal(prAction.status, 'done');
  assert.match(prAction.result, /#12/);
  const releaseAction = turn.actions.find((action) => action.tool === 'ship_release');
  assert.equal(releaseAction.status, 'needs_approval');
});

test('review mode proposes pull requests instead of opening them', async (t) => {
  const ship = { createPullRequest: async () => { throw new Error('must not run'); } };
  const { store, project, orchestrator, fetchImpl } = setup(t, [
    callPayload('create_pull_request', { title: 'Careful now' }),
    textPayload('I proposed the pull request for your approval.')
  ], {}, { ship });
  store.updateProjectSettings(project.id, { autonomy: 'review' });
  const userNode = store.appendChatNode(project.id, { role: 'user', content: 'Open a PR' });
  const turn = await orchestrator.runChatTurn(project.id, userNode);

  assert.match(fetchImpl.requests[0].body.instructions, /Autonomy: REVIEW/);
  assert.equal(turn.actions[0].tool, 'create_pull_request');
  assert.equal(turn.actions[0].status, 'needs_approval');
});
