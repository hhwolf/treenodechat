import { analyzeBranch, draftReasoning, draftSpec } from './spec.js';
import { inspectRepository } from './repository.js';

const json = (response, status, payload) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
};

const readBody = async (request) => {
  let value = '';
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 1_000_000) throw new Error('Request body is too large');
  }
  return value ? JSON.parse(value) : {};
};

export function createApiHandler(store, { agentRuntime, repositoryInspector = inspectRepository } = {}) {
  return async function apiHandler(request, response) {
    const url = new URL(request.url, 'http://threadline.local');
    if (!url.pathname.startsWith('/api/')) return false;

    try {
      if (request.method === 'POST' || request.method === 'PATCH') {
        const origin = request.headers.origin;
        if (origin) {
          let hostname = '';
          try { hostname = new URL(origin).hostname; } catch { /* rejected below */ }
          const requestHost = String(request.headers.host || '').split(':')[0];
          if (hostname !== requestHost && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
            json(response, 403, { error: 'Cross-origin changes are not allowed' });
            return true;
          }
        }
        if (!request.headers['content-type']?.startsWith('application/json')) {
          json(response, 415, { error: 'Changes require application/json' });
          return true;
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, {
          ok: true,
          mode: store.mode || 'local',
          persistence: store.mode === 'cloud' ? 'postgres' : 'sqlite',
          repositoryInput: store.mode === 'cloud' ? 'url' : 'path'
        });
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/adapters') {
        const adapters = agentRuntime ? [await agentRuntime.adapterInfo()] : [];
        json(response, 200, { adapters });
        return true;
      }

      if (url.pathname === '/api/repositories/inspect' && request.method === 'POST') {
        const body = await readBody(request);
        const location = String(body.location || body.repoUrl || body.repoPath || '').trim();
        if (!location) throw new Error('Choose a repository location first');
        json(response, 200, { repository: await repositoryInspector(location) });
        return true;
      }

      if (url.pathname === '/api/projects' && request.method === 'GET') {
        json(response, 200, { projects: await store.listProjects() });
        return true;
      }

      if (url.pathname === '/api/projects' && request.method === 'POST') {
        const body = await readBody(request);
        const spec = await draftSpec({ brief: body.brief });
        const repositoryLocation = String(body.repoUrl || body.repoPath || '').trim();
        const repository = repositoryLocation ? await repositoryInspector(repositoryLocation) : {};
        const project = await store.createProject({ ...body, repoPath: repository.root || repositoryLocation, repository, intent: spec.intent });
        json(response, 201, { project, specSource: spec.source });
        return true;
      }

      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && request.method === 'GET') {
        await agentRuntime?.refreshProject?.(projectMatch[1]);
        const project = await store.getProject(projectMatch[1]);
        json(response, project ? 200 : 404, project ? { project } : { error: 'Project not found' });
        return true;
      }

      const intentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/intent$/);
      if (intentMatch && request.method === 'PATCH') {
        const project = await store.updateIntent(intentMatch[1], await readBody(request));
        json(response, project ? 200 : 404, project ? { project } : { error: 'Project not found' });
        return true;
      }

      const draftMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/specs\/draft$/);
      if (draftMatch && request.method === 'POST') {
        const project = await store.getProject(draftMatch[1]);
        if (!project) {
          json(response, 404, { error: 'Project not found' });
          return true;
        }
        const body = await readBody(request);
        const spec = await draftSpec({ brief: body.brief || project.intent.objective, currentIntent: project.intent });
        json(response, 200, spec);
        return true;
      }

      const reasoningDraftMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reasoning\/draft$/);
      if (reasoningDraftMatch && request.method === 'POST') {
        const project = await store.getProject(reasoningDraftMatch[1]);
        if (!project) {
          json(response, 404, { error: 'Project not found' });
          return true;
        }
        await readBody(request);
        const draft = await draftReasoning(project);
        const updated = await store.replaceReasoningProposals(project.id, draft.items);
        json(response, 200, { project: updated, source: draft.source, warning: draft.warning });
        return true;
      }

      const repositoryScanMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/repository\/scan$/);
      if (repositoryScanMatch && request.method === 'POST') {
        const project = await store.getProject(repositoryScanMatch[1]);
        if (!project) {
          json(response, 404, { error: 'Project not found' });
          return true;
        }
        await readBody(request);
        const repository = await repositoryInspector(project.repoPath);
        const updated = await store.updateRepositorySnapshot(project.id, repository);
        json(response, 200, { project: updated });
        return true;
      }

      const repositoryConnectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/repository$/);
      if (repositoryConnectMatch && request.method === 'PATCH') {
        const project = await store.getProject(repositoryConnectMatch[1]);
        if (!project) {
          json(response, 404, { error: 'Project not found' });
          return true;
        }
        const body = await readBody(request);
        const location = String(body.location || body.repoUrl || body.repoPath || '').trim();
        if (!location) throw new Error('Choose a repository location first');
        const repository = await repositoryInspector(location);
        const updated = await store.updateRepositorySnapshot(project.id, repository);
        json(response, 200, { project: updated });
        return true;
      }

      const reasoningChallengeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reasoning\/challenge$/);
      if (reasoningChallengeMatch && request.method === 'POST') {
        await readBody(request);
        const project = await store.addReasoningChallenge(reasoningChallengeMatch[1]);
        json(response, project ? 200 : 404, project ? { project } : { error: 'Project not found' });
        return true;
      }

      const reasoningItemMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reasoning\/([^/]+)$/);
      if (reasoningItemMatch && request.method === 'PATCH') {
        const body = await readBody(request);
        const project = await store.resolveReasoningItem(reasoningItemMatch[1], reasoningItemMatch[2], body.status);
        json(response, project ? 200 : 404, project ? { project } : { error: 'Reasoning item not found' });
        return true;
      }

      const branchesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/branches$/);
      if (branchesMatch && request.method === 'POST') {
        const project = await store.createBranch(branchesMatch[1], await readBody(request));
        json(response, project ? 201 : 404, project ? { project } : { error: 'Project not found' });
        return true;
      }

      const branchMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/branches\/([^/]+)$/);
      if (branchMatch && request.method === 'PATCH') {
        const project = await store.updateBranch(branchMatch[1], branchMatch[2], await readBody(request));
        json(response, project ? 200 : 404, project ? { project } : { error: 'Branch not found' });
        return true;
      }

      const branchAnalyzeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/branches\/([^/]+)\/analyze$/);
      if (branchAnalyzeMatch && request.method === 'POST') {
        const project = await store.getProject(branchAnalyzeMatch[1]);
        const branch = project?.branches.find((item) => item.id === branchAnalyzeMatch[2]);
        if (!project || !branch) {
          json(response, 404, { error: 'Branch not found' });
          return true;
        }
        await readBody(request);
        const contexts = await store.inheritedContexts(project.id, branch.id);
        const analysis = await analyzeBranch(project, branch, contexts);
        const updated = await store.updateBranch(project.id, branch.id, { status: 'review', output: analysis.output });
        json(response, 200, { project: updated, source: analysis.source, warning: analysis.warning });
        return true;
      }

      const branchRunsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/branches\/([^/]+)\/runs$/);
      if (branchRunsMatch && request.method === 'POST') {
        if (!agentRuntime) {
          json(response, 503, { error: 'No coding-agent adapter is configured' });
          return true;
        }
        const body = await readBody(request);
        const run = await agentRuntime.start(branchRunsMatch[1], branchRunsMatch[2], body.task);
        json(response, 202, { run, project: await store.getProject(branchRunsMatch[1]) });
        return true;
      }

      const runEventsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/events$/);
      if (runEventsMatch && request.method === 'GET') {
        await agentRuntime?.refresh?.(runEventsMatch[1], runEventsMatch[2]);
        const run = await store.getAgentRun(runEventsMatch[1], runEventsMatch[2]);
        const events = run ? await store.listAgentRunEvents(runEventsMatch[1], runEventsMatch[2], url.searchParams.get('after')) : null;
        json(response, events ? 200 : 404, events ? { run, events } : { error: 'Agent run not found' });
        return true;
      }

      const runDiffMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/diff$/);
      if (runDiffMatch && request.method === 'GET') {
        await agentRuntime?.refresh?.(runDiffMatch[1], runDiffMatch[2]);
        const run = await store.getAgentRun(runDiffMatch[1], runDiffMatch[2]);
        json(response, run ? 200 : 404, run ? { runId: run.id, files: run.files, diffStat: run.diffStat, diff: run.diff, worktreePath: run.worktreePath } : { error: 'Agent run not found' });
        return true;
      }

      const runControlMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs\/([^/]+)$/);
      if (runControlMatch && request.method === 'PATCH') {
        if (!agentRuntime) {
          json(response, 503, { error: 'No coding-agent adapter is configured' });
          return true;
        }
        const body = await readBody(request);
        const run = await agentRuntime.control(runControlMatch[1], runControlMatch[2], body.action);
        json(response, 200, { run, project: await store.getProject(runControlMatch[1]) });
        return true;
      }

      const attentionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/attention\/([^/]+)$/);
      if (attentionMatch && request.method === 'PATCH') {
        const body = await readBody(request);
        const project = await store.resolveAttentionItem(attentionMatch[1], attentionMatch[2], body.status);
        json(response, project ? 200 : 404, project ? { project } : { error: 'Attention item not found' });
        return true;
      }

      const contextMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/contexts$/);
      if (contextMatch && request.method === 'GET') {
        const branchId = url.searchParams.get('branchId');
        const contexts = branchId ? await store.inheritedContexts(contextMatch[1], branchId) : (await store.getProject(contextMatch[1]))?.contexts;
        json(response, contexts ? 200 : 404, contexts ? { contexts } : { error: 'Project not found' });
        return true;
      }
      if (contextMatch && request.method === 'POST') {
        const project = await store.createContext(contextMatch[1], await readBody(request));
        json(response, project ? 201 : 404, project ? { project } : { error: 'Project not found' });
        return true;
      }

      const checkpointsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/checkpoints$/);
      if (checkpointsMatch && request.method === 'POST') {
        const body = await readBody(request);
        const project = await store.createCheckpoint(checkpointsMatch[1], body.name);
        json(response, project ? 201 : 404, project ? { project } : { error: 'Project not found' });
        return true;
      }

      const restoreMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/checkpoints\/([^/]+)\/restore$/);
      if (restoreMatch && request.method === 'POST') {
        const project = await store.restoreCheckpoint(restoreMatch[1], restoreMatch[2]);
        json(response, project ? 200 : 404, project ? { project } : { error: 'Checkpoint not found' });
        return true;
      }

      const mergeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/merge$/);
      if (mergeMatch && request.method === 'POST') {
        const body = await readBody(request);
        const project = await store.mergeBranch(mergeMatch[1], body.sourceId, body.targetId, body.acceptedIds);
        json(response, project ? 200 : 404, project ? { project } : { error: 'Project not found' });
        return true;
      }

      json(response, 404, { error: 'Endpoint not found' });
      return true;
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : /not found|does not exist|must be|Choose a repository|Select at least|requires|already|available|active agent|Describe what|Action must|finished|attached|Only a/.test(error.message) ? 422 : 500;
      json(response, status, { error: error.message });
      return true;
    }
  };
}
