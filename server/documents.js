import { Buffer } from 'node:buffer';
import { parseGitHubRepository } from './github-repository.js';

function slug(value) {
  return String(value || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
}

export function integrationBranchName(project) {
  return project.integration?.branchName || `threadline/${slug(project.name)}-${project.id.slice(0, 6)}`;
}

export function formatRulesSection(documents = [], cap = 4_000) {
  if (!documents?.length) return '';
  let remaining = cap;
  const sections = [];
  for (const document of documents) {
    if (remaining <= 200) break;
    const body = `### ${document.name}\n${String(document.content || '').trim() || '(empty)'}`.slice(0, remaining);
    sections.push(body);
    remaining -= body.length + 2;
  }
  return sections.length ? `Project rules (follow these in every response and change):\n${sections.join('\n\n')}` : '';
}

export async function commitDocumentToGitHub(project, document, { token, message, fetchImpl = fetch } = {}) {
  if (!token) throw Object.assign(new Error('Configure GITHUB_TOKEN with write access to commit rules to GitHub'), { status: 422 });
  const { owner, repo } = parseGitHubRepository(project.repoPath);
  const branch = integrationBranchName(project);
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'threadline',
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${token}`
  };
  const api = async (path, options = {}) => {
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}${path}`, { headers, ...options });
    return { status: response.status, body: response.ok || response.status === 404 || response.status === 409 || response.status === 422 ? await response.json().catch(() => ({})) : {} , ok: response.ok };
  };

  const ref = await api(`/git/ref/heads/${branch}`);
  if (!ref.ok && ref.status !== 404) throw new Error(`GitHub returned ${ref.status} while reading the project branch`);
  if (ref.status === 404) {
    const metadata = await api('');
    if (!metadata.ok) throw new Error('GitHub repository was not found or the configured token cannot access it');
    const base = await api(`/git/ref/heads/${metadata.body.default_branch || 'main'}`);
    if (!base.ok) throw new Error('Could not read the default branch to create the project branch');
    const created = await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.body.object.sha }) });
    if (!created.ok) throw new Error(`GitHub returned ${created.status} while creating ${branch}`);
  }

  const put = async () => {
    const existing = await api(`/contents/${document.name.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
    const payload = {
      message: String(message || `Threadline: update ${document.name}`).slice(0, 200),
      content: Buffer.from(document.content || '', 'utf8').toString('base64'),
      branch,
      ...(existing.ok && existing.body.sha ? { sha: existing.body.sha } : {})
    };
    return api(`/contents/${document.name.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body: JSON.stringify(payload) });
  };
  let result = await put();
  if (result.status === 409 || result.status === 422) result = await put();
  if (!result.ok) throw new Error(`GitHub returned ${result.status} while committing ${document.name}`);
  return {
    branch,
    path: document.name,
    contentSha: result.body.content?.sha || null,
    commitSha: result.body.commit?.sha || null
  };
}
