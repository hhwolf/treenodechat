import { parseGitHubRepository } from './github-repository.js';
import { integrationBranchName } from './documents.js';

function shipError(message, status = 422) {
  return Object.assign(new Error(message), { status });
}

export function createShip({
  githubToken = process.env.GITHUB_TOKEN,
  vercelToken = process.env.VERCEL_TOKEN,
  fetchImpl = fetch,
  store
} = {}) {
  const scrub = (text) => {
    let value = String(text || '');
    if (githubToken) value = value.replaceAll(githubToken, '***');
    if (vercelToken) value = value.replaceAll(vercelToken, '***');
    return value;
  };

  async function github(project, path, options = {}) {
    if (!githubToken) throw shipError('Configure GITHUB_TOKEN to use GitHub shipping');
    const { owner, repo } = parseGitHubRepository(project.repoPath);
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'threadline',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${githubToken}`
      },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw shipError(scrub(`GitHub returned ${response.status}: ${body.message || 'request failed'}`), response.status >= 500 ? 502 : 422);
    return body;
  }

  async function vercelApi(path, { teamId = '', ...options } = {}) {
    if (!vercelToken) throw shipError('Configure VERCEL_TOKEN to use Vercel shipping');
    const url = new URL(`https://api.vercel.com${path}`);
    if (teamId) url.searchParams.set('teamId', teamId);
    const response = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${vercelToken}`, 'content-type': 'application/json' },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw shipError(scrub(`Vercel returned ${response.status}: ${body.error?.message || 'request failed'}`), response.status >= 500 ? 502 : 422);
    return body;
  }

  async function vercel(project, path, options = {}) {
    if (!project.shipSettings?.vercelProjectId) throw shipError('Set the Vercel project id in Ship settings first');
    return vercelApi(path, { teamId: project.shipSettings.vercelTeamId, ...options });
  }

  // Finds the Vercel project that hosts the connected repository so nobody
  // has to paste prj_/team_ ids by hand; the match is persisted when found.
  async function autoDetectVercelProject(project) {
    const current = project.shipSettings || {};
    if (!vercelToken || !project.repoPath || current.vercelProjectId) return current;
    let owner = '';
    let repo = '';
    try { ({ owner, repo } = parseGitHubRepository(project.repoPath)); } catch { return current; }
    const scopes = [''];
    try {
      const teams = await vercelApi('/v2/teams?limit=20');
      for (const team of teams.teams || []) scopes.push(team.id);
    } catch { /* personal scope only */ }
    for (const teamId of scopes) {
      try {
        const found = await vercelApi(`/v10/projects?search=${encodeURIComponent(repo)}&limit=20`, { teamId });
        const projects = found.projects || [];
        const match = projects.find((item) => item.link?.type === 'github'
            && String(item.link.org || '').toLowerCase() === owner.toLowerCase()
            && String(item.link.repo || '').toLowerCase() === repo.toLowerCase())
          || projects.find((item) => item.name === repo);
        if (match) {
          const settings = { vercelProjectId: match.id, vercelTeamId: teamId };
          if (store?.updateShipSettings) await store.updateShipSettings(project.id, settings);
          return settings;
        }
      } catch { /* keep searching the remaining scopes */ }
    }
    return current;
  }

  async function status(rawProject) {
    const shipSettings = await autoDetectVercelProject(rawProject);
    const project = { ...rawProject, shipSettings: { ...rawProject.shipSettings, ...shipSettings } };
    const configured = {
      github: Boolean(githubToken && project.repoPath),
      vercel: Boolean(vercelToken && project.shipSettings?.vercelProjectId)
    };
    const branch = integrationBranchName(project);
    const result = { settings: project.shipSettings || {}, configured, branch, defaultBranch: null, compare: null, pulls: [], deployments: [], testLink: null, errors: {} };
    if (configured.github) {
      try {
        const { owner } = parseGitHubRepository(project.repoPath);
        const metadata = await github(project, '');
        result.defaultBranch = metadata.default_branch || 'main';
        const [pulls, compare] = await Promise.all([
          github(project, `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`),
          github(project, `/compare/${result.defaultBranch}...${branch}`).catch(() => null)
        ]);
        result.pulls = pulls.map((pull) => ({ number: pull.number, title: pull.title, url: pull.html_url, state: pull.state }));
        if (compare) result.compare = { aheadBy: compare.ahead_by, behindBy: compare.behind_by, status: compare.status };
      } catch (error) {
        result.errors.github = error.message;
      }
    }
    if (configured.vercel) {
      try {
        const listed = await vercel(project, `/v6/deployments?projectId=${encodeURIComponent(project.shipSettings.vercelProjectId)}&limit=12`);
        result.deployments = (listed.deployments || []).map((deployment) => ({
          id: deployment.uid || deployment.id,
          url: deployment.url ? `https://${deployment.url}` : null,
          state: deployment.readyState || deployment.state,
          target: deployment.target || 'preview',
          ref: deployment.meta?.githubCommitRef || null,
          createdAt: deployment.createdAt || deployment.created
        }));
        const ready = result.deployments.filter((deployment) => deployment.state === 'READY' && deployment.url);
        const preview = ready.find((deployment) => deployment.ref === branch);
        const production = ready.find((deployment) => deployment.target === 'production');
        const picked = preview || production;
        if (picked) result.testLink = { url: picked.url, ref: picked.ref, target: picked.target, state: picked.state, kind: preview ? 'integration-preview' : 'production' };
      } catch (error) {
        result.errors.vercel = error.message;
      }
    }
    return result;
  }

  async function createPullRequest(project, { title, body } = {}) {
    if (!String(title || '').trim()) throw shipError('Pull request title is required');
    const metadata = await github(project, '');
    const pull = await github(project, '/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: String(title).slice(0, 200),
        body: String(body || '').slice(0, 10_000),
        head: integrationBranchName(project),
        base: metadata.default_branch || 'main'
      })
    });
    return { number: pull.number, url: pull.html_url, title: pull.title };
  }

  async function mergePullRequest(project, number) {
    const merged = await github(project, `/pulls/${Number(number)}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: 'squash' })
    });
    return { merged: Boolean(merged.merged), sha: merged.sha || null, message: merged.message || '' };
  }

  async function triggerDeployment(project, { ref, target } = {}) {
    const deployTarget = target === 'preview' ? 'preview' : 'production';
    const { owner, repo } = parseGitHubRepository(project.repoPath);
    const deployment = await vercel(project, '/v13/deployments', {
      method: 'POST',
      body: JSON.stringify({
        name: project.shipSettings.vercelProjectId,
        project: project.shipSettings.vercelProjectId,
        ...(deployTarget === 'production' ? { target: 'production' } : {}),
        gitSource: { type: 'github', org: owner, repo, ref: String(ref || 'main') }
      })
    });
    return { id: deployment.id || deployment.uid, url: deployment.url ? `https://${deployment.url}` : null, state: deployment.readyState || deployment.status };
  }

  async function rollbackDeployment(project, deploymentId) {
    if (!deploymentId) throw shipError('Choose a deployment to roll back to');
    const promoted = await vercel(project, `/v10/projects/${encodeURIComponent(project.shipSettings.vercelProjectId)}/promote/${encodeURIComponent(deploymentId)}`, {
      method: 'POST', body: '{}'
    });
    return { ok: true, jobId: promoted.jobId || null };
  }

  // One direct action: reuse or open the pull request for the integration
  // branch, squash-merge it, and make sure production picks it up.
  async function release(rawProject, input = {}) {
    const shipSettings = await autoDetectVercelProject(rawProject);
    const project = { ...rawProject, shipSettings: { ...rawProject.shipSettings, ...shipSettings } };
    const metadata = await github(project, '');
    const base = metadata.default_branch || 'main';
    const branch = integrationBranchName(project);
    const { owner } = parseGitHubRepository(project.repoPath);
    const open = await github(project, `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    const pull = open[0]
      ? { number: open[0].number, url: open[0].html_url, title: open[0].title }
      : await createPullRequest(project, { title: String(input.title || `Threadline: ship ${branch}`), body: input.body });
    const merge = await mergePullRequest(project, pull.number);
    if (!merge.merged) throw shipError(merge.message || `Pull request #${pull.number} could not be merged`);
    let deployment = null;
    if (vercelToken && project.shipSettings.vercelProjectId) {
      const details = await vercel(project, `/v9/projects/${encodeURIComponent(project.shipSettings.vercelProjectId)}`).catch(() => null);
      deployment = details?.link
        ? { note: 'Vercel is connected to the repository and deploys the merge automatically.' }
        : await triggerDeployment(project, { ref: base, target: 'production' });
    }
    return { pull, merge, deployment, base, branch };
  }

  async function listEnv(project) {
    const listed = await vercel(project, `/v9/projects/${encodeURIComponent(project.shipSettings.vercelProjectId)}/env`);
    return (listed.envs || []).map((env) => ({ id: env.id, key: env.key, target: env.target, type: env.type, updatedAt: env.updatedAt }));
  }

  async function createEnv(project, { key, value, target } = {}) {
    if (!String(key || '').trim() || !String(value || '')) throw shipError('Environment variables need a key and a value');
    const targets = Array.isArray(target) && target.length ? target.filter((item) => ['production', 'preview', 'development'].includes(item)) : ['production'];
    await vercel(project, `/v10/projects/${encodeURIComponent(project.shipSettings.vercelProjectId)}/env`, {
      method: 'POST',
      body: JSON.stringify([{ key: String(key).trim().slice(0, 200), value: String(value), type: 'encrypted', target: targets }])
    });
    return { ok: true, key: String(key).trim() };
  }

  async function deleteEnv(project, envId) {
    await vercel(project, `/v9/projects/${encodeURIComponent(project.shipSettings.vercelProjectId)}/env/${encodeURIComponent(envId)}`, { method: 'DELETE' });
    return { ok: true };
  }

  return { status, createPullRequest, mergePullRequest, triggerDeployment, rollbackDeployment, release, listEnv, createEnv, deleteEnv };
}
