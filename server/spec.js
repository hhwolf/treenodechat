import { defaultIntent } from './store.js';
import { repositoryContext } from './repository.js';

function normalizeSpec(spec, brief) {
  const fallback = defaultIntent(brief);
  const text = (value, fallbackValue, limit = 2_000) => {
    if (typeof value !== 'string') return fallbackValue;
    const normalized = value.trim();
    return normalized ? normalized.slice(0, limit) : fallbackValue;
  };
  const questions = Array.isArray(spec?.questions)
    ? spec.questions.filter((question) => typeof question === 'string' && question.trim()).slice(0, 5).map((question) => question.trim().slice(0, 500))
    : [];
  return {
    objective: text(spec?.objective, fallback.objective),
    audience: text(spec?.audience, fallback.audience),
    outcome: text(spec?.outcome, fallback.outcome),
    avoid: text(spec?.avoid, fallback.avoid),
    format: text(spec?.format, fallback.format),
    qualityBar: text(spec?.qualityBar, fallback.qualityBar),
    questions: questions.length ? questions : fallback.questions
  };
}

async function requestRemoteSpec({ brief, currentIntent }) {
  const url = process.env.LLM_API_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!url || !key || !model) return null;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Turn a coding-project brief into JSON with objective, audience, outcome, avoid, format, qualityBar, and questions. Ask only questions that materially block safe implementation. Do not include chain-of-thought.'
        },
        { role: 'user', content: JSON.stringify({ brief, currentIntent }) }
      ]
    })
  });
  if (!response.ok) throw new Error(`Model provider returned ${response.status}`);
  const payload = await response.json();
  return JSON.parse(payload.choices?.[0]?.message?.content || '{}');
}

export async function draftSpec({ brief = '', currentIntent = {} }) {
  try {
    const remote = await requestRemoteSpec({ brief, currentIntent });
    if (remote) return { source: 'model', intent: normalizeSpec(remote, brief) };
  } catch (error) {
    return { source: 'local-fallback', warning: error.message, intent: normalizeSpec(currentIntent, brief) };
  }
  return { source: 'local', intent: normalizeSpec({ ...defaultIntent(brief), ...currentIntent }, brief) };
}

const normalizeReasoning = (draft, project) => {
  const allowedKinds = new Set(['approach', 'evidence', 'assumption', 'question', 'counterpoint', 'decision']);
  const items = Array.isArray(draft?.items) ? draft.items : [];
  return items
    .filter((item) => item && typeof item === 'object' && allowedKinds.has(item.kind) && item.title && item.summary)
    .slice(0, 12)
    .map((item) => ({
      kind: item.kind,
      title: String(item.title).slice(0, 100),
      summary: String(item.summary).slice(0, 500),
      sourceLabel: String(item.sourceLabel || 'Threadline analysis').slice(0, 160),
      confidence: ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : 'medium',
      branchId: project.branches.some((branch) => branch.id === item.branchId) ? item.branchId : null
    }));
};

function localReasoning(project) {
  const branchApproaches = project.branches
    .filter((branch) => branch.parentId)
    .slice(0, 3)
    .map((branch) => ({
      kind: 'approach',
      title: branch.name,
      summary: branch.purpose || branch.output.summary || 'Explore this direction as an isolated implementation path.',
      sourceLabel: `Branch · ${branch.name}`,
      confidence: branch.status === 'review' || branch.status === 'merged' ? 'high' : 'medium',
      branchId: branch.id
    }));
  const approaches = branchApproaches.length ? branchApproaches : [
    { kind: 'approach', title: 'Smallest safe change', summary: 'Make the narrowest reversible change that satisfies the objective, then validate preserved behavior.', sourceLabel: 'Project intent', confidence: 'medium' },
    { kind: 'approach', title: 'Staged transition', summary: 'Split the work into checkpoints so old and new behavior can be compared before final adoption.', sourceLabel: 'Project intent', confidence: 'medium' },
    { kind: 'approach', title: 'Evidence-first investigation', summary: 'Characterize current behavior and failure cases before choosing an implementation path.', sourceLabel: 'Project quality bar', confidence: 'high' }
  ];
  const sharedContext = project.contexts.filter((item) => item.sensitivity === 'shared' && item.scope === 'project').slice(0, 2);
  const evidence = sharedContext.map((item) => ({
    kind: 'evidence',
    title: item.label,
    summary: item.value,
    sourceLabel: item.source,
    confidence: item.source === 'User' ? 'medium' : 'high'
  }));
  const repositoryEvidence = project.repository?.scannedAt ? [
    {
      kind: 'evidence',
      title: `${project.repository.name} on ${project.repository.branch}`,
      summary: `${project.repository.fileCount} tracked files. ${project.repository.languages?.slice(0, 3).map((item) => item.name).join(', ') || 'Languages not detected'}. ${project.repository.changedFiles?.length || 0} working-tree changes.`,
      sourceLabel: `Repository scan · ${new Date(project.repository.scannedAt).toLocaleString()}`,
      confidence: 'high'
    },
    ...(project.repository.excerpts || []).slice(0, 1).map((excerpt) => ({
      kind: 'evidence',
      title: excerpt.path,
      summary: excerpt.content.replace(/\s+/g, ' ').slice(0, 300),
      sourceLabel: `Repository · ${excerpt.path}`,
      confidence: 'high'
    }))
  ] : [];
  return {
    items: [
      ...approaches,
      ...repositoryEvidence,
      ...evidence,
      { kind: 'assumption', title: 'Current behavior can be verified', summary: `The team can establish a baseline before changing the system described by “${project.intent.objective.replace(/[.!?]+$/, '')}”.`, sourceLabel: 'Threadline analysis', confidence: 'medium' },
      { kind: 'question', title: project.intent.questions[0] || 'What evidence would change the decision?', summary: 'Resolve this before committing to an approach; it is the largest remaining source of uncertainty.', sourceLabel: 'Project intent', confidence: 'high' }
    ]
  };
}

