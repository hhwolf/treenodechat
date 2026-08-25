import test from 'node:test';
import assert from 'node:assert/strict';
import { routedUrl } from '../api/[...].js';

test('reconstructs nested API paths captured by the Vercel wildcard rewrite', () => {
  assert.equal(routedUrl({ url: '/api/[...]?path=projects/123/runs/456/events&after=9', query: { path: 'projects/123/runs/456/events', after: '9' } }), '/api/projects/123/runs/456/events?after=9');
  assert.equal(routedUrl({ url: '/api/health?path=health', query: { path: ['health'] } }), '/api/health');
});
