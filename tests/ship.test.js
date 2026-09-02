import test from 'node:test';
import assert from 'node:assert/strict';
import { createShip } from '../server/ship.js';

const project = {
  id: 'abc123def',
  name: 'Preflop Lab',
  repoPath: 'https://github.com/owner/repo',
  integration: { branchName: 'threadline/preflop-lab-abc123' },
  shipSettings: { vercelProjectId: 'prj_1', vercelTeamId: 'team_9' }
};

function fakeFetch(routes, calls = []) {
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
    const route = routes.find((item) => item.method === method && item.match.test(String(url)));
    if (!route) return { ok: false, status: 404, json: async () => ({ message: 'no route' }) };
    return { ok: route.status < 300, status: route.status ?? 200, json: async () => route.body };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('reports ship status with pulls, compare, and deployments', async () => {
  const fetchImpl = fakeFetch([
    { method: 'GET', match: /repos\/owner\/repo$/, status: 200, body: { default_branch: 'main' } },
    { method: 'GET', match: /\/pulls\?state=open/, status: 200, body: [{ number: 7, title: 'Ship it', html_url: 'https://github.com/owner/repo/pull/7', state: 'open' }] },
    { method: 'GET', match: /\/compare\/main\.\.\.threadline/, status: 200, body: { ahead_by: 3, behind_by: 0, status: 'ahead' } },
    { method: 'GET', match: /api\.vercel\.com\/v6\/deployments/, status: 200, body: { deployments: [{ uid: 'dpl_1', url: 'app.vercel.app', readyState: 'READY', target: 'production', createdAt: 1 }] } }
  ]);
  const ship = createShip({ githubToken: 'gh-tok', vercelToken: 'vc-tok', fetchImpl });
  const status = await ship.status(project);

  assert.deepEqual(status.configured, { github: true, vercel: true });
  assert.equal(status.branch, 'threadline/preflop-lab-abc123');
  assert.equal(status.defaultBranch, 'main');
  assert.deepEqual(status.pulls, [{ number: 7, title: 'Ship it', url: 'https://github.com/owner/repo/pull/7', state: 'open' }]);
  assert.deepEqual(status.compare, { aheadBy: 3, behindBy: 0, status: 'ahead' });
  assert.equal(status.deployments[0].id, 'dpl_1');
  assert.equal(status.deployments[0].url, 'https://app.vercel.app');
  const vercelCall = fetchImpl.calls.find((call) => call.url.includes('api.vercel.com'));
  assert.match(vercelCall.url, /teamId=team_9/);
  assert.match(vercelCall.url, /projectId=prj_1/);
});

test('creates and merges pull requests against the default branch', async () => {
  const fetchImpl = fakeFetch([
    { method: 'GET', match: /repos\/owner\/repo$/, status: 200, body: { default_branch: 'main' } },
    { method: 'POST', match: /\/pulls$/, status: 201, body: { number: 9, html_url: 'https://github.com/owner/repo/pull/9', title: 'Accept work' } },
    { method: 'PUT', match: /\/pulls\/9\/merge$/, status: 200, body: { merged: true, sha: 'mergesha' } }
  ]);
  const ship = createShip({ githubToken: 'gh-tok', vercelToken: '', fetchImpl });
  const pull = await ship.createPullRequest(project, { title: 'Accept work', body: 'Details' });
  assert.equal(pull.number, 9);
  const created = fetchImpl.calls.find((call) => call.method === 'POST');
  assert.deepEqual(created.body, { title: 'Accept work', body: 'Details', head: 'threadline/preflop-lab-abc123', base: 'main' });

  const merged = await ship.mergePullRequest(project, 9);
  assert.equal(merged.merged, true);
  assert.deepEqual(fetchImpl.calls.at(-1).body, { merge_method: 'squash' });
});

test('deploys, rolls back, and manages env vars without echoing values', async () => {
  const fetchImpl = fakeFetch([
    { method: 'POST', match: /\/v13\/deployments/, status: 200, body: { id: 'dpl_2', url: 'new.vercel.app', readyState: 'QUEUED' } },
    { method: 'POST', match: /\/v10\/projects\/prj_1\/promote\/dpl_old/, status: 200, body: { jobId: 'job_1' } },
    { method: 'GET', match: /\/v9\/projects\/prj_1\/env(\?|$)/, status: 200, body: { envs: [{ id: 'env_1', key: 'DATABASE_URL', target: ['production'], type: 'encrypted', updatedAt: 5 }] } },
    { method: 'POST', match: /\/v10\/projects\/prj_1\/env/, status: 201, body: {} },
    { method: 'DELETE', match: /\/v9\/projects\/prj_1\/env\/env_1/, status: 200, body: {} }
  ]);
  const ship = createShip({ githubToken: 'gh-tok', vercelToken: 'vc-tok', fetchImpl });

  const deployment = await ship.triggerDeployment(project, { ref: 'threadline/preflop-lab-abc123' });
  assert.equal(deployment.id, 'dpl_2');
  const deployCall = fetchImpl.calls[0];
  assert.deepEqual(deployCall.body.gitSource, { type: 'github', org: 'owner', repo: 'repo', ref: 'threadline/preflop-lab-abc123' });
  assert.equal(deployCall.body.target, 'production');

  await ship.rollbackDeployment(project, 'dpl_old');
  const envs = await ship.listEnv(project);
  assert.deepEqual(envs, [{ id: 'env_1', key: 'DATABASE_URL', target: ['production'], type: 'encrypted', updatedAt: 5 }]);
  assert.ok(!JSON.stringify(envs).includes('value'));

  await ship.createEnv(project, { key: 'OPENAI_API_KEY', value: 'super-secret', target: ['production', 'preview'] });
  const envCall = fetchImpl.calls.find((call) => call.method === 'POST' && call.url.includes('/env'));
  assert.equal(envCall.body[0].type, 'encrypted');
  assert.deepEqual(envCall.body[0].target, ['production', 'preview']);

  await ship.deleteEnv(project, 'env_1');
  assert.equal(fetchImpl.calls.at(-1).method, 'DELETE');
});

test('surfaces configuration gaps and scrubs tokens from errors', async () => {
  const noTokens = createShip({ githubToken: '', vercelToken: '', fetchImpl: async () => { throw new Error('no fetch'); } });
  await assert.rejects(noTokens.createPullRequest(project, { title: 'x' }), /GITHUB_TOKEN/);
  await assert.rejects(noTokens.triggerDeployment(project, {}), /VERCEL_TOKEN/);

  const unconfigured = createShip({ githubToken: 'gh', vercelToken: 'vc', fetchImpl: async () => { throw new Error('no fetch'); } });
  await assert.rejects(unconfigured.listEnv({ ...project, shipSettings: {} }), /Vercel project id/);

  const leaky = createShip({
    githubToken: 'gh-secret-token', vercelToken: 'vc',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'bad token gh-secret-token' }) })
  });
  await assert.rejects(leaky.createPullRequest(project, { title: 'x' }), (error) => {
    assert.ok(!error.message.includes('gh-secret-token'));
    assert.match(error.message, /GitHub returned 401/);
    return true;
  });

  const status = await createShip({ githubToken: '', vercelToken: '', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) }).status(project);
  assert.deepEqual(status.configured, { github: false, vercel: false });
});
