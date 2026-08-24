async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

export const api = {
  listProjects: () => request('/api/projects'),
  listAdapters: () => request('/api/adapters'),
  getProject: (id) => request(`/api/projects/${id}`),
  createProject: (input) => request('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateIntent: (id, intent) => request(`/api/projects/${id}/intent`, { method: 'PATCH', body: JSON.stringify(intent) }),
  draftSpec: (id, brief) => request(`/api/projects/${id}/specs/draft`, { method: 'POST', body: JSON.stringify({ brief }) }),
  draftReasoning: (id) => request(`/api/projects/${id}/reasoning/draft`, { method: 'POST', body: '{}' }),
  resolveReasoning: (projectId, itemId, status) => request(`/api/projects/${projectId}/reasoning/${itemId}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  challengeReasoning: (id) => request(`/api/projects/${id}/reasoning/challenge`, { method: 'POST', body: '{}' }),
  scanRepository: (id) => request(`/api/projects/${id}/repository/scan`, { method: 'POST', body: '{}' }),
  createBranch: (id, input) => request(`/api/projects/${id}/branches`, { method: 'POST', body: JSON.stringify(input) }),
  updateBranch: (projectId, branchId, input) => request(`/api/projects/${projectId}/branches/${branchId}`, { method: 'PATCH', body: JSON.stringify(input) }),
  analyzeBranch: (projectId, branchId) => request(`/api/projects/${projectId}/branches/${branchId}/analyze`, { method: 'POST', body: '{}' }),
  startAgentRun: (projectId, branchId, task) => request(`/api/projects/${projectId}/branches/${branchId}/runs`, { method: 'POST', body: JSON.stringify({ task }) }),
  controlAgentRun: (projectId, runId, action) => request(`/api/projects/${projectId}/runs/${runId}`, { method: 'PATCH', body: JSON.stringify({ action }) }),
  agentRunEvents: (projectId, runId, after = 0) => request(`/api/projects/${projectId}/runs/${runId}/events?after=${after}`),
  agentRunDiff: (projectId, runId) => request(`/api/projects/${projectId}/runs/${runId}/diff`),
  resolveAttention: (projectId, itemId) => request(`/api/projects/${projectId}/attention/${itemId}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) }),
  inheritedContexts: (projectId, branchId) => request(`/api/projects/${projectId}/contexts?branchId=${encodeURIComponent(branchId)}`),
  createContext: (id, input) => request(`/api/projects/${id}/contexts`, { method: 'POST', body: JSON.stringify(input) }),
  createCheckpoint: (id, name) => request(`/api/projects/${id}/checkpoints`, { method: 'POST', body: JSON.stringify({ name }) }),
  restoreCheckpoint: (projectId, checkpointId) => request(`/api/projects/${projectId}/checkpoints/${checkpointId}/restore`, { method: 'POST', body: '{}' }),
  merge: (projectId, input) => request(`/api/projects/${projectId}/merge`, { method: 'POST', body: JSON.stringify(input) })
};