async function requestRemoteReasoning(project) {
  const url = process.env.LLM_API_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!url || !key || !model) return null;
  const sharedContexts = project.contexts
    .filter((item) => item.sensitivity === 'shared')
    .map(({ label, value, scope, source }) => ({ label, value, scope, source }));
  const branches = project.branches.map(({ id, name, purpose, status, output }) => ({ id, name, purpose, status, summary: output.summary }));
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Create a compact reasoning brief for a coding project. Return JSON with items: 2-3 approaches, 1-3 evidence items, 1-2 assumptions, and 1 decisive question. Each item has kind, title, summary, sourceLabel, confidence, and optional branchId. Use only supplied information. Expose concise rationale, never hidden chain-of-thought. Keep the total under 10 items.'
        },
        { role: 'user', content: JSON.stringify({ intent: project.intent, sharedContexts, branches, repository: repositoryContext(project.repository) }) }
      ]
    })
  });
  if (!response.ok) throw new Error(`Model provider returned ${response.status}`);
  const payload = await response.json();
  return JSON.parse(payload.choices?.[0]?.message?.content || '{}');
}

export async function draftReasoning(project) {
  try {
    const remote = await requestRemoteReasoning(project);
    if (remote) return { source: 'model', items: normalizeReasoning(remote, project) };
  } catch (error) {
    return { source: 'local-fallback', warning: error.message, items: normalizeReasoning(localReasoning(project), project) };
  }
  return { source: 'local', items: normalizeReasoning(localReasoning(project), project) };
}

function localBranchAnalysis(project, branch, contexts) {
  const repository = project.repository || {};
  const evidence = repository.scannedAt
    ? `Repository scan found ${repository.fileCount} tracked files on ${repository.branch}, with ${repository.changedFiles?.length || 0} current working-tree changes.`
    : 'No repository snapshot is available yet; refresh the repository before relying on implementation-specific conclusions.';
  const relevantFiles = (repository.files || []).filter((file) => /(^|\/)(src|server|app|lib|tests?)(\/|\.)/i.test(file)).slice(0, 5);
  return {
    summary: `${branch.purpose || branch.name}\n\n${evidence}\n\nStart by validating the branch-only constraints, then inspect the smallest relevant surface before proposing implementation changes.`,
    changes: [
      { id: `analysis-${branch.id}-scope`, title: 'Confirm the implementation boundary', detail: contexts.length ? `Honor ${contexts.length} inherited context item${contexts.length === 1 ? '' : 's'} before changing behavior.` : 'Record the constraints this branch must preserve.', selected: true },
      { id: `analysis-${branch.id}-files`, title: 'Inspect the likely code surface', detail: relevantFiles.length ? `Begin with ${relevantFiles.join(', ')}.` : 'Scan the repository and identify the smallest relevant files.', selected: true },
      { id: `analysis-${branch.id}-proof`, title: 'Define verification before implementation', detail: project.intent.qualityBar, selected: true }
    ]
  };
}

async function requestRemoteBranchAnalysis(project, branch, contexts) {
  const url = process.env.LLM_API_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!url || !key || !model) return null;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Analyze one coding-project branch using only the supplied intent, contexts, and read-only repository snapshot. Return JSON with a concise summary and 2-5 reviewable changes. Each change has title and detail. These are proposed implementation findings, not claims that files were edited. Do not include hidden chain-of-thought.'
        },
        { role: 'user', content: JSON.stringify({ intent: project.intent, branch: { name: branch.name, purpose: branch.purpose }, contexts, repository: repositoryContext(project.repository) }) }
      ]
    })
  });
  if (!response.ok) throw new Error(`Model provider returned ${response.status}`);
  const payload = await response.json();
  return JSON.parse(payload.choices?.[0]?.message?.content || '{}');
}

function normalizeBranchAnalysis(value, project, branch, contexts) {
  const fallback = localBranchAnalysis(project, branch, contexts);
  const changes = Array.isArray(value?.changes) ? value.changes.filter((item) => item?.title && item?.detail).slice(0, 5) : fallback.changes;
  return {
    summary: String(value?.summary || fallback.summary).slice(0, 2_000),
    changes: changes.map((item, index) => ({
      id: `analysis-${branch.id}-${Date.now()}-${index}`,
      title: String(item.title).slice(0, 120),
      detail: String(item.detail).slice(0, 600),
      selected: item.selected !== false
    }))
  };
}

export async function analyzeBranch(project, branch, contexts) {
  try {
    const remote = await requestRemoteBranchAnalysis(project, branch, contexts);
    if (remote) return { source: 'model', output: normalizeBranchAnalysis(remote, project, branch, contexts) };
  } catch (error) {
    return { source: 'local-fallback', warning: error.message, output: normalizeBranchAnalysis(null, project, branch, contexts) };
  }
  return { source: 'local', output: normalizeBranchAnalysis(null, project, branch, contexts) };
}
