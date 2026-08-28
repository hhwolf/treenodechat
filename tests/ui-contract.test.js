import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('keeps the default navigation focused and progressive', () => {
  assert.match(app, />Focus</);
  assert.match(app, />Intent</);
  assert.match(app, />Branches</);
  assert.match(app, /advanced-toggle/);
  assert.match(app, />Context</);
  assert.match(app, />Recovery</);
  assert.match(app, />Activity</);
});

test('includes the core create, fork, compare, merge, and recovery flows', () => {
  for (const phrase of ['Start a project', 'Create branch', 'Compare findings', 'Merge selected findings', 'Create checkpoint', 'Restore']) {
    assert.match(app, new RegExp(phrase));
  }
});

test('makes the autonomy boundary visible in the workspace', () => {
  assert.match(app, /Agents can read shared repository context and take reversible actions/);
  assert.match(app, /Private, external, and irreversible actions remain gated/);
});

test('ships accessible focus and reduced-motion behavior', () => {
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(app, /aria-modal="true"/);
  assert.match(app, /aria-label="Current understanding"/);
  assert.doesNotMatch(html, /app\.js|pretext-layout/);
});

test('guides first-time users through the real workspace without trapping them', () => {
  assert.match(app, /threadline:onboarding-complete:v5/);
  assert.match(app, /Skip onboarding/);
  assert.match(app, /Explore Threadline/);
  assert.match(app, /Create my project/);
  assert.match(app, /Explore the example instead/);
  assert.match(app, /Create project and continue/);
  assert.match(app, /onCreate={createOnboardingProject}/);
  assert.match(app, /setTourOpen\(true\)/);
  for (const phrase of ['Name the work', 'Connect the code', 'Define success', 'Why this matters']) {
    assert.match(app, new RegExp(phrase));
  }
  assert.match(app, /data-tour="intent"/);
  assert.match(app, /data-tour="project-switcher"/);
  assert.match(app, /data-tour="branches"/);
  assert.match(app, /data-tour="workspace"/);
  assert.match(app, /data-tour="focus"/);
  assert.match(app, /data-tour="reasoning-items"/);
  assert.match(app, /data-tour="challenge"/);
  assert.match(app, /aria-label={`Step \$\{stepIndex \+ 1\} of \$\{onboardingSteps\.length\}`}/);
  assert.match(styles, /tour-spotlight/);
  assert.match(styles, /onboarding-model/);
  assert.match(styles, /project-onboarding-form/);
});

test('keeps reasoning support compact, reviewable, and source-backed', () => {
  for (const phrase of ['Possible paths', 'Evidence in view', 'Questions and assumptions', 'Confirm', 'Dismiss', 'Challenge']) {
    assert.match(app, new RegExp(phrase));
  }
  assert.match(app, /sourceLabel/);
  assert.match(app, /Fork/);
  assert.match(styles, /approach-grid/);
});

test('supports a grounded repository-to-branch workflow', () => {
  for (const phrase of ['Scan repository', 'Refresh repository', 'Analyze branch', 'Re-analyze', 'Repository not scanned']) {
    assert.match(app, new RegExp(phrase));
  }
  assert.match(app, /data-tour="repository"/);
  assert.match(styles, /repository-strip/);
});

test('exposes supervised agent execution without crowding the base workflow', () => {
  for (const phrase of ['Run with', 'isolated Vercel Sandbox', 'Pause', 'Cancel run', 'Attention', 'Mark resolved', 'Inspect diff', 'Integrate selected files', 'Hosted runs remain review-only']) {
    assert.match(app, new RegExp(phrase));
  }
  assert.match(app, /data-tour="agent-runs"/);
  assert.match(styles, /agent-panel/);
  assert.match(styles, /attention-list/);
});
