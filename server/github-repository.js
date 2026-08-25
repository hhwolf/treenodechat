import { Buffer } from 'node:buffer';
import { extname } from 'node:path';

const MAX_FILES = 120;
const MAX_EXCERPTS = 8;
const MAX_EXCERPT_CHARS = 6_000;
const excluded = /(^|\/)(\.git|\.claude|\.agents|\.gstack|\.context|node_modules|dist|build|coverage|\.threadline)(\/|$)|(^|\/)(\.env($|\.)|.*\.(pem|key|p12|pfx)$)|credential|secret/i;
const preferred = /(^|\/)(readme[^/]*|design\.md|agents\.md|package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements[^/]*\.txt|vite\.config\.[^/]+|src\/[^/]*(main|app|index)\.[^/]+)$/i;

function parseGitHubRepository(value) {
  let candidate = String(value || '').trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(candidate)) candidate = `https://github.com/${candidate}`;
  let url;
  try { url = new URL(candidate); } catch { throw new Error('Enter a GitHub repository URL such as https://github.com/owner/repo'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('Hosted Threadline currently supports HTTPS GitHub repository URLs');
  const [owner, rawRepo, ...extra] = url.pathname.split('/').filter(Boolean);
  if (!owner || !rawRepo || extra.length) throw new Error('Enter the root URL of one GitHub repository');
  const repo = rawRepo.replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('GitHub repository URL is invalid');
  return { owner, repo, root: `https://github.com/${owner}/${repo}` };
}

function languageSummary(files) {
  const names = new Map([
    ['.js', 'JavaScript'], ['.jsx', 'JavaScript'], ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'],
    ['.py', 'Python'], ['.rs', 'Rust'], ['.go', 'Go'], ['.rb', 'Ruby'], ['.swift', 'Swift'],
    ['.java', 'Java'], ['.kt', 'Kotlin'], ['.css', 'CSS'], ['.html', 'HTML'], ['.md', 'Markdown']
  ]);
  const counts = new Map();
  for (const file of files) {
    const language = names.get(extname(file).toLowerCase());
    if (language) counts.set(language, (counts.get(language) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count }));
}

export async function inspectGitHubRepository(repositoryUrl, { token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  const { owner, repo, root } = parseGitHubRepository(repositoryUrl);
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'threadline',
    'x-github-api-version': '2022-11-28'
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = async (path) => {
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}${path}`, { headers });
    if (!response.ok) {
      if (response.status === 404) throw new Error('GitHub repository was not found or the configured token cannot access it');
      throw new Error(`GitHub returned ${response.status} while reading the repository`);
    }
    return response.json();
  };

  const metadata = await request('');
  const branch = metadata.default_branch || 'main';
  const tree = await request(`/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const tracked = (tree.tree || [])
    .filter((item) => item.type === 'blob' && item.path && !excluded.test(item.path))
    .map((item) => item.path);
  const files = [...tracked].sort((a, b) => {
    const preferredDifference = Number(preferred.test(b)) - Number(preferred.test(a));
    if (preferredDifference) return preferredDifference;
    return a.split('/').length - b.split('/').length || a.localeCompare(b);
  }).slice(0, MAX_FILES);
  const excerptFiles = [...files.filter((file) => preferred.test(file)), ...files]
    .filter((file, index, all) => all.indexOf(file) === index)
    .slice(0, MAX_EXCERPTS);
  const excerpts = (await Promise.all(excerptFiles.map(async (path) => {
    try {
      const content = await request(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
      if (content.encoding !== 'base64' || Number(content.size) > 250_000) return null;
      const value = Buffer.from(String(content.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
      if (value.includes('\0')) return null;
      return { path, content: value.slice(0, MAX_EXCERPT_CHARS) };
    } catch { return null; }
  }))).filter(Boolean);
  let recentCommits = [];
  try {
    const commits = await request(`/commits?sha=${encodeURIComponent(branch)}&per_page=5`);
    recentCommits = commits.map((item) => `${item.sha.slice(0, 7)} ${String(item.commit?.message || '').split('\n')[0]}`);
  } catch { /* Repository structure is still useful when commit metadata is unavailable. */ }

  return {
    root,
    name: repo,
    branch,
    private: Boolean(metadata.private),
    fileCount: tracked.length,
    files,
    languages: languageSummary(tracked),
    changedFiles: [],
    recentCommits,
    excerpts,
    scannedAt: new Date().toISOString()
  };
}

export { parseGitHubRepository };
