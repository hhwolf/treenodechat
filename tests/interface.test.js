const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const javascript = read('app.js');
const pretext = read('pretext-layout.js');
const styles = read('styles.css');

function setup(t) {
  const dom = new JSDOM(html, {
    url: 'http://threadline.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  dom.window.eval(javascript);
  t.after(() => dom.window.close());
  return dom.window;
}

function click(window, selector) {
  const element = window.document.querySelector(selector);
  assert.ok(element, `Expected ${selector} to exist`);
  element.click();
  return element;
}

test('renders the persistent workspace shell with accessible recovery controls', () => {
  for (const region of ['explorer', 'workbench', 'inspector', 'operations-tray']) {
    assert.match(html, new RegExp(`class="[^"]*${region}`), `${region} region is missing`);
  }
  assert.match(styles, /focus-visible/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(pretext, /@chenglou\/pretext@0\.0\.8/);
  assert.match(pretext, /catch \{/);
});

test('turns a vague request into a reviewed workspace intent', (t) => {
  const window = setup(t);
  const { document } = window;

  click(window, '#newObject');
  assert.match(document.querySelector('#workspacePrompt').value, /evaluate our ML models/);
  click(window, '[data-mode="Production"]');
  click(window, '#generateIntent');
  assert.match(document.querySelector('.modal-header p').textContent, /production workspace/);
  assert.equal(document.querySelectorAll('.intent-item').length, 8);
  click(window, '#approveIntent');

  assert.equal(document.querySelector('#modalBackdrop').hidden, true);
  assert.match(document.querySelector('.toast').textContent, /Production workspace created/);
});

test('forks a branch, assigns an agent, and treats its name as text', (t) => {
  const window = setup(t);
  const { document } = window;

  click(window, '.inline-add');
  document.querySelector('#branchName').value = '<img src=x onerror="window.threadlineXss=1">';
  click(window, 'input[name="branchAgent"][value="Knox"]');
  click(window, '#createBranch');

  assert.equal(window.threadlineXss, undefined);
  assert.equal(document.querySelectorAll('.toast img').length, 0);
  assert.match(document.querySelector('.toast').textContent, /assigned to Knox/);
});

test('switches between distinct operational agent passports', (t) => {
  const window = setup(t);
  const { document } = window;

  click(window, '.agent-row[data-agent="Mira"]');
  assert.equal(document.querySelector('.passport-identity h2').textContent, 'Mira');
  assert.equal(document.querySelector('#passportRole').textContent, 'Research lead');
  assert.equal(document.querySelector('#passportParent').textContent, 'Literature scan');
  assert.equal(document.querySelector('#passportConfidence').textContent, '76%');

  click(window, '.agent-row[data-agent="Knox"]');
  assert.equal(document.querySelector('#passportState').textContent, 'Blocked by permission');
  assert.equal(document.querySelector('#passportAutonomy').textContent, 'Approval-first');
});

test('edits context scope and previews inheritance impact', (t) => {
  const window = setup(t);
  const { document, Event } = window;

  click(window, '#contextRegistry');
  click(window, '[data-context-title="Evaluation incidents · Q2"]');
  const scope = document.querySelector('#contextScope');
  scope.value = 'Task';
  scope.dispatchEvent(new Event('change', { bubbles: true }));
  assert.match(document.querySelector('#contextImpact').textContent, /1 task only/);
  document.querySelector('#excludeContext').checked = true;
  click(window, '#saveContextItem');
  assert.match(document.querySelector('.toast').textContent, /Task scope and excluded/);
});

test('resolves a context conflict using inherited project intent', (t) => {
  const window = setup(t);
  const { document } = window;

  click(window, '#inlineConflict button');
  assert.equal(document.querySelector('input[name="target"]:checked').value, '24h');
  click(window, '#applyConflict');
  assert.equal(document.querySelector('#inlineConflict'), null);
  assert.match(document.querySelector('.toast').textContent, /24h target selected/);
});

test('partially accepts changes and performs a checkpointed merge', (t) => {
  const window = setup(t);
  const { document, Event } = window;

  click(window, '#inlineConflict button');
  click(window, '#applyConflict');
  click(window, '#reviewChanges');
  const selected = [...document.querySelectorAll('.change-check:checked')];
  assert.equal(selected.length, 4);
  selected[0].checked = false;
  selected[0].dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(document.querySelector('#acceptChanges').textContent, 'Accept 3 selected');
  click(window, '#acceptChanges');
  assert.match(document.querySelector('.toast:last-child').textContent, /3 changes accepted/);

  click(window, '#reviewChanges');
  assert.equal(document.querySelectorAll('.change-check:checked').length, 3);
  click(window, '.cancel-button');

  click(window, '#mergeButton');
  assert.match(document.querySelector('.modal').textContent, /3 accepted changes/);
  assert.match(document.querySelector('.modal').textContent, /Before contrarian merge/);
  click(window, '#confirmMerge');
  assert.equal(document.querySelector('.unsaved-dot'), null);
  assert.match(document.querySelector('.toast:last-child').textContent, /checkpoint created/);

  click(window, '#mergeButton');
  assert.equal(document.querySelector('#confirmMerge').disabled, true);
  assert.match(document.querySelector('#confirmMerge').textContent, /Select changes first/);
});

test('restores a checkpoint while preserving a recovery branch', (t) => {
  const window = setup(t);
  const { document } = window;

  click(window, '.doc-more');
  click(window, '[data-checkpoint="Evidence synthesis complete"]');
  assert.match(document.querySelector('.toast').textContent, /recovery branch/);
  assert.equal(document.querySelector('#modalBackdrop').hidden, true);
});

test('supervises jobs and resolves an agent exception', (t) => {
  const window = setup(t);
  const { document } = window;

  click(window, '#trayToggle');
  assert.ok(document.querySelector('.operations-tray').classList.contains('open'));
  const pause = click(window, '.job-action:not(.resolve-exception)');
  assert.equal(pause.textContent, 'Resume');

  click(window, '#exceptionCard');
  click(window, 'input[name="exception"][value="public"]');
  click(window, '#resolveException');
  assert.match(document.querySelector('.toast:last-child').textContent, /public sources/);
  assert.equal(document.querySelector('#exceptionCard'), null);
  assert.equal(document.querySelector('.attention-job'), null);
});

test('converts chat output into a durable workspace object', (t) => {
  const window = setup(t);
  const { document } = window;

  click(window, '#chatLauncher');
  assert.ok(document.querySelector('#chatPanel').classList.contains('open'));
  click(window, '[data-drop="Decision"]');
  assert.match(document.querySelector('.toast').textContent, /saved as Decision/);
});

test('opens the command palette from the keyboard and dismisses it safely', (t) => {
  const window = setup(t);
  const { document, KeyboardEvent } = window;

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  assert.ok(document.querySelector('#commandInput'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('#modalBackdrop').hidden, true);
});

test('supports alternate conflict outcomes', async (t) => {
  await t.test('keeps an explicit branch override', (subtest) => {
    const window = setup(subtest);
    const { document } = window;
    click(window, '#inlineConflict button');
    click(window, 'input[name="target"][value="4h"]');
    click(window, '#applyConflict');
    assert.ok(document.querySelector('#inlineConflict'));
    assert.match(document.querySelector('.toast').textContent, /4h target selected/);
  });

  await t.test('converts uncertainty into an open question', (subtest) => {
    const window = setup(subtest);
    const { document } = window;
    click(window, '#inlineConflict button');
    click(window, 'input[name="target"][value="question"]');
    click(window, '#applyConflict');
    assert.match(document.querySelector('.toast').textContent, /open question created/);
  });
});

test('supports request, cancel, pause, and resume operations paths', async (t) => {
  await t.test('requests source access', (subtest) => {
    const window = setup(subtest);
    const { document } = window;
    click(window, '#exceptionCard');
    click(window, '#resolveException');
    assert.match(document.querySelector('.toast').textContent, /Access request created/);
  });

  await t.test('cancels while preserving partial findings', (subtest) => {
    const window = setup(subtest);
    const { document } = window;
    click(window, '#exceptionCard');
    click(window, 'input[name="exception"][value="cancel"]');
    click(window, '#resolveException');
    assert.match(document.querySelector('.toast').textContent, /partial findings preserved/);
  });

  const window = setup(t);
  const pause = click(window, '.job-action:not(.resolve-exception)');
  assert.equal(pause.textContent, 'Resume');
  pause.click();
  assert.equal(pause.textContent, 'Pause');
});

test('edits the durable workspace intent', (t) => {
  const window = setup(t);
  const { document } = window;
  click(window, '#intentCard');
  const outcome = document.querySelector('.intent-item p[contenteditable="true"]');
  outcome.textContent = 'Ship an evaluation strategy with named owners.';
  click(window, '#saveIntent');
  assert.match(document.querySelector('.toast').textContent, /Intent updated/);
});

test('filters and dispatches commands from the palette', (t) => {
  const window = setup(t);
  const { document, Event } = window;
  click(window, '#commandButton');
  const input = document.querySelector('#commandInput');
  input.value = 'checkpoint';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(document.querySelector('[data-command="new"]').style.display, 'none');
  click(window, '[data-command="rollback"]');
  assert.match(document.querySelector('#modalTitle').textContent, /checkpoints/i);
});

test('navigates tabs, branches, split views, and inspector visibility', (t) => {
  const window = setup(t);
  const { document } = window;

  click(window, '.tab:nth-child(2)');
  assert.ok(document.querySelector('.tab:nth-child(2)').classList.contains('active'));
  click(window, '.tree-row[data-branch="Contrarian review"]');
  assert.ok(document.querySelector('.tree-row[data-branch="Contrarian review"]').classList.contains('active'));

  click(window, '.seg-button:nth-child(2)');
  assert.equal(document.querySelector('.alternative-document').style.display, 'none');
  click(window, '.seg-button:first-child');
  assert.notEqual(document.querySelector('.alternative-document').style.display, 'none');

  click(window, '.close-inspector');
  assert.equal(document.querySelector('.inspector').style.display, 'none');
});

test('submits chat and supports every durable-object target', (t) => {
  const window = setup(t);
  const { document, Event } = window;
  const form = document.querySelector('#chatForm');
  const textarea = form.querySelector('textarea');
  const initialCount = document.querySelectorAll('.chat-message').length;

  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(document.querySelectorAll('.chat-message').length, initialCount);
  textarea.value = 'Turn the rollout risk into a tracked task.';
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(document.querySelectorAll('.chat-message').length, initialCount + 1);

  click(window, '[data-drop="Context"]');
  click(window, '[data-drop="Task"]');
  assert.match(document.querySelector('.toast:last-child').textContent, /saved as Task/);
});

test('opens evidence, criteria, context preview, and activity provenance', (t) => {
  const window = setup(t);
  const { document } = window;

  click(window, '[data-inspector="evidence"]');
  assert.match(document.querySelector('#modalTitle').textContent, /Evidence record/);
  click(window, '.modal-close');

  click(window, '#criteriaButton');
  assert.match(document.querySelector('.modal').textContent, /Overall: Synthesis 8.2/);
  click(window, '.modal-close');

  click(window, '#previewContext');
  assert.match(document.querySelector('.context-package').textContent, /EXCLUDED/);
  click(window, '.modal-close');

  click(window, '.inspector-tabs [data-panel="activity"]');
  assert.match(document.querySelector('.modal').textContent, /Meaningful checkpoints only/);
});

test('closes a modal from its backdrop', (t) => {
  const window = setup(t);
  const { document, MouseEvent } = window;
  const opener = document.querySelector('#intentCard');
  opener.focus();
  opener.click();
  const backdrop = document.querySelector('#modalBackdrop');
  backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(backdrop.hidden, true);
  assert.equal(document.activeElement, opener);
});

test('uses valid branch controls and traps modal keyboard focus', (t) => {
  const window = setup(t);
  const { document, KeyboardEvent } = window;
  assert.equal(document.querySelector('.tree-section-title button button'), null);
  assert.equal(document.querySelector('.inline-add').parentElement.className, 'tree-section-title');

  click(window, '#intentCard');
  const focusable = [...document.querySelectorAll('.modal button:not([disabled])')];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  last.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(document.activeElement, first);
  first.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.equal(document.activeElement, last);
});

test('blocks merge until the context conflict is resolved', (t) => {
  const window = setup(t);
  const { document } = window;
  click(window, '#mergeButton');
  assert.equal(document.querySelector('#confirmMerge').disabled, true);
  assert.match(document.querySelector('#confirmMerge').textContent, /Resolve conflict first/);
});

test('preserves the original focus owner through multi-step modals', (t) => {
  const window = setup(t);
  const { document } = window;
  const opener = document.querySelector('#newObject');
  opener.focus();
  opener.click();
  click(window, '#generateIntent');
  click(window, '#approveIntent');
  assert.equal(document.activeElement, opener);
});

test('gives icon-only controls accessible names', () => {
  const dom = new JSDOM(html);
  const unnamed = [...dom.window.document.querySelectorAll('button')].filter((button) => {
    const text = button.textContent.trim();
    const label = button.getAttribute('aria-label');
    return !text && !label;
  });
  assert.deepEqual(unnamed, []);
  dom.window.close();
});

test('autosaves edited artifact text', async (t) => {
  const window = setup(t);
  const { document, Event } = window;
  const heading = document.querySelector('[contenteditable="true"]');
  heading.textContent = 'Updated recommendation';
  heading.dispatchEvent(new Event('input', { bubbles: true }));
  assert.match(document.querySelector('.saved').textContent, /Editing/);
  await new Promise((resolve) => window.setTimeout(resolve, 850));
  assert.match(document.querySelector('.saved').textContent, /Saved now/);
});
