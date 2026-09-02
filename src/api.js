const ACCESS_TOKEN_KEY = 'threadline:access-token';

export function getAccessToken() {
  try { return window.sessionStorage.getItem(ACCESS_TOKEN_KEY) || ''; } catch { return ''; }
}

export function setAccessToken(token) {
  try {
    if (token) window.sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  } catch { /* The current tab can still make unauthenticated requests. */ }
}

async function request(path, options = {}) {
  const token = options.public ? '' : getAccessToken();
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  health: () => request('/api/health', { public: true }),
  listProjects: () => request('/api/projects'),
  listAdapters: () => request('/api/adapters'),
  getProject: (id) => request(`/api/projects/${id}`),
  createProject: (input) => request('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  inspectRepository: (location) => request('/api/repositories/inspect', { method: 'POST', body: JSON.stringify({ location }) }),
  connectRepository: (id, location) => request(`/api/projects/${id}/repository`, { method: 'PATCH', body: JSON.stringify({ location }) }),
  scanRepository: (id) => request(`/api/projects/${id}/repository/scan`, { method: 'POST', body: '{}' }),
  updateIntent: (id, intent) => request(`/api/projects/${id}/intent`, { method: 'PATCH', body: JSON.stringify(intent) }),
  draftSpec: (id, brief) => request(`/api/projects/${id}/specs/draft`, { method: 'POST', body: JSON.stringify({ brief }) }),
  updateProjectSettings: (id, input) => request(`/api/projects/${id}/settings`, { method: 'PATCH', body: JSON.stringify(input) }),

  chat: (projectId, input) => request(`/api/projects/${projectId}/chat`, { method: 'POST', body: JSON.stringify(input) }),
  resolveChatAction: (projectId, nodeId, actionId, status) => request(`/api/projects/${projectId}/chat/nodes/${nodeId}/actions/${actionId}`, { method: 'PATCH', body: JSON.stringify({ status }) }),

  controlAgentRun: (projectId, runId, action) => request(`/api/projects/${projectId}/runs/${runId}`, { method: 'PATCH', body: JSON.stringify({ action }) }),
  agentRunDiff: (projectId, runId) => request(`/api/projects/${projectId}/runs/${runId}/diff`),
  verifyAgentRun: (projectId, runId) => request(`/api/projects/${projectId}/runs/${runId}/verify`, { method: 'POST', body: '{}' }),
  integrateAgentRun: (projectId, runId, input) => request(`/api/projects/${projectId}/runs/${runId}/integrate`, { method: 'POST', body: JSON.stringify(input) }),
  resolveAttention: (projectId, itemId) => request(`/api/projects/${projectId}/attention/${itemId}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) }),

  createDocument: (projectId, input) => request(`/api/projects/${projectId}/documents`, { method: 'POST', body: JSON.stringify(input) }),
  updateDocument: (projectId, docId, input) => request(`/api/projects/${projectId}/documents/${docId}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteDocument: (projectId, docId) => request(`/api/projects/${projectId}/documents/${docId}`, { method: 'DELETE' }),
  commitDocument: (projectId, docId, input = {}) => request(`/api/projects/${projectId}/documents/${docId}/commit`, { method: 'POST', body: JSON.stringify(input) }),

  shipStatus: (projectId) => request(`/api/projects/${projectId}/ship`),
  updateShipSettings: (projectId, input) => request(`/api/projects/${projectId}/ship/settings`, { method: 'PATCH', body: JSON.stringify(input) }),
  createPullRequest: (projectId, input) => request(`/api/projects/${projectId}/ship/pr`, { method: 'POST', body: JSON.stringify(input) }),
  mergePullRequest: (projectId, number) => request(`/api/projects/${projectId}/ship/pr/${number}/merge`, { method: 'POST', body: '{}' }),
  triggerDeployment: (projectId, input) => request(`/api/projects/${projectId}/ship/deploy`, { method: 'POST', body: JSON.stringify(input) }),
  rollbackDeployment: (projectId, deploymentId) => request(`/api/projects/${projectId}/ship/rollback`, { method: 'POST', body: JSON.stringify({ deploymentId }) }),
  listEnv: (projectId) => request(`/api/projects/${projectId}/ship/env`),
  createEnv: (projectId, input) => request(`/api/projects/${projectId}/ship/env`, { method: 'POST', body: JSON.stringify(input) }),
  deleteEnv: (projectId, envId) => request(`/api/projects/${projectId}/ship/env/${envId}`, { method: 'DELETE' })
};
