const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const backdrop = $('#modalBackdrop');
const modal = $('#modal');
const toastRegion = $('#toastRegion');
let modalOpener = null;
let contextConflictStatus = 'unresolved';

const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const iconShell = document.createElement('span');
  iconShell.innerHTML = icon(type === 'warning' ? 'alert' : 'check');
  const label = document.createElement('span');
  label.textContent = message;
  toast.append(iconShell.firstElementChild, label);
  toastRegion.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('toast-exit');
    window.setTimeout(() => toast.remove(), 220);
  }, 2800);
}

function openModal({ title, subtitle = '', body, footer = '', className = '' }) {
  if (backdrop.hidden) {
    modalOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  $('.app-shell').inert = true;
  modal.className = `modal ${className}`;
  modal.innerHTML = `
    <header class="modal-header">
      <div><h2 id="modalTitle">${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
      <button class="modal-close" aria-label="Close dialog">×</button>
    </header>
    <div class="modal-body">${body}</div>
    ${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}
  `;
  backdrop.hidden = false;
  $('.modal-close', modal).addEventListener('click', closeModal);
  const firstFocus = $('input, textarea, button:not(.modal-close)', modal);
  window.setTimeout(() => firstFocus?.focus(), 20);
}

function closeModal() {
  backdrop.hidden = true;
  modal.innerHTML = '';
  $('.app-shell').inert = false;
  modalOpener?.focus();
  modalOpener = null;
}

backdrop.addEventListener('click', (event) => {
  if (event.target === backdrop) closeModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!backdrop.hidden) closeModal();
    $('#chatPanel').classList.remove('open');
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openCommandPalette();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
    event.preventDefault();
    $('#chatPanel').classList.toggle('open');
  }
  if (event.key === 'Tab' && !backdrop.hidden) {
    const focusable = $$('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', modal);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

function newWorkspaceFlow() {
  openModal({
    title: 'Shape a new workspace',
    subtitle: 'Start in plain language. Threadline turns it into an intent you can inspect.',
    body: `
      <label class="field-label" for="workspacePrompt">What are you trying to accomplish?</label>
      <textarea class="text-field" id="workspacePrompt">Help us figure out how to evaluate our ML models before they cause problems in production.</textarea>
      <label class="field-label" style="margin-top:16px">Choose a workspace mode</label>
      <div class="mode-choices">
        <button class="mode-choice" data-mode="Learning"><span></span><strong>Learning</strong><small>Concept maps, guidance, checks, and reflection.</small></button>
        <button class="mode-choice active" data-mode="Research"><span></span><strong>Research</strong><small>Hypotheses, sources, evidence, and synthesis.</small></button>
        <button class="mode-choice" data-mode="Production"><span></span><strong>Production</strong><small>Plans, tasks, changes, tests, and delivery.</small></button>
      </div>
    `,
    footer: `<span>Nothing runs until you approve the intent.</span><div><button class="cancel-button">Cancel</button><button class="confirm-button" id="generateIntent">Generate intent ${icon('arrow')}</button></div>`
  });
  $$('.mode-choice', modal).forEach((choice) => choice.addEventListener('click', () => {
    $$('.mode-choice', modal).forEach((item) => item.classList.remove('active'));
    choice.classList.add('active');
  }));
  $('.cancel-button', modal).addEventListener('click', closeModal);
  $('#generateIntent', modal).addEventListener('click', reviewGeneratedIntent);
}

function reviewGeneratedIntent() {
  const mode = $('.mode-choice.active', modal)?.dataset.mode || 'Research';
  openModal({
    title: 'Review generated intent',
    subtitle: `Threadline inferred this ${mode.toLowerCase()} workspace from your request. Verify the highlighted assumption.`,
    body: `
      <div class="intent-review">
        <div class="intent-item"><small>Desired outcome</small><p>A reliable evaluation strategy for production ML models.</p></div>
        <div class="intent-item"><small>Success criteria</small><p>Catch critical failures within 24 hours; keep release friction low.</p></div>
        <div class="intent-item"><small>Constraints</small><p>Small platform team; use existing monitoring where possible.</p></div>
        <div class="intent-item"><small>Known facts</small><p>Three production models; current evaluation is offline-only.</p></div>
        <div class="intent-item"><small>Assumption · verify</small><p class="assumption">The team can assign one operational owner per evaluation layer.</p></div>
        <div class="intent-item"><small>Non-goals</small><p>Building a new observability vendor or universal benchmark.</p></div>
        <div class="intent-item"><small>Autonomy policy</small><p>Research and drafting allowed. External actions and merges need approval.</p></div>
        <div class="intent-item"><small>Definition of done</small><p>Approved recommendation, rollout checklist, owners, and checkpoints.</p></div>
      </div>
    `,
    footer: `<span>1 assumption needs confirmation.</span><div><button class="cancel-button">Back</button><button class="confirm-button" id="approveIntent">Approve & create workspace</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', newWorkspaceFlow);
  $('#approveIntent', modal).addEventListener('click', () => {
    closeModal();
    showToast(`${mode} workspace created with a reviewable intent`);
  });
}

function openIntent() {
  openModal({
    title: 'Intent specification',
    subtitle: 'The durable contract for this workspace. Changes flag affected work automatically.',
    body: `
      <div class="intent-review">
        <div class="intent-item"><small>Desired outcome</small><p contenteditable="true">Choose a reliable evaluation strategy for our production ML models.</p></div>
        <div class="intent-item"><small>Motivation</small><p contenteditable="true">Reduce user-facing regressions without freezing model delivery.</p></div>
        <div class="intent-item"><small>Success criteria</small><p contenteditable="true">Critical failures detected within 24h; clear response owner.</p></div>
        <div class="intent-item"><small>Constraints</small><p contenteditable="true">Small platform team; $5k/month operational ceiling.</p></div>
        <div class="intent-item"><small>Known facts</small><p contenteditable="true">Three models in production; offline golden sets exist.</p></div>
        <div class="intent-item"><small>Unknown</small><p class="assumption" contenteditable="true">Can product teams own live outcome signals?</p></div>
        <div class="intent-item"><small>Risk tolerance</small><p contenteditable="true">Conservative for critical slices; experimental elsewhere.</p></div>
        <div class="intent-item"><small>Definition of done</small><p contenteditable="true">Approved memo, owners, rollout sequence, and rollback policy.</p></div>
      </div>
    `,
    footer: `<span>Editing success criteria may mark 2 branches stale.</span><div><button class="cancel-button">Cancel</button><button class="confirm-button" id="saveIntent">Save intent</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', closeModal);
  $('#saveIntent', modal).addEventListener('click', () => {
    closeModal();
    showToast('Intent updated · 2 branches checked for drift');
  });
}

function openContextRegistry() {
  openModal({
    title: 'Context registry',
    subtitle: 'Every item has an owner, source, scope, and visible inheritance path.',
    body: `
      <div class="context-list">
        <button class="context-item" data-context-title="Evaluation incidents · Q2" data-context-scope="Project"><div><strong>Evaluation incidents · Q2</strong><small>Owner: Henry · Internal review · Updated Aug 14</small></div><span class="scope-tag">Project</span><span class="reliability">High reliability</span></button>
        <button class="context-item" data-context-title="Detection target: 24 hours" data-context-scope="Project"><div><strong>Detection target: 24 hours</strong><small>Owner: ML Platform · Intent constraint</small></div><span class="scope-tag">Project</span><span class="reliability">Authoritative</span></button>
        <button class="context-item" data-context-title="Detection target: 4 hours" data-context-scope="Branch"><div><strong>Detection target: 4 hours</strong><small>Owner: Knox · inherited incident policy · overrides target</small></div><span class="scope-tag branch">Contrarian</span><span class="reliability assumption">Conflict</span></button>
        <button class="context-item" data-context-title="Vendor evaluation survey" data-context-scope="Branch"><div><strong>Vendor evaluation survey</strong><small>Owner: Mira · External source · Updated Aug 21</small></div><span class="scope-tag branch">Literature</span><span class="reliability">Medium reliability</span></button>
      </div>
      <div class="context-package">INHERITANCE PREVIEW
project/intent.md
project/incidents-q2.pdf
  ↳ branch/contrarian/incident-policy.md  [OVERRIDES: detection target]
task/challenge-operability.md
ephemeral/none</div>
    `,
    footer: `<span>18.4k tokens in selected package.</span><div><button class="cancel-button">Close</button><button class="confirm-button" id="resolveContext">Resolve conflict</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', closeModal);
  $('#resolveContext', modal).addEventListener('click', openConflictResolver);
  $$('[data-context-title]', modal).forEach((item) => item.addEventListener('click', () => openContextEditor(item.dataset.contextTitle, item.dataset.contextScope)));
}

function openContextEditor(title, scope) {
  openModal({
    title: 'Edit context item',
    subtitle: 'Scope controls which jobs inherit this item. Changes preview affected branches before saving.',
    body: `
      <label class="field-label" for="contextTitle">Context item</label>
      <input class="text-field" id="contextTitle" style="min-height:38px" value="${title.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">
      <div class="context-editor-grid">
        <label><span class="field-label">Scope</span><select id="contextScope"><option ${scope === 'Project' ? 'selected' : ''}>Project</option><option ${scope === 'Branch' ? 'selected' : ''}>Branch</option><option>Task</option><option>Ephemeral</option></select></label>
        <label><span class="field-label">Reliability</span><select id="contextReliability"><option>Authoritative</option><option selected>High</option><option>Medium</option><option>Unverified</option></select></label>
      </div>
      <label class="context-toggle"><input type="checkbox" id="excludeContext"><span><strong>Exclude from the current agent package</strong><small>The item remains in the registry and can be restored later.</small></span></label>
      <div class="context-impact" id="contextImpact"><strong>Inheritance preview</strong><span>Project scope supplies this item to 4 branches and 7 active or queued tasks.</span></div>
    `,
    footer: `<span>Scope and exclusion changes are reversible.</span><div><button class="cancel-button">Cancel</button><button class="confirm-button" id="saveContextItem">Save context</button></div>`
  });
  const updateImpact = () => {
    const selectedScope = $('#contextScope', modal).value;
    const impacts = { Project: '4 branches and 7 active or queued tasks', Branch: 'the selected branch and 2 descendant tasks', Task: '1 task only', Ephemeral: 'one agent run, then it is discarded' };
    $('#contextImpact span', modal).textContent = `${selectedScope} scope supplies this item to ${impacts[selectedScope]}.`;
  };
  $('#contextScope', modal).addEventListener('change', updateImpact);
  $('.cancel-button', modal).addEventListener('click', openContextRegistry);
  $('#saveContextItem', modal).addEventListener('click', () => {
    const selectedScope = $('#contextScope', modal).value;
    const excluded = $('#excludeContext', modal).checked;
    closeModal();
    showToast(`Context saved at ${selectedScope} scope${excluded ? ' and excluded from Sage' : ''}`);
  });
  updateImpact();
}

function openConflictResolver() {
  openModal({
    title: 'Resolve context conflict',
    subtitle: 'Contrarian review inherited an older response target. Choose the rule this branch should use.',
    body: `
      <div class="exception-options">
        <label class="exception-option"><input type="radio" name="target" value="24h" checked><span><strong>Use project target: 24 hours</strong><small>Remove the branch override and keep inherited project intent.</small></span></label>
        <label class="exception-option"><input type="radio" name="target" value="4h"><span><strong>Keep branch override: 4 hours</strong><small>Preserve the challenge, clearly mark it as a branch-level exception.</small></span></label>
        <label class="exception-option"><input type="radio" name="target" value="question"><span><strong>Convert to an open question</strong><small>Pause affected claims until the owner makes an intent-level decision.</small></span></label>
      </div>
    `,
    footer: `<span>Preview: 3 claims and 1 task will update.</span><div><button class="cancel-button">Cancel</button><button class="confirm-button" id="applyConflict">Apply resolution</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', closeModal);
  $('#applyConflict', modal).addEventListener('click', () => {
    const value = $('input[name="target"]:checked', modal).value;
    contextConflictStatus = value;
    changes[1].checked = value === '4h';
    closeModal();
    if (value === '24h') $('#inlineConflict')?.remove();
    showToast(`Context conflict resolved: ${value === 'question' ? 'open question created' : `${value} target selected`}`);
  });
}

function openException() {
  $('#trayToggle').closest('.operations-tray').classList.add('open');
  openModal({
    title: 'Source access expired',
    subtitle: 'Knox paused safely before using an unavailable source.',
    body: `
      <div class="exception-detail">
        <span class="attention-icon">${icon('alert')}</span>
        <div><strong>Internal incident archive requires renewed access</strong><p>The agent cannot verify two claims in the contrarian review. No existing content was changed.</p></div>
      </div>
      <div class="exception-options">
        <label class="exception-option"><input type="radio" name="exception" value="request" checked><span><strong>Request access and resume automatically</strong><small>Creates an approval request for the archive owner.</small></span></label>
        <label class="exception-option"><input type="radio" name="exception" value="public"><span><strong>Continue with public sources</strong><small>Lower confidence; the two internal claims will be excluded.</small></span></label>
        <label class="exception-option"><input type="radio" name="exception" value="cancel"><span><strong>Cancel this job</strong><small>Preserves its partial findings and provenance.</small></span></label>
      </div>
    `,
    footer: `<span>This action is reversible.</span><div><button class="cancel-button">Not now</button><button class="confirm-button" id="resolveException">Continue</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', closeModal);
  $('#resolveException', modal).addEventListener('click', () => {
    const action = $('input[name="exception"]:checked', modal).value;
    closeModal();
    $('#exceptionCard')?.remove();
    $('.attention-job')?.remove();
    const warning = $('.tray-stat.warning');
    if (warning) {
      warning.classList.remove('warning');
      warning.textContent = 'No attention needed';
    }
    showToast(action === 'request' ? 'Access request created · Knox will resume when approved' : action === 'public' ? 'Knox redirected to public sources' : 'Job cancelled · partial findings preserved');
  });
}

const changes = [
  { title: 'Add operational ownership', detail: 'Assign one accountable owner to each evaluation layer.', kind: 'Intent linked', checked: true },
  { title: 'Change detection target', detail: 'Replace the project’s 24-hour target with a 4-hour target.', kind: 'Conflict', checked: false, diff: true },
  { title: 'Add rollout checkpoint', detail: 'Review incident handling after the first 30 days.', kind: 'Evidence linked', checked: true },
  { title: 'Narrow initial canary slices', detail: 'Start with five critical slices before expanding coverage.', kind: 'Alternative', checked: true },
  { title: 'Remove composite-score language', detail: 'Clarify that layers remain independently observable.', kind: 'Decision D-004', checked: true }
];

function openChanges() {
  const availableChanges = changes.map((change, index) => ({ change, index })).filter(({ change }) => !change.merged);
  const targetLocked = contextConflictStatus === '24h' || contextConflictStatus === '4h' || contextConflictStatus === 'question';
  const rows = availableChanges.map(({ change, index }) => `
    <label class="change-item">
      <input class="change-check" type="checkbox" data-change-index="${index}" ${change.checked ? 'checked' : ''} ${index === 1 && targetLocked ? 'disabled' : ''}>
      <span><strong>${change.title}</strong><p>${change.detail}</p>${change.diff ? `<div class="diff-block"><div class="remove">− detect critical regressions within 24 hours</div><div class="add">+ detect critical regressions within 4 hours</div></div>` : ''}</span>
      <em>${change.kind}</em>
    </label>
  `).join('');
  openModal({
    title: 'Review proposed changes',
    subtitle: 'Accept or reject each material change. Rejected items remain in the branch with rationale.',
    body: `
      <div class="changes-summary"><div><strong>7</strong><span>proposed</span></div><div><strong>4</strong><span>artifacts touched</span></div><div><strong>3</strong><span>agents contributed</span></div><div><strong>1</strong><span>context conflict</span></div></div>
      <div class="change-list">${rows}</div>
    `,
    footer: `<span id="selectionSummary">${availableChanges.filter(({ change }) => change.checked).length} of ${availableChanges.length} visible changes selected</span><div><button class="cancel-button">Cancel</button><button class="confirm-button" id="acceptChanges">Accept selected</button></div>`
  });
  const updateCount = () => {
    const count = $$('.change-check:checked', modal).length;
    $('#selectionSummary', modal).textContent = `${count} of ${availableChanges.length} visible changes selected`;
    $('#acceptChanges', modal).textContent = `Accept ${count} selected`;
  };
  $$('.change-check', modal).forEach((checkbox) => checkbox.addEventListener('change', updateCount));
  $('.cancel-button', modal).addEventListener('click', closeModal);
  $('#acceptChanges', modal).addEventListener('click', () => {
    $$('.change-check', modal).forEach((checkbox) => {
      changes[Number(checkbox.dataset.changeIndex)].checked = checkbox.checked;
    });
    const selected = changes.filter((change) => change.checked && !change.merged).length;
    closeModal();
    showToast(`${selected} changes accepted · ${changes.length - selected} preserved for review`);
  });
}

function openMerge() {
  const accepted = changes.filter((change) => change.checked && !change.merged);
  const rejected = changes.filter((change) => !change.checked && !change.merged);
  const conflictBlocksMerge = contextConflictStatus === 'unresolved' || contextConflictStatus === 'question';
  const conflictCopy = contextConflictStatus === 'question'
    ? 'One open question remains and will be linked to the merged artifact.'
    : contextConflictStatus === '4h'
      ? 'The explicit 4-hour branch override will be preserved.'
      : contextConflictStatus === '24h'
        ? 'Resolved. The project-level 24-hour target wins.'
        : 'One unresolved context conflict remains visible for review.';
  openModal({
    title: 'Merge selected results',
    subtitle: 'This creates a named checkpoint first, so the workspace can be rolled back.',
    body: `
      <div class="decision-record">
        <h4>Contrarian review → Synthesis / main</h4>
        <div class="record-meta"><span>${accepted.length} accepted changes</span><span>2 artifacts</span><span>Checkpoint included</span></div>
        <dl class="record-grid">
          <dt>Will merge</dt><dd>${accepted.length ? accepted.map((change) => change.title).join(', ') : 'No changes selected.'}</dd>
          <dt>Will preserve</dt><dd>${rejected.length ? rejected.map((change) => change.title).join(', ') : 'No rejected alternatives.'}</dd>
          <dt>Conflicts</dt><dd>${conflictCopy}</dd>
          <dt>Approval</dt><dd>Required because this changes the main workspace.</dd>
        </dl>
      </div>
    `,
    footer: `<span>Rollback point: “Before contrarian merge”.</span><div><button class="cancel-button">Cancel</button><button class="confirm-button" id="confirmMerge" ${accepted.length && !conflictBlocksMerge ? '' : 'disabled'}>${conflictBlocksMerge ? 'Resolve conflict first' : accepted.length ? 'Create checkpoint & merge' : 'Select changes first'}</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', closeModal);
  $('#confirmMerge', modal).addEventListener('click', () => {
    accepted.forEach((change) => { change.merged = true; });
    closeModal();
    showToast(`Merged ${accepted.length} changes · checkpoint created`);
    $('.change-count').textContent = changes.filter((change) => !change.merged).length + 2;
    $('.unsaved-dot').remove();
  });
}

function openRollback() {
  openModal({
    title: 'Workspace checkpoints',
    subtitle: 'Restore a branch without deleting later work. A recovery branch is kept automatically.',
    body: `
      <div class="rollback-list">
        <div class="rollback-item"><strong>Current state</strong><span>7 proposed changes · moments ago</span></div>
        <div class="rollback-item"><strong>Before contrarian review</strong><span>Named checkpoint · today at 2:14 PM</span><button data-checkpoint="Before contrarian review">Restore this point</button></div>
        <div class="rollback-item"><strong>Evidence synthesis complete</strong><span>Automatic checkpoint · today at 1:38 PM</span><button data-checkpoint="Evidence synthesis complete">Restore this point</button></div>
        <div class="rollback-item"><strong>Initial intent approved</strong><span>Named checkpoint · Aug 20</span><button data-checkpoint="Initial intent approved">Restore this point</button></div>
      </div>
    `,
    footer: `<span>Restoring never deletes newer artifacts.</span><div><button class="cancel-button">Close</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', closeModal);
  $$('[data-checkpoint]', modal).forEach((button) => button.addEventListener('click', () => {
    const checkpoint = button.dataset.checkpoint;
    closeModal();
    showToast(`Restored “${checkpoint}” · newer state saved as recovery branch`);
  }));
}

function openDecision(kind = 'decision') {
  const isEvidence = kind === 'evidence';
  openModal({
    title: isEvidence ? 'Evidence record' : 'Decision record · D-004',
    subtitle: isEvidence ? 'Source provenance and the claims that depend on it.' : 'A concise accountability record, not hidden chain-of-thought.',
    body: isEvidence ? `
      <div class="decision-record"><h4>Internal incident review, Q2 2026</h4><div class="record-meta"><span>Primary source</span><span>High reliability</span><span>Owner: ML Platform</span></div>
      <dl class="record-grid"><dt>Supports</dt><dd>4 claims across the memo and rollout checklist.</dd><dt>Method</dt><dd>Review of 17 production incidents across three deployed models.</dd><dt>Limitation</dt><dd>Does not include slow quality drift without a reported incident.</dd><dt>Used by</dt><dd>Synthesis, Production patterns, Contrarian review.</dd><dt>Last verified</dt><dd>August 21, 2026 by Mira.</dd></dl></div>
    ` : `
      <div class="decision-record"><h4>Adopt layered gates over a composite score</h4><div class="record-meta"><span>High confidence</span><span>Human approved</span><span>August 22, 2026</span></div>
      <dl class="record-grid"><dt>Decision</dt><dd>Keep offline, canary, and live outcomes independently visible rather than compressing them into one score.</dd><dt>Short rationale</dt><dd>Independent gates expose which layer failed and assign a clear response path.</dd><dt>Assumptions</dt><dd>Each layer has an accountable operator and an explicit escalation policy.</dd><dt>Evidence</dt><dd>Internal incident review; 2025 evaluation tooling survey; production-pattern branch.</dd><dt>Alternatives</dt><dd>Weighted composite score; canary-only V1; vendor-defined health index.</dd><dt>Consequence</dt><dd>More operational setup, faster diagnosis, no hidden tradeoffs between dimensions.</dd></dl></div>
    `,
    footer: `<span>${isEvidence ? '4 dependent claims are current.' : 'Approved by Henry · no unresolved objections.'}</span><div><button class="cancel-button">Close</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', closeModal);
}

function openContextPreview() {
  openModal({
    title: 'Exact context package',
    subtitle: 'This is what Sage sees for the current task. Excluded items are not supplied.',
    body: `<div class="context-package"># PROJECT INTENT [authoritative]
Outcome: Choose a reliable evaluation strategy
Success: detect critical failures within 24h
Constraints: small team; cost-aware

# PROJECT CONTEXT [inherited]
• Internal incident review, Q2 [high reliability]
• Existing golden-set inventory [verified]
• Operational budget ceiling [owner: Henry]

# BRANCH CONTEXT [Synthesis / main]
• Accepted findings from production-pattern branch
• Claim–evidence matrix v0.6

# TASK CONTEXT [Draft recommendation memo]
• Structure memo around decision D-004
• Make ownership and rollback explicit

EXCLUDED
• Contrarian 4-hour override [conflicts with project intent]
• Raw chat transcripts [not required]</div>`,
    footer: `<span>18.4k tokens · refreshed 18s ago.</span><div><button class="cancel-button">Close</button><button class="confirm-button" id="editContext">Edit package</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', closeModal);
  $('#editContext', modal).addEventListener('click', openContextRegistry);
}

function openCriteria() {
  openModal({
    title: 'Comparison criteria',
    subtitle: 'Both branches are scored against the same visible standards.',
    body: `
      <div class="context-list">
        <div class="context-item"><div><strong>Failure detection</strong><small>Can it catch critical regressions within the agreed target?</small></div><span class="scope-tag">35%</span><span class="reliability">Synthesis leads</span></div>
        <div class="context-item"><div><strong>Operability</strong><small>Can the current team own and respond to the system?</small></div><span class="scope-tag">30%</span><span class="reliability">Contrarian leads</span></div>
        <div class="context-item"><div><strong>Implementation cost</strong><small>Time and ongoing platform load.</small></div><span class="scope-tag">20%</span><span class="reliability">Close</span></div>
        <div class="context-item"><div><strong>Reversibility</strong><small>Can the team retreat safely if signals misbehave?</small></div><span class="scope-tag">15%</span><span class="reliability">Synthesis leads</span></div>
      </div>
    `,
    footer: `<span>Overall: Synthesis 8.2 · Contrarian 7.7</span><div><button class="cancel-button">Close</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', closeModal);
}

function openCommandPalette() {
  openModal({
    title: 'Go to or run',
    body: `<div class="command-menu">
      <input id="commandInput" placeholder="Search artifacts, branches, agents, or commands…" autocomplete="off">
      <div class="command-group-label">Workspace actions</div>
      <button class="command-item active" data-command="new">${icon('plus')}<span>Create a new workspace</span><kbd>↵</kbd></button>
      <button class="command-item" data-command="fork">${icon('branch')}<span>Fork current branch</span><kbd>⌘⇧F</kbd></button>
      <button class="command-item" data-command="rollback">${icon('history')}<span>Restore a checkpoint</span></button>
      <button class="command-item" data-command="changes">${icon('decision')}<span>Review proposed changes</span></button>
      <div class="command-group-label">Open</div>
      <button class="command-item" data-command="context">${icon('layers')}<span>Context registry</span></button>
      <button class="command-item" data-command="decision">${icon('decision')}<span>Decision D-004</span></button>
    </div>`,
    className: 'command-modal'
  });
  const input = $('#commandInput', modal);
  input.focus();
  input.addEventListener('input', () => {
    const query = input.value.toLowerCase();
    $$('.command-item', modal).forEach((item) => item.style.display = item.textContent.toLowerCase().includes(query) ? 'flex' : 'none');
  });
  $$('.command-item', modal).forEach((item) => item.addEventListener('click', () => runCommand(item.dataset.command)));
}

function runCommand(command) {
  closeModal();
  const actions = { new: newWorkspaceFlow, fork: forkBranch, rollback: openRollback, changes: openChanges, context: openContextRegistry, decision: () => openDecision('decision') };
  actions[command]?.();
}

function forkBranch() {
  openModal({
    title: 'Fork Synthesis / main',
    subtitle: 'The new branch inherits project context and stays isolated until you merge selected results.',
    body: `<label class="field-label" for="branchName">Branch name</label><input class="text-field" id="branchName" style="min-height:38px" value="Operational rollout"><label class="field-label" style="margin-top:14px">Purpose</label><textarea class="text-field" style="min-height:64px">Turn the recommendation into a staged implementation plan with owners and rollback checks.</textarea><label class="field-label" style="margin-top:14px">Assign an agent</label><div class="agent-choices"><label><input type="radio" name="branchAgent" value="Mira" checked><span class="agent-monogram blue">MR</span><span><strong>Mira</strong><small>Research · broad source access</small></span></label><label><input type="radio" name="branchAgent" value="Sage"><span class="agent-monogram green">SG</span><span><strong>Sage</strong><small>Synthesis · guided autonomy</small></span></label><label><input type="radio" name="branchAgent" value="Knox"><span class="agent-monogram orange">KX</span><span><strong>Knox</strong><small>Critic · read-only external access</small></span></label></div>`,
    footer: `<span>7 context items inherited · no overrides.</span><div><button class="cancel-button">Cancel</button><button class="confirm-button" id="createBranch">Create branch</button></div>`
  });
  $('.cancel-button', modal).addEventListener('click', closeModal);
  $('#createBranch', modal).addEventListener('click', () => {
    const name = $('#branchName', modal).value.trim() || 'Untitled branch';
    const agent = $('input[name="branchAgent"]:checked', modal).value;
    closeModal();
    showToast(`Branch “${name}” created and assigned to ${agent}`);
  });
}

$('#newObject').addEventListener('click', newWorkspaceFlow);
$('#intentCard').addEventListener('click', openIntent);
$('#contextRegistry').addEventListener('click', openContextRegistry);
$('#exceptionCard').addEventListener('click', openException);
$('#reviewChanges').addEventListener('click', openChanges);
$('#mergeButton').addEventListener('click', openMerge);
$('#criteriaButton').addEventListener('click', openCriteria);
$('#previewContext').addEventListener('click', openContextPreview);
$('#rationaleButton').addEventListener('click', () => openDecision('decision'));
$('#commandButton').addEventListener('click', openCommandPalette);
$('#inlineConflict')?.querySelector('button').addEventListener('click', openConflictResolver);
$$('[data-inspector]').forEach((button) => button.addEventListener('click', () => openDecision(button.dataset.inspector)));

$$('.tree-section-title').forEach((button) => button.addEventListener('click', (event) => {
  if (event.target.closest('.inline-add')) return;
  button.closest('.tree-section').classList.toggle('collapsed');
}));

$$('.tree-row[data-branch]').forEach((row) => row.addEventListener('click', () => {
  $$('.tree-row[data-branch]').forEach((item) => item.classList.remove('active'));
  row.classList.add('active');
  showToast(`Opened ${row.dataset.branch}`);
}));

const agentPassports = {
  Mira: { initials: 'MR', role: 'Research lead', id: 'agt_19c4', state: 'Running source scan', update: 'Updated 6s ago', objective: 'Expand and verify the evidence base', task: 'Review 24 evaluation sources', parent: 'Literature scan', model: 'GPT-5', autonomy: 'Supervised', used: '$1.12 · 4m 48s', confidence: '76%', confidenceLabel: 'Medium-high', assumptions: '4 sources pending' },
  Sage: { initials: 'SG', role: 'Synthesis lead', id: 'agt_82f1', state: 'Waiting for review', update: 'Updated 18s ago', objective: 'Synthesize a defensible evaluation strategy', task: 'Draft recommendation memo', parent: 'Synthesis / main', model: 'Claude Sonnet 4', autonomy: 'Guided', used: '$1.84 · 6m 12s', confidence: '82%', confidenceLabel: 'High', assumptions: '2 unresolved assumptions' },
  Knox: { initials: 'KX', role: 'Critical reviewer', id: 'agt_4a77', state: 'Blocked by permission', update: 'Updated 1m ago', objective: 'Challenge operability and hidden assumptions', task: 'Verify incident evidence', parent: 'Contrarian review', model: 'GPT-5', autonomy: 'Approval-first', used: '$0.46 · 2m 09s', confidence: '68%', confidenceLabel: 'Moderate', assumptions: '1 source unavailable' }
};

$$('.agent-row').forEach((row) => row.addEventListener('click', () => {
  const passport = agentPassports[row.dataset.agent];
  $('.agent-avatar').childNodes[0].nodeValue = passport.initials;
  $('.passport-identity h2').textContent = row.dataset.agent;
  $('#passportRole').textContent = passport.role;
  $('#passportId').textContent = passport.id;
  $('#passportState').textContent = passport.state;
  $('#passportUpdate').textContent = passport.update;
  $('#passportObjective').textContent = passport.objective;
  $('#passportTask').textContent = passport.task;
  $('#passportParent').textContent = passport.parent;
  $('#passportModel').textContent = passport.model;
  $('#passportAutonomy').textContent = passport.autonomy;
  $('#passportUsed').textContent = passport.used;
  $('#passportConfidence').textContent = passport.confidence;
  $('#passportConfidenceLabel').textContent = passport.confidenceLabel;
  $('#passportAssumptions').textContent = passport.assumptions;
  showToast(`${row.dataset.agent}'s operational passport selected`);
}));

$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  if (tab.classList.contains('add-tab')) {
    openCommandPalette();
    return;
  }
  $$('.tab').forEach((item) => item.classList.remove('active'));
  tab.classList.add('active');
}));

$$('.seg-button').forEach((button, index) => button.addEventListener('click', () => {
  $$('.seg-button').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  $('.document-split').style.gridTemplateColumns = index === 0 ? '1fr 1fr' : '1fr';
  $('.alternative-document').style.display = index === 0 ? '' : 'none';
}));

$('#trayToggle').addEventListener('click', () => $('.operations-tray').classList.toggle('open'));
$$('.resolve-exception').forEach((button) => button.addEventListener('click', openException));
$$('.job-action:not(.resolve-exception)').forEach((button) => button.addEventListener('click', () => {
  button.textContent = button.textContent === 'Pause' ? 'Resume' : 'Pause';
  showToast(`Job ${button.textContent === 'Resume' ? 'paused' : 'resumed'}`);
}));

$$('[data-toast]').forEach((button) => button.addEventListener('click', () => showToast(button.dataset.toast)));

$('#chatLauncher').addEventListener('click', () => $('#chatPanel').classList.add('open'));
$('#closeChat').addEventListener('click', () => $('#chatPanel').classList.remove('open'));
$('#chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const textarea = $('textarea', event.currentTarget);
  if (!textarea.value.trim()) return;
  const message = document.createElement('div');
  message.className = 'chat-message user';
  message.textContent = textarea.value.trim();
  $('.chat-messages').appendChild(message);
  textarea.value = '';
  showToast('Question added to branch transcript');
});

const draggableMessage = $('#draggableMessage');
draggableMessage.addEventListener('dragstart', (event) => {
  event.dataTransfer.setData('text/plain', draggableMessage.textContent.replace('Drag to save', '').trim());
  event.dataTransfer.effectAllowed = 'copy';
});

$$('[data-drop]').forEach((dropzone) => {
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
    event.dataTransfer.dropEffect = 'copy';
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    showToast(`Chat message saved as ${dropzone.dataset.drop}`);
  });
  dropzone.addEventListener('click', () => showToast(`Chat message saved as ${dropzone.dataset.drop}`));
});

$$('.inspector-tabs button[data-panel]').forEach((button) => button.addEventListener('click', () => {
  $$('.inspector-tabs button[data-panel]').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  const panel = button.dataset.panel;
  if (panel === 'context') openContextPreview();
  if (panel === 'activity') {
    openModal({
      title: 'Sage activity',
      subtitle: 'Meaningful checkpoints only. The full transcript remains available for audit.',
      body: `<div class="rollback-list"><div class="rollback-item"><strong>Proposed 2 memo edits</strong><span>18 seconds ago · awaiting review</span></div><div class="rollback-item"><strong>Recorded decision D-004</strong><span>4 minutes ago · human approved</span></div><div class="rollback-item"><strong>Compared 3 branch outputs</strong><span>7 minutes ago · 12 evidence links used</span></div><div class="rollback-item"><strong>Synchronized context package</strong><span>9 minutes ago · 7 items</span></div></div>`,
      footer: `<span>Low-level tool events hidden by default.</span><div><button class="cancel-button">Close</button></div>`
    });
    $('.cancel-button', modal).addEventListener('click', closeModal);
  }
}));

$('.close-inspector').addEventListener('click', () => {
  $('.inspector').style.display = 'none';
  $('.app-shell').style.gridTemplateColumns = '244px minmax(560px, 1fr)';
  $('.app-shell').style.gridTemplateAreas = '"top top" "explorer work" "tray tray"';
});

$('.inline-add').addEventListener('click', (event) => {
  event.stopPropagation();
  forkBranch();
});

document.addEventListener('click', (event) => {
  if (event.target.closest('.doc-more')) openRollback();
});

let saveTimer;
$$('[contenteditable="true"]').forEach((editable) => editable.addEventListener('input', () => {
  $('.saved').innerHTML = `${icon('clock')} Editing…`;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    $('.saved').innerHTML = `${icon('check')} Saved now`;
    showToast('Artifact edit saved to Synthesis / main');
  }, 800);
}));

window.setTimeout(() => {
  const progress = $$('.job-progress i')[0];
  if (progress) progress.style.width = '78%';
}, 2200);
