import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRepository, repositoryContext } from '../server/repository.js';

test('creates a bounded, secret-filtered read-only repository snapshot', () => {
  const snapshot = inspectRepository(process.cwd());
  assert.equal(snapshot.root, process.cwd());
  assert.ok(snapshot.fileCount > 0);
  assert.ok(snapshot.files.length <= 120);
  assert.ok(snapshot.excerpts.length <= 8);
  assert.ok(snapshot.files.includes('package.json'));
  assert.ok(snapshot.files.every((file) => !/(^|\/)\.env($|\.)|node_modules|\.threadline/.test(file)));
  const context = repositoryContext(snapshot);
  assert.equal(context.branch, snapshot.branch);
  assert.ok(!Object.hasOwn(context, 'root'));
});

test('rejects invalid and relative repository paths', () => {
  assert.throws(() => inspectRepository('relative/path'), /absolute/);
  assert.throws(() => inspectRepository('/definitely/not/a/threadline/repository'), /does not exist/);
});
