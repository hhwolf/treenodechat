import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_FILES = 120;
const MAX_EXCERPTS = 8;
const MAX_EXCERPT_CHARS = 6_000;
const excluded = /(^|\/)(\.git|\.claude|\.agents|\.gstack|\.context|node_modules|dist|build|coverage|\.threadline)(\/|$)|(^|\/)(\.env($|\.)|.*\.(pem|key|p12|pfx)$)|credential|secret/i;
const preferred = /(^|\/)(readme[^/]*|design\.md|agents\.md|package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements[^/]*\.txt|vite\.config\.[^/]+|src\/[^/]*(main|app|index)\.[^/]+)$/i;

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5_000, maxBuffer: 2_000_000 });
  return result.status === 0 ? result.stdout.trimEnd() : '';
}

function safeRoot(repoPath) {
  if (!repoPath?.trim()) throw new Error('Choose a repository path first');
  if (!isAbsolute(repoPath)) throw new Error('Repository path must be absolute');
  let root;
  try { root = realpathSync(repoPath); } catch { throw new Error('Repository path does not exist'); }
  if (!statSync(root).isDirectory()) throw new Error('Repository path must be a directory');
  return root;
}

function safeRead(root, file) {
  if (!file || excluded.test(file)) return null;
  const candidate = join(root, file);
  let resolved;
  try { resolved = realpathSync(candidate); } catch { return null; }
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return null;
  try {
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > 250_000) return null;
    const value = readFileSync(resolved, 'utf8');
    if (value.includes('\0')) return null;
    return value.slice(0, MAX_EXCERPT_CHARS);
  } catch {
    return null;
  }
}

function languageSummary(files) {
  const counts = new Map();
  const names = new Map([
    ['.js', 'JavaScript'], ['.jsx', 'JavaScript'], ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'],
    ['.py', 'Python'], ['.rs', 'Rust'], ['.go', 'Go'], ['.rb', 'Ruby'], ['.swift', 'Swift'],
    ['.java', 'Java'], ['.kt', 'Kotlin'], ['.css', 'CSS'], ['.html', 'HTML'], ['.md', 'Markdown']
  ]);
  for (const file of files) {
    const name = names.get(extname(file).toLowerCase());
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count }));
}

export function inspectRepository(repoPath) {
  const root = safeRoot(repoPath);
  const tracked = git(root, ['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean).filter((file) => !excluded.test(file));
  const fallbackFiles = tracked.length ? tracked : [];
  const files = [...fallbackFiles].sort((a, b) => {
    const preferredDifference = Number(preferred.test(b)) - Number(preferred.test(a));
    if (preferredDifference) return preferredDifference;
    const depthDifference = a.split('/').length - b.split('/').length;
    return depthDifference || a.localeCompare(b);
  }).slice(0, MAX_FILES);
  const statusLines = git(root, ['status', '--short']).split('\n').filter(Boolean).slice(0, 40);
  const branch = git(root, ['branch', '--show-current']) || 'detached';
  const recentCommits = git(root, ['log', '-5', '--pretty=format:%h %s']).split('\n').filter(Boolean);
  const excerptCandidates = [...files.filter((file) => preferred.test(file)), ...files]
    .filter((file, index, all) => all.indexOf(file) === index)
    .slice(0, 30);
  const excerpts = [];
  for (const file of excerptCandidates) {
    if (excerpts.length >= MAX_EXCERPTS) break;
    const content = safeRead(root, file);
    if (content) excerpts.push({ path: file, content });
  }
  return {
    root,
    name: basename(root),
    branch,
    fileCount: tracked.length,
    files,
    languages: languageSummary(tracked),
    changedFiles: statusLines.map((line) => ({ status: line.slice(0, 2).trim() || 'changed', path: line.slice(3) })),
    recentCommits,
    excerpts,
    scannedAt: new Date().toISOString()
  };
}

export function repositoryContext(snapshot) {
  if (!snapshot?.scannedAt) return null;
  return {
    branch: snapshot.branch,
    fileCount: snapshot.fileCount,
    languages: snapshot.languages,
    changedFiles: snapshot.changedFiles,
    recentCommits: snapshot.recentCommits,
    files: snapshot.files,
    excerpts: snapshot.excerpts
  };
}
