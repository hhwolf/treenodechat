import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { commitDocumentToGitHub, formatRulesSection, integrationBranchName } from '../server/documents.js';

const project = { id: 'abc123def', name: 'Preflop Lab', repoPath: 'https://github.com/owner/repo', integration: {} };

function fakeGitHub(responses, calls) {
  return async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const next = responses.shift() || { status: 500, body: {} };
    return { ok: next.status < 300, status: next.status, json: async () => next.body };
  };
}

test('formats rules sections for prompts within the cap', () => {
  assert.equal(formatRulesSection([], 4_000), '');
  const section = formatRulesSection([
    { name: 'CLAUDE.md', content: 'Be careful.' },
    { name: 'skills/research.md', content: 'Cite sources.' }
  ], 4_000);
  assert.match(section, /Project rules/);
  assert.match(section, /### CLAUDE\.md\nBe careful\./);
  assert.match(section, /### skills\/research\.md/);
  const capped = formatRulesSection([{ name: 'BIG.md', content: 'x'.repeat(10_000) }], 500);
  assert.ok(capped.length <= 600);
});

test('creates the project branch and file on the first commit', async () => {
  const calls = [];
  const fetchImpl = fakeGitHub([
    { status: 404, body: {} },
    { status: 200, body: { default_branch: 'main' } },
    { status: 200, body: { object: { sha: 'basesha' } } },
    { status: 201, body: {} },
    { status: 404, body: {} },
    { status: 201, body: { content: { sha: 'blobsha' }, commit: { sha: 'commitsha' } } }
  ], calls);
  const result = await commitDocumentToGitHub(project, { name: 'CLAUDE.md', content: '# Rules' }, { token: 'tok', fetchImpl });
  assert.equal(result.branch, integrationBranchName(project));
  assert.equal(result.branch, 'threadline/preflop-lab-abc123');
  assert.equal(result.contentSha, 'blobsha');
  assert.equal(result.commitSha, 'commitsha');
  assert.deepEqual(calls[3].body, { ref: `refs/heads/${result.branch}`, sha: 'basesha' });
  const put = calls.at(-1);
  assert.equal(put.method, 'PUT');
  assert.match(put.url, /\/contents\/CLAUDE\.md$/);
  assert.equal(put.body.branch, result.branch);
  assert.equal(Buffer.from(put.body.content, 'base64').toString('utf8'), '# Rules');
  assert.ok(!('sha' in put.body));
});

test('updates an existing file with its sha and retries once on a conflict', async () => {
  const calls = [];
  const fetchImpl = fakeGitHub([
    { status: 200, body: { object: { sha: 'head' } } },
    { status: 200, body: { sha: 'oldsha' } },
    { status: 409, body: {} },
    { status: 200, body: { sha: 'newersha' } },
    { status: 200, body: { content: { sha: 'blob2' }, commit: { sha: 'commit2' } } }
  ], calls);
  const result = await commitDocumentToGitHub(project, { name: 'skills/research.md', content: 'v2' }, { token: 'tok', fetchImpl });
  assert.equal(result.contentSha, 'blob2');
  const puts = calls.filter((call) => call.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.equal(puts[0].body.sha, 'oldsha');
  assert.equal(puts[1].body.sha, 'newersha');
  assert.match(puts[1].url, /\/contents\/skills\/research\.md$/);
});

test('refuses to commit without a GitHub token', async () => {
  await assert.rejects(
    commitDocumentToGitHub(project, { name: 'CLAUDE.md', content: 'x' }, { token: '', fetchImpl: async () => { throw new Error('should not fetch'); } }),
    /GITHUB_TOKEN/
  );
});
