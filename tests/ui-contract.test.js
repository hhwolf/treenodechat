import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../src/App.jsx');
const chat = read('../src/chat.jsx');
const tree = read('../src/tree.jsx');
const rules = read('../src/rules.jsx');
const ship = read('../src/ship.jsx');
const styles = read('../src/styles.css');
const html = read('../index.html');

test('presents four focused tabs with chat as the default surface', () => {
  for (const label of ["label: 'Chat'", "label: 'Tree'", "label: 'Rules'", "label: 'Ship'"]) assert.ok(app.includes(label));
  assert.match(app, /useState\('chat'\)/);
  assert.match(app, /openAttention/);
  assert.doesNotMatch(app, /OnboardingTour|onboardingSteps|tour-overlay|Skip onboarding/);
  assert.match(styles, /\.tab-bar/);
});

test('keeps the chat dynamic: directions, forks, and live run cards', () => {
  assert.match(chat, /direction-card/);
  assert.match(chat, /Recommended/);
  assert.match(chat, /Fork from here/);
  assert.match(chat, /Continue with the run result/);
  assert.match(chat, /Continuing in/);
  for (const phrase of ['Pause', 'Resume', 'Cancel run', 'Inspect diff', 'Verify', 'Integrate selected files']) {
    assert.match(chat, new RegExp(phrase));
  }
  assert.match(styles, /\.direction-card/);
  assert.match(styles, /\.run-card/);
});

test('shows the whole conversation as a navigable tree', () => {
  assert.match(tree, /Conversation tree/);
  assert.match(tree, /deepestDescendant/);
  assert.match(tree, /direction-chip/);
  assert.match(styles, /\.tree-node/);
});

test('gives rules one home: intent, documents, sync, and verify command', () => {
  for (const phrase of ['Project intent', 'Save intent', 'Refine spec', 'CLAUDE.md, skills, and guidelines', 'Commit to repo', 'Never committed', 'Modified since commit', 'Verify command']) {
    assert.match(rules, new RegExp(phrase));
  }
  assert.match(rules, /Connect repository|Change repository/);
  assert.match(styles, /\.sync-pill/);
});

test('gates every ship action behind explicit confirmation', () => {
  for (const phrase of ['Create pull request', 'Merge', 'Deploy to production', 'Roll back to this', 'Environment variables']) {
    assert.match(ship, new RegExp(phrase));
  }
  assert.match(ship, /confirmTyped\('merge'/);
  assert.match(ship, /confirmTyped\('deploy'/);
  assert.match(ship, /confirmTyped\('rollback'/);
  assert.match(ship, /never displayed/);
  assert.match(chat, /requires your approval/);
  assert.match(chat, /Approve & run/);
});

test('makes the autonomy boundary visible', () => {
  assert.match(rules, /Agents can read shared repository context and take reversible actions/);
  assert.match(ship, /never executed by the model/);
  assert.match(chat, /review-only/);
});

test('ships accessible focus, reduced motion, and modal semantics', () => {
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(read('../src/ui.jsx'), /aria-modal="true"/);
  assert.match(app, /aria-label="Threadline access code"/);
  assert.doesNotMatch(html, /app\.js|pretext-layout/);
});
