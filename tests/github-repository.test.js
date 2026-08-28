import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectGitHubRepository, parseGitHubRepository } from '../server/github-repository.js';

test('accepts only root HTTPS GitHub repository locations', () => {
  assert.deepEqual(parseGitHubRepository('hhwolf/treenodechat'), {
    owner: 'hhwolf', repo: 'treenodechat', root: 'https://github.com/hhwolf/treenodechat'
  });
  assert.equal(parseGitHubRepository('https://github.com/hhwolf/treenodechat.git').repo, 'treenodechat');
  assert.throws(() => parseGitHubRepository('https://gitlab.com/hhwolf/treenodechat'), /supports HTTPS GitHub/);
  assert.throws(() => parseGitHubRepository('https://github.com/hhwolf/treenodechat/issues'), /root URL/);
});

test('builds a bounded repository snapshot without secret-like files', async () => {
  const responses = new Map([
    ['https://api.github.com/repos/example/project', { default_branch: 'main', private: true }],
    ['https://api.github.com/repos/example/project/git/trees/main?recursive=1', { tree: [
      { type: 'blob', path: 'README.md' },
      { type: 'blob', path: 'src/index.js' },
      { type: 'blob', path: '.env' },
      { type: 'blob', path: 'keys/deploy.pem' }
    ] }],
    ['https://api.github.com/repos/example/project/contents/README.md?ref=main', {
      encoding: 'base64', size: 10, content: Buffer.from('# Project').toString('base64')
    }],
    ['https://api.github.com/repos/example/project/contents/src/index.js?ref=main', {
      encoding: 'base64', size: 18, content: Buffer.from('export const ok = 1;').toString('base64')
    }],
    ['https://api.github.com/repos/example/project/commits?sha=main&per_page=5', [{ sha: '123456789', commit: { message: 'Initial commit\nDetails' } }]]
  ]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const value = responses.get(url);
    return { ok: Boolean(value), status: value ? 200 : 404, json: async () => value };
  };
  const snapshot = await inspectGitHubRepository('https://github.com/example/project', { token: 'read-only-token', fetchImpl });

  assert.equal(snapshot.root, 'https://github.com/example/project');
  assert.equal(snapshot.private, true);
  assert.deepEqual(snapshot.files, ['README.md', 'src/index.js']);
  assert.equal(snapshot.fileCount, 2);
  assert.ok(snapshot.excerpts.some((item) => item.path === 'README.md' && item.content === '# Project'));
  assert.deepEqual(snapshot.recentCommits, ['1234567 Initial commit']);
  assert.ok(calls.every((call) => call.options.headers.authorization === 'Bearer read-only-token'));
});
