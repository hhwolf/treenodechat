import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const ONBOARDING_STORAGE_KEY = 'threadline:onboarding-complete:v3';

const onboardingSteps = [
  {
    eyebrow: 'Welcome to Threadline',
    title: 'See the project, not the transcript',
    description: 'In two minutes, you’ll see how Threadline turns a complex coding goal into visible approaches, evidence, questions, and focused branches.'
  },
  {
    target: 'focus',
    view: 'focus',
    eyebrow: 'One · Understand',
    title: 'Start with the decision in front of you',
    description: 'Focus shows only the current goal, plausible approaches, useful evidence, and the question that most needs an answer.'
  },
  {
    target: 'repository',
    view: 'focus',
    eyebrow: 'Two · Ground',
    title: 'Connect reasoning to the real repository',
    description: 'Scan a limited read-only snapshot so approaches and branch analysis can cite project structure without exposing secrets or editing files.'
  },
  {
    target: 'reasoning-items',
    view: 'focus',
    eyebrow: 'Three · Review',
    title: 'AI structure stays provisional',
    description: 'Suggested approaches and interpretations are clearly marked. Confirm what matches your understanding or dismiss what does not.'
  },
  {
    target: 'challenge',
    view: 'focus',
    eyebrow: 'Four · Challenge',
    title: 'Look for what could prove you wrong',
    description: 'Challenge adds a counterpoint or missing case so the workspace supports reasoning, not just confident-looking summaries.'
  },
  {
    target: 'branches',
    view: 'branch',
    eyebrow: 'Five · Explore',
    title: 'Turn an approach into isolated work',
    description: 'Fork promising approaches without contaminating sibling context, then compare and selectively merge what survives review.'
  },
  {
    target: 'agent-runs',
    view: 'branch',
    eyebrow: 'Six · Execute',
    title: 'Supervise real agent work',
    description: 'Start Codex in an isolated Git worktree, watch evidence arrive, pause or cancel safely, and send only decisions that need you to Attention.'
  },
  {
    target: 'inspector',
    view: 'focus',
    eyebrow: 'Seven · Verify',
    title: 'Trace conclusions back to their source',
    description: 'Select any reasoning item to inspect its status, confidence, and provenance—without exposing private chain-of-thought.'
  },
  {
    target: 'advanced',
    expandAdvanced: true,
    eyebrow: 'Eight · Go deeper',
    title: 'Detail is available when you need it',
    description: 'Advanced opens the context registry, recovery points, and activity trail. They stay out of the way until the project needs closer inspection.'
  }
];

const icons = {
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  branch: '<circle cx="7" cy="5" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 7c5 0 3 8 6 8h2M17 9v6"/>',
  layers: '<path d="m12 3 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 17l8 4 8-4"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  activity: '<path d="M4 12h3l2-6 4 12 2-6h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  compare: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  shield: '<path d="M12 3 4 7v5c0 5 3.4 8 8 9 4.6-1 8-4 8-9V7l-8-4Z"/><path d="m9 12 2 2 4-4"/>',
  spark: '<path d="m12 3 1.3 4.2L17 9l-3.7 1.8L12 15l-1.3-4.2L7 9l3.7-1.8L12 3Z"/><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  inbox: '<path d="M4 5h16v14H4z"/><path d="M4 14h4l2 3h4l2-3h4"/>',
  terminal: '<path d="m5 7 4 4-4 4M11 15h7"/>'
};

function Icon({ name, size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icons[name] }} />;
}

function Button({ children, variant = 'secondary', icon, ...props }) {
  return <button className={`button ${variant}`} {...props}>{icon && <Icon name={icon} />}{children}</button>;
}

function OnboardingTour({ stepIndex, layoutKey, onStepChange, onSkip, onFinish }) {
  const step = onboardingSteps[stepIndex];
  const [targetRect, setTargetRect] = useState(null);
  const cardRef = useRef(null);

  useEffect(() => {
    let frame;
    const measure = () => {
      frame = window.requestAnimationFrame(() => {
        const target = step.target ? document.querySelector(`[data-tour="${step.target}"]`) : null;
        if (!target) { setTargetRect(null); return; }
        const rect = target.getBoundingClientRect();
        setTargetRect(rect.width && rect.height ? {
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
          height: rect.height
        } : null);
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step, layoutKey]);

  useEffect(() => {
    cardRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onSkip();
      if (event.key === 'ArrowRight') onStepChange(Math.min(stepIndex + 1, onboardingSteps.length - 1));
      if (event.key === 'ArrowLeft') onStepChange(Math.max(stepIndex - 1, 0));
      if (event.key === 'Tab' && cardRef.current) {
        const controls = [...cardRef.current.querySelectorAll('button:not(:disabled)')];
        if (!controls.length) return;
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [stepIndex, onFinish, onSkip, onStepChange]);

  const cardPosition = (() => {
    if (!targetRect) return { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
    const margin = 16;
    const gap = 18;
    const cardWidth = Math.min(370, window.innerWidth - margin * 2);
    const cardHeight = Math.min(330, window.innerHeight - margin * 2);
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    if (targetRect.right + gap + cardWidth <= window.innerWidth - margin) {
      return { left: targetRect.right + gap, top: clamp(targetRect.top, margin, window.innerHeight - cardHeight - margin) };
    }
    if (targetRect.left - gap - cardWidth >= margin) {
      return { left: targetRect.left - gap - cardWidth, top: clamp(targetRect.top, margin, window.innerHeight - cardHeight - margin) };
    }
    const left = clamp(targetRect.left + targetRect.width / 2 - cardWidth / 2, margin, window.innerWidth - cardWidth - margin);
    if (targetRect.bottom + gap + cardHeight <= window.innerHeight - margin) return { left, top: targetRect.bottom + gap };
    return { left, top: Math.max(margin, targetRect.top - gap - cardHeight) };
  })();

  const spotlightStyle = targetRect ? {
    top: Math.max(6, targetRect.top - 6),
    left: Math.max(6, targetRect.left - 6),
    width: Math.min(window.innerWidth - Math.max(6, targetRect.left - 6) - 6, targetRect.width + 12),
    height: Math.min(window.innerHeight - Math.max(6, targetRect.top - 6) - 6, targetRect.height + 12)
  } : null;
  const isLast = stepIndex === onboardingSteps.length - 1;

  return <div className={`tour-overlay ${targetRect ? 'has-target' : ''}`} role="presentation">
    {spotlightStyle && <div className="tour-spotlight" style={spotlightStyle} aria-hidden="true" />}
    <section className="tour-card" style={cardPosition} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-description" ref={cardRef} tabIndex="-1">
      <header className="tour-card-header">
        <div className="tour-step-count"><span>{String(stepIndex + 1).padStart(2, '0')}</span><small>of {String(onboardingSteps.length).padStart(2, '0')}</small></div>
        <button className="tour-skip" onClick={onSkip}>Skip onboarding</button>
      </header>
      <div className="tour-copy">
        <span className="eyebrow">{step.eyebrow}</span>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-description">{step.description}</p>
      </div>
      <div className="tour-progress" aria-label={`Step ${stepIndex + 1} of ${onboardingSteps.length}`}>
        {onboardingSteps.map((item, index) => <span key={item.title} className={index <= stepIndex ? 'complete' : ''}></span>)}
      </div>
      <footer>
        <Button onClick={() => onStepChange(stepIndex - 1)} disabled={stepIndex === 0}>Back</Button>
        <Button variant="primary" onClick={isLast ? onFinish : () => onStepChange(stepIndex + 1)}>{isLast ? 'Explore Threadline' : 'Next'}</Button>
      </footer>
    </section>
  </div>;
}

function Modal({ title, description, children, onClose }) {
  useEffect(() => {
    const handler = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header><div><h2 id="modal-title">{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></header>
        {children}
      </section>
    </div>
  );
}

function Field({ label, hint, as = 'input', ...props }) {
  const Element = as;
  return <label className="field"><span>{label}</span>{hint && <small>{hint}</small>}<Element {...props} /></label>;
}

function NewProjectModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ name: '', repoPath: '', brief: '' });
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setCreating(true);
    try { await onCreate(form); } catch (caught) { setError(caught.message); setCreating(false); }
  };
  return <Modal title="Start from the work, not a chat" description="Threadline turns a repository and a rough objective into durable shared intent." onClose={onClose}>
    <form className="modal-form" onSubmit={submit}>
      <Field label="Project name" value={form.name} required autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Payments migration" />
      <Field label="Repository path" hint="Threadline scans a secret-filtered snapshot. Agent edits stay in isolated worktrees, never this active checkout." value={form.repoPath} onChange={(event) => setForm({ ...form, repoPath: event.target.value })} placeholder="/Users/you/code/product" />
      <Field as="textarea" label="What are you trying to accomplish?" value={form.brief} required onChange={(event) => setForm({ ...form, brief: event.target.value })} placeholder="Replace the legacy billing flow without changing invoice behavior…" />
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={creating}>{creating ? 'Opening repository…' : 'Create structured intent'}</Button></footer>
    </form>
  </Modal>;
}

function BranchModal({ project, parentId, initial, onClose, onCreate }) {
  const [form, setForm] = useState({ parentId, name: initial?.name || '', purpose: initial?.purpose || '', context: initial?.context || '' });
  return <Modal title="Fork a focused branch" description="The branch inherits project context and adds only the direction below." onClose={onClose}>
    <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onCreate(form); }}>
      <Field as="select" label="Fork from" value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })}>
        {project.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </Field>
      <Field label="Branch name" required autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Safer migration path" />
      <Field as="textarea" label="Purpose" value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} placeholder="Explore a staged approach that preserves rollback…" />
      <Field as="textarea" label="Branch-only context" hint="Visible to this branch and its descendants, not siblings." value={form.context} onChange={(event) => setForm({ ...form, context: event.target.value })} placeholder="Do not change the public API in this branch." />
      <footer><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" icon="branch">Create branch</Button></footer>
    </form>
  </Modal>;
}

function AgentRunModal({ branch, adapter, onClose, onStart }) {
  const [task, setTask] = useState(branch.purpose || `Complete the focused work for ${branch.name} and leave the result ready for review.`);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event) => {
    event.preventDefault();
    setStarting(true);
    setError('');
    try { await onStart(task); } catch (caught) { setError(caught.message); setStarting(false); }
  };
  return <Modal title={`Run an agent on ${branch.name}`} description="Give the agent one concrete, reviewable objective." onClose={onClose}>
    <form className="modal-form" onSubmit={submit}>
      <div className={`adapter-banner ${adapter?.available ? 'available' : 'unavailable'}`}>
        <span><Icon name="terminal" /></span>
        <div><strong>{adapter?.name || 'Coding agent unavailable'}</strong><small>{adapter?.available ? `${adapter.version || 'Ready'} · isolated worktree` : adapter?.error || 'Start Threadline with a supported coding-agent adapter.'}</small></div>
      </div>
      <Field as="textarea" label="Agent task" hint="Keep it narrow enough to verify in one run." required autoFocus value={task} onChange={(event) => setTask(event.target.value)} />
      <p className="safety-note"><Icon name="shield" /><span>Threadline creates an isolated Git worktree from committed HEAD. The agent cannot edit your active checkout, and uncommitted changes there are not included.</span></p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" icon="play" disabled={starting || !adapter?.available}>{starting ? 'Starting…' : 'Start isolated run'}</Button></footer>
    </form>
  </Modal>;
}

function ContextModal({ project, selectedBranchId, onClose, onCreate }) {
  const [form, setForm] = useState({ label: '', value: '', scope: selectedBranchId ? 'branch' : 'project', branchId: selectedBranchId || '', sensitivity: 'shared' });
  return <Modal title="Add context" description="Scope and sensitivity determine exactly which agents can receive this information." onClose={onClose}>
    <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onCreate(form); }}>
      <Field label="Label" required value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="Compatibility constraint" />
      <Field as="textarea" label="Information" required value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} placeholder="The public API must remain backward compatible." />
      <div className="field-row">
        <Field as="select" label="Scope" value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value, branchId: event.target.value === 'project' ? '' : form.branchId || selectedBranchId || project.branches[0].id })}>
          <option value="project">Entire project</option><option value="branch">One branch</option>
        </Field>
        <Field as="select" label="Access" value={form.sensitivity} onChange={(event) => setForm({ ...form, sensitivity: event.target.value })}>
          <option value="shared">Available to agents</option><option value="private">Private to you</option><option value="restricted">Restricted</option>
        </Field>
      </div>
      {form.scope === 'branch' && <Field as="select" label="Branch" value={form.branchId} onChange={(event) => setForm({ ...form, branchId: event.target.value })}>{project.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</Field>}
      <footer><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary">Add context</Button></footer>
    </form>
  </Modal>;
}

function MergeModal({ project, source, onClose, onMerge }) {
  const target = project.branches.find((branch) => !branch.parentId) || project.branches[0];
  const changes = source.output.changes || [];
  const [acceptedIds, setAcceptedIds] = useState(changes.filter((change) => change.selected !== false).map((change) => change.id));
  const toggle = (id) => setAcceptedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  return <Modal title={`Review ${source.name}`} description={`Choose exactly what crosses into ${target.name}. A rollback checkpoint is created automatically.`} onClose={onClose}>
    <div className="change-list">
      {changes.length ? changes.map((change) => <label className="change-item" key={change.id}>
        <input type="checkbox" checked={acceptedIds.includes(change.id)} onChange={() => toggle(change.id)} />
        <span><strong>{change.title}</strong><small>{change.detail}</small></span>
      </label>) : <div className="empty-state compact"><strong>No reviewable changes yet</strong><p>Complete branch work before merging it.</p></div>}
    </div>
    <footer className="modal-footer"><span>{acceptedIds.length} of {changes.length} selected</span><div><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!acceptedIds.length} onClick={() => onMerge({ sourceId: source.id, targetId: target.id, acceptedIds })}>Merge selected</Button></div></footer>
  </Modal>;
}

function BranchTree({ project, selectedId, filter, onSelect }) {
  const children = useMemo(() => {
    const map = new Map();
    project.branches.forEach((branch) => {
      const key = branch.parentId || 'root';
      map.set(key, [...(map.get(key) || []), branch]);
    });
    return map;
  }, [project.branches]);
  const render = (parent = 'root', depth = 0) => (children.get(parent) || []).map((branch) => {
    const visible = !filter || `${branch.name} ${branch.purpose}`.toLowerCase().includes(filter.toLowerCase());
    return <div key={branch.id} className={!visible ? 'filtered-out' : ''}>
      <button className={`nav-row branch-row ${selectedId === branch.id ? 'selected' : ''}`} style={{ '--depth': depth }} onClick={() => onSelect(branch.id)}>
        <span className={`branch-node ${branch.status}`}></span><span className="row-copy"><strong>{branch.name}</strong><small>{branch.status}</small></span>
      </button>
      {render(branch.id, depth + 1)}
    </div>;
  });
  return <div className="branch-tree">{render()}</div>;
}

const reasoningLabels = {
  approach: 'Approach',
  evidence: 'Evidence',
  assumption: 'Assumption',
  question: 'Open question',
  counterpoint: 'Counterpoint',
  decision: 'Decision'
};

function ReasoningItem({ item, onInspect, onResolve, onFork }) {
  return <article className={`reasoning-item ${item.kind} ${item.status}`} onClick={() => onInspect(item)}>
    <header><span className={`reasoning-kind ${item.kind}`}>{reasoningLabels[item.kind]}</span><span className={`reasoning-status ${item.status}`}>{item.status}</span></header>
    <h3>{item.title}</h3>
    <p>{item.summary}</p>
    <footer>
      <button className="source-button" onClick={(event) => { event.stopPropagation(); onInspect(item); }}>{item.sourceLabel}</button>
      <div>
        {item.kind === 'approach' && !item.branchId && <button onClick={(event) => { event.stopPropagation(); onFork(item); }}>Fork</button>}
        {item.status === 'proposed' && <><button onClick={(event) => { event.stopPropagation(); onResolve(item, 'rejected'); }}>Dismiss</button><button className="confirm-action" onClick={(event) => { event.stopPropagation(); onResolve(item, 'confirmed'); }}>Confirm</button></>}
      </div>
    </footer>
  </article>;
}

function FocusView({ project, onDraft, onResolve, onChallenge, onInspect, onFork, onScan }) {
  const [drafting, setDrafting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const active = project.reasoning || [];
  const approaches = active.filter((item) => item.kind === 'approach');
  const evidence = active.filter((item) => item.kind === 'evidence');
  const thinking = active.filter((item) => ['assumption', 'question', 'counterpoint', 'decision'].includes(item.kind));
  const pending = active.filter((item) => item.status === 'proposed').length;
  const refresh = async () => {
    setDrafting(true);
    try { await onDraft(); } finally { setDrafting(false); }
  };
  const scan = async () => {
    setScanning(true);
    try { await onScan(); } finally { setScanning(false); }
  };

  return <article className="focus-view">
    <div className="view-heading focus-heading"><div><span className="eyebrow">Project focus</span><h1>{project.intent.objective}</h1><p>Review the current frame before committing work to a branch.</p></div><div><Button icon="spark" disabled={drafting} onClick={refresh}>{drafting ? 'Thinking…' : active.length ? 'Refresh focus' : 'Draft focus'}</Button></div></div>
    <section className={`repository-strip ${project.repository?.scannedAt ? 'connected' : ''}`} data-tour="repository">
      <div><span className="repository-state"><i></i>{project.repository?.scannedAt ? `${project.repository.name} · ${project.repository.branch}` : 'Repository not scanned'}</span><strong>{project.repository?.scannedAt ? `${project.repository.fileCount} tracked files · ${project.repository.changedFiles?.length || 0} local changes` : project.repoPath || 'Add a repository path to ground this project.'}</strong>{project.repository?.scannedAt && <small>Updated {new Date(project.repository.scannedAt).toLocaleString()}</small>}</div>
      <Button onClick={scan} disabled={scanning || !project.repoPath}>{scanning ? 'Scanning…' : project.repository?.scannedAt ? 'Refresh repository' : 'Scan repository'}</Button>
    </section>
    {!active.length ? <section className="focus-empty" data-tour="reasoning-items"><div className="empty-graphic"><Icon name="spark" size={24} /></div><h2>Make the reasoning visible</h2><p>Threadline will draft a few approaches, evidence items, assumptions, and the question that matters most. Nothing is accepted automatically.</p><Button variant="primary" data-tour="challenge" onClick={refresh} disabled={drafting}>{drafting ? 'Drafting…' : 'Draft reasoning focus'}</Button></section> : <>
      <section className="focus-summary" data-tour="reasoning-items"><div><span className="eyebrow">Current frame</span><strong>{approaches.length} approach{approaches.length === 1 ? '' : 'es'} · {evidence.length} evidence item{evidence.length === 1 ? '' : 's'}</strong><p>{pending ? `${pending} suggestion${pending === 1 ? '' : 's'} still need your review.` : 'Every visible item has been reviewed.'}</p></div><div className="focus-legend"><span><i className="confirmed-dot"></i>Confirmed</span><span><i className="proposed-dot"></i>Proposed</span></div></section>
      <section className="reasoning-section"><header><div><span className="eyebrow">Possible paths</span><h2>Approaches worth comparing</h2></div></header><div className="approach-grid">{approaches.map((item) => <ReasoningItem key={item.id} item={item} onInspect={onInspect} onResolve={onResolve} onFork={onFork} />)}</div></section>
      <div className="reasoning-columns">
        <section className="reasoning-section"><header><div><span className="eyebrow">Grounding</span><h2>Evidence in view</h2></div></header><div className="reasoning-list">{evidence.length ? evidence.map((item) => <ReasoningItem key={item.id} item={item} onInspect={onInspect} onResolve={onResolve} onFork={onFork} />) : <p className="quiet-empty">No evidence has been attached yet.</p>}</div></section>
        <section className="reasoning-section"><header><div><span className="eyebrow">Think twice</span><h2>Questions and assumptions</h2></div><Button data-tour="challenge" onClick={onChallenge}>Challenge</Button></header><div className="reasoning-list">{thinking.map((item) => <ReasoningItem key={item.id} item={item} onInspect={onInspect} onResolve={onResolve} onFork={onFork} />)}</div></section>
      </div>
    </>}
  </article>;
}

function IntentView({ project, onSave, onDraft }) {
  const [intent, setIntent] = useState(project.intent);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => setIntent(project.intent), [project]);
  const update = (field, value) => setIntent((current) => ({ ...current, [field]: value }));
  const refine = async () => {
    setDrafting(true);
    const drafted = await onDraft(intent.objective);
    setIntent(drafted);
    setDrafting(false);
  };
  return <article className="intent-view">
    <div className="view-heading"><div><span className="eyebrow">Project intent</span><h1>{project.name}</h1><p>One durable contract for every human and agent working in this repository.</p></div><div><Button icon="spark" disabled={drafting} onClick={refine}>{drafting ? 'Drafting…' : 'Refine spec'}</Button><Button variant="primary" onClick={() => onSave(intent)}>Save intent</Button></div></div>
    <section className="intent-grid">
      <Field as="textarea" label="Objective" value={intent.objective} onChange={(event) => update('objective', event.target.value)} />
      <Field as="textarea" label="Who this is for" value={intent.audience} onChange={(event) => update('audience', event.target.value)} />
      <Field as="textarea" label="Desired outcome" value={intent.outcome} onChange={(event) => update('outcome', event.target.value)} />
      <Field as="textarea" label="What to avoid" value={intent.avoid} onChange={(event) => update('avoid', event.target.value)} />
      <Field as="textarea" label="Output format" value={intent.format} onChange={(event) => update('format', event.target.value)} />
      <Field as="textarea" label="What good looks like" value={intent.qualityBar} onChange={(event) => update('qualityBar', event.target.value)} />
    </section>
    <section className="questions-card"><div><span className="eyebrow">Before work starts</span><h2>Questions that still matter</h2></div><ol>{intent.questions.map((question, index) => <li key={`${question}-${index}`}>{question}</li>)}</ol></section>
  </article>;
}

const activeRunStatuses = new Set(['queued', 'running', 'paused']);

function AgentRunPanel({ run, adapter, onStart, onControl }) {
  const [expandedDiff, setExpandedDiff] = useState(false);
  if (!run) return <section className="agent-panel agent-empty" data-tour="agent-runs">
    <div className="agent-empty-copy"><span className="agent-mark"><Icon name="terminal" /></span><div><span className="eyebrow">Agent execution</span><h2>Turn this branch into supervised work</h2><p>Codex works in an isolated Git worktree while Threadline keeps progress, evidence, and control visible.</p></div></div>
    <Button variant="primary" icon="play" onClick={onStart} disabled={!adapter?.available}>Run with {adapter?.name || 'Codex'}</Button>
  </section>;

  const canPause = run.status === 'running';
  const canResume = run.status === 'paused';
  const canCancel = activeRunStatuses.has(run.status);
  return <section className="agent-panel" data-tour="agent-runs">
    <header className="agent-panel-header">
      <div><span className="eyebrow">Agent execution</span><div className="agent-title"><h2>{run.task}</h2><span className={`run-status ${run.status}`}><i></i>{run.status}</span></div></div>
      <div className="agent-controls">
        {canPause && <Button icon="pause" onClick={() => onControl(run, 'pause')}>Pause</Button>}
        {canResume && <Button icon="play" onClick={() => onControl(run, 'resume')}>Resume</Button>}
        {canCancel && <Button icon="stop" onClick={() => onControl(run, 'cancel')}>Cancel run</Button>}
        {!canCancel && <Button icon="play" onClick={onStart}>Run again</Button>}
      </div>
    </header>
    <div className="run-layout">
      <div className="run-events" aria-label="Agent event stream">
        {(run.events || []).length ? run.events.map((event) => <div className="run-event" key={event.id}><span></span><div><strong>{event.kind.replaceAll('_', ' ')}</strong><p>{event.message}</p><small>{new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small></div></div>) : <p className="quiet-empty">Waiting for the first agent event…</p>}
      </div>
      <aside className="run-evidence">
        <div><span>Adapter</span><strong>{run.adapter}</strong></div>
        <div><span>Changed files</span><strong>{run.files?.length || 0}</strong></div>
        {run.baseCommit && <div><span>Based on</span><strong>{run.baseCommit.slice(0, 8)}</strong></div>}
        {run.diffStat && <pre>{run.diffStat}</pre>}
        {run.diff && <button className="diff-toggle" onClick={() => setExpandedDiff(!expandedDiff)}>{expandedDiff ? 'Hide diff' : 'Inspect diff'}</button>}
      </aside>
    </div>
    {run.summary && <p className="run-summary">{run.summary}</p>}
    {expandedDiff && run.diff && <pre className="diff-preview">{run.diff}</pre>}
    {run.worktreePath && <p className="worktree-path"><Icon name="shield" />Isolated at <code>{run.worktreePath}</code></p>}
  </section>;
}

function BranchView({ project, branch, contexts, runs, adapter, onUpdate, onFork, onMerge, onAnalyze, onStartAgent, onControlAgent }) {
  const [analyzing, setAnalyzing] = useState(false);
  const parent = project.branches.find((item) => item.id === branch.parentId);
  const changes = branch.output.changes || [];
  const latestRun = runs[0];
  const transition = branch.status === 'ready' ? { label: 'Start work', status: 'active' } : branch.status === 'active' ? { label: 'Send to review', status: 'review' } : null;
  return <article className="branch-view">
    <div className="view-heading branch-heading"><div><span className="eyebrow">{parent ? `Forked from ${parent.name}` : 'Main branch'}</span><h1>{branch.name}</h1><p>{branch.purpose || 'No branch purpose has been written yet.'}</p></div><div><Button variant="primary" icon="spark" disabled={analyzing} onClick={async () => { setAnalyzing(true); try { await onAnalyze(); } finally { setAnalyzing(false); } }}>{analyzing ? 'Analyzing…' : changes.length ? 'Re-analyze' : 'Analyze branch'}</Button>{transition && <Button onClick={() => onUpdate({ status: transition.status })}>{transition.label}</Button>}<Button icon="branch" onClick={onFork}>Fork</Button></div></div>
    <div className="branch-summary-grid">
      <section className="output-card"><header><div><span className={`status-pill ${branch.status}`}>{branch.status}</span><h2>Current output</h2></div><span className="updated">Updated {new Date(branch.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></header><p>{branch.output.summary || 'This branch has not produced an output yet.'}</p></section>
      <section className="understanding-card"><span className="eyebrow">Shared understanding</span><strong>{contexts.length} context items available</strong><p>{contexts.some((item) => item.sensitivity !== 'shared') ? 'Private context is excluded from agents.' : 'Every listed item is available to this branch.'}</p></section>
    </div>
    <AgentRunPanel run={latestRun} adapter={adapter} onStart={onStartAgent} onControl={onControlAgent} />
    <section className="changes-section"><header><div><span className="eyebrow">Reviewable work</span><h2>Proposed changes</h2></div>{branch.parentId && changes.length > 0 && branch.status !== 'merged' && <Button icon="compare" onClick={onMerge}>Compare and merge</Button>}</header>
      {changes.length ? <div className="proposed-changes">{changes.map((change) => <div className="proposed-change" key={change.id}><span className="change-mark"><Icon name="check" /></span><div><strong>{change.title}</strong><p>{change.detail}</p>{change.mergedFrom && <small>Merged from another branch</small>}</div></div>)}</div> : <div className="empty-state"><div className="empty-graphic"><Icon name="branch" size={24} /></div><strong>No proposed changes yet</strong><p>Start the branch after its purpose and inherited context look right.</p></div>}
    </section>
  </article>;
}

function AttentionView({ project, onOpenBranch, onResolve }) {
  const open = project.attentionItems.filter((item) => item.status === 'open');
  const resolved = project.attentionItems.filter((item) => item.status === 'resolved');
  const renderItem = (item) => {
    const branch = project.branches.find((candidate) => candidate.id === item.branchId);
    return <article className={`attention-item ${item.severity}`} key={item.id}>
      <span className="attention-icon"><Icon name={item.kind === 'failure' ? 'stop' : 'inbox'} /></span>
      <div><header><span className="eyebrow">{item.kind} · {branch?.name || 'Project'}</span><small>{new Date(item.createdAt).toLocaleString()}</small></header><h2>{item.title}</h2><p>{item.detail}</p><footer>{branch && <Button onClick={() => onOpenBranch(branch.id)}>Open branch</Button>}{item.status === 'open' && <Button variant="primary" onClick={() => onResolve(item)}>Mark resolved</Button>}</footer></div>
    </article>;
  };
  return <article className="attention-view">
    <div className="view-heading"><div><span className="eyebrow">Human attention</span><h1>Only the work that needs you</h1><p>Completed reviews, failures, and decisions arrive here instead of interrupting every active agent.</p></div><span className="attention-count">{open.length} open</span></div>
    <section className="attention-list">{open.length ? open.map(renderItem) : <div className="empty-state"><div className="empty-graphic"><Icon name="check" size={24} /></div><strong>Nothing needs your attention</strong><p>Active agents can keep moving until a decision or review is ready.</p></div>}</section>
    {resolved.length > 0 && <details className="resolved-attention"><summary>{resolved.length} resolved item{resolved.length === 1 ? '' : 's'}</summary><div className="attention-list">{resolved.map(renderItem)}</div></details>}
  </article>;
}

function ContextView({ project, onAdd }) {
  return <article className="context-view"><div className="view-heading"><div><span className="eyebrow">Advanced</span><h1>Context registry</h1><p>Inspect what agents know, where it applies, and what stays private.</p></div><Button variant="primary" icon="plus" onClick={onAdd}>Add context</Button></div>
    <div className="context-table" role="table"><div className="context-row context-header" role="row"><span>Context</span><span>Scope</span><span>Access</span><span>Source</span></div>{project.contexts.map((item) => <div className="context-row" role="row" key={item.id}><span><strong>{item.label}</strong><small>{item.value}</small></span><span className="tag">{item.scope === 'project' ? 'Project' : project.branches.find((branch) => branch.id === item.branchId)?.name}</span><span className={`tag ${item.sensitivity}`}>{item.sensitivity}</span><span>{item.source}</span></div>)}</div>
  </article>;
}

function RecoveryView({ project, onCheckpoint, onRestore }) {
  return <article><div className="view-heading"><div><span className="eyebrow">Advanced</span><h1>Recovery</h1><p>Every material merge gets a checkpoint. Restoring never deletes the checkpoint itself.</p></div><Button variant="primary" onClick={onCheckpoint}>Create checkpoint</Button></div>
    <div className="checkpoint-list">{project.checkpoints.map((checkpoint) => <div className="checkpoint" key={checkpoint.id}><span className="checkpoint-icon"><Icon name="history" /></span><div><strong>{checkpoint.name}</strong><small>{new Date(checkpoint.createdAt).toLocaleString()}</small></div><Button onClick={() => onRestore(checkpoint)}>Restore</Button></div>)}</div>
  </article>;
}

function ActivityView({ project }) {
  return <article><div className="view-heading"><div><span className="eyebrow">Advanced</span><h1>Activity</h1><p>A concise audit trail of decisions and state changes, not a transcript.</p></div></div><div className="timeline">{project.events.map((event) => <div className="timeline-event" key={event.id}><span></span><div><strong>{event.summary}</strong><small>{event.kind} · {new Date(event.createdAt).toLocaleString()}</small></div></div>)}</div></article>;
}

function Inspector({ project, branch, contexts, reasoningItem }) {
  return <aside className="inspector" aria-label="Current understanding">
    {reasoningItem ? <section className="reasoning-inspector"><span className="eyebrow">{reasoningLabels[reasoningItem.kind]}</span><h2>{reasoningItem.title}</h2><p>{reasoningItem.summary}</p><dl><div><dt>Status</dt><dd>{reasoningItem.status}</dd></div><div><dt>Confidence</dt><dd>{reasoningItem.confidence || 'Not stated'}</dd></div><div><dt>Source</dt><dd>{reasoningItem.sourceLabel}</dd></div></dl></section> : <section><span className="eyebrow">Current understanding</span><h2>{branch?.name || project.name}</h2><p>{branch?.purpose || project.intent.objective}</p></section>}
    {branch && <section><div className="section-label"><span>Context supplied</span><span>{contexts.length}</span></div><div className="context-stack">{contexts.slice(0, 5).map((item) => <div key={item.id}><strong>{item.label}</strong><small>{item.scope === 'project' ? 'Inherited from project' : 'Inherited from branch'}</small></div>)}</div></section>}
    <section className="guardrail-card"><div><Icon name="shield" /><strong>Autonomy boundary</strong></div><p>Agents can read shared repository context and take reversible actions. Private, external, and irreversible actions remain gated.</p></section>
    <section><div className="section-label"><span>Recent activity</span></div>{project.events.slice(0, 3).map((event) => <div className="mini-event" key={event.id}><span></span><p>{event.summary}</p></div>)}</section>
  </aside>;
}

export function App() {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [adapter, setAdapter] = useState(null);
  const [selection, setSelection] = useState({ type: 'focus', id: null });
  const [contexts, setContexts] = useState([]);
  const [advanced, setAdvanced] = useState(false);
  const [filter, setFilter] = useState('');
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const [inspectedReasoningId, setInspectedReasoningId] = useState(null);
  const [branchDraft, setBranchDraft] = useState(null);

  const notify = (message) => {
    setToast(message);
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(''), 3200);
  };

  const refreshProjects = async (selectId) => {
    const result = await api.listProjects();
    setProjects(result.projects);
    const id = selectId || project?.id || result.projects[0]?.id;
    if (id) {
      const loaded = await api.getProject(id);
      setProject(loaded.project);
    }
    setLoading(false);
  };

  useEffect(() => {
    Promise.all([refreshProjects(), api.listAdapters().then((result) => setAdapter(result.adapters[0] || null))])
      .catch((error) => { notify(error.message); setLoading(false); });
  }, []);

  useEffect(() => {
    const hasActiveRun = project?.agentRuns?.some((run) => activeRunStatuses.has(run.status));
    if (!hasActiveRun) return undefined;
    const interval = window.setInterval(async () => {
      try {
        const result = await api.getProject(project.id);
        setProject(result.project);
      } catch { /* A transient poll failure should not interrupt the workspace. */ }
    }, 1200);
    return () => window.clearInterval(interval);
  }, [project?.id, project?.agentRuns?.map((run) => `${run.id}:${run.status}`).join('|')]);

  useEffect(() => {
    if (!project) return;
    try {
      if (!window.localStorage.getItem(ONBOARDING_STORAGE_KEY)) setTourOpen(true);
    } catch {
      setTourOpen(true);
    }
  }, [project?.id]);

  useEffect(() => {
    if (!tourOpen || !project) return;
    const step = onboardingSteps[tourStep];
    if (step.view === 'focus') setSelection({ type: 'focus', id: null });
    if (step.view === 'intent') setSelection({ type: 'intent', id: null });
    if (step.view === 'branch') {
      const branch = project.branches.find((item) => item.parentId) || project.branches[0];
      if (branch) setSelection({ type: 'branch', id: branch.id });
    }
    if (step.expandAdvanced) setAdvanced(true);
  }, [tourOpen, tourStep, project?.id]);

  const closeTour = () => {
    try { window.localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true'); } catch { /* Local storage can be unavailable in privacy mode. */ }
    setTourOpen(false);
  };

  const startTour = () => {
    setTourStep(0);
    setTourOpen(true);
  };

  const selectedBranch = selection.type === 'branch' ? project?.branches.find((branch) => branch.id === selection.id) : null;
  const inspectedReasoning = project?.reasoning?.find((item) => item.id === inspectedReasoningId) || null;
  useEffect(() => {
    if (selection.type !== 'focus') setInspectedReasoningId(null);
  }, [selection.type, selection.id]);
  useEffect(() => {
    if (!project || !selectedBranch) { setContexts([]); return; }
    api.inheritedContexts(project.id, selectedBranch.id).then((result) => setContexts(result.contexts)).catch((error) => notify(error.message));
  }, [project?.id, selectedBranch?.id, project?.contexts.length]);

  const applyProject = (next, message) => {
    setProject(next);
    if (message) notify(message);
  };

  const createProject = async (form) => {
    const result = await api.createProject(form);
    setModal(null);
    setSelection({ type: 'focus', id: null });
    await refreshProjects(result.project.id);
    notify('Project created with a structured intent');
  };

  const createBranch = async (form) => {
    const result = await api.createBranch(project.id, form);
    const branch = result.project.branches.at(-1);
    setModal(null);
    setBranchDraft(null);
    setSelection({ type: 'branch', id: branch.id });
    applyProject(result.project, `${branch.name} forked with isolated context`);
  };

  const content = () => {
    if (selection.type === 'focus') return <FocusView project={project} onDraft={async () => { const result = await api.draftReasoning(project.id); applyProject(result.project, result.source === 'model' ? 'Focus drafted with your configured model' : 'Focus drafted locally'); }} onResolve={async (item, status) => { const result = await api.resolveReasoning(project.id, item.id, status); if (status === 'rejected' && inspectedReasoningId === item.id) setInspectedReasoningId(null); applyProject(result.project, status === 'confirmed' ? 'Added to shared understanding' : 'Suggestion dismissed'); }} onChallenge={async () => applyProject((await api.challengeReasoning(project.id)).project, 'Counterpoint added for review')} onInspect={(item) => setInspectedReasoningId(item.id)} onFork={(item) => { setBranchDraft({ name: item.title, purpose: item.summary, context: `Explore this proposed approach without changing sibling context. Source: ${item.sourceLabel}` }); setModal('branch'); }} onScan={async () => { try { applyProject((await api.scanRepository(project.id)).project, 'Repository snapshot refreshed'); } catch (error) { notify(error.message); } }} />;
    if (selection.type === 'intent') return <IntentView project={project} onSave={async (intent) => applyProject((await api.updateIntent(project.id, intent)).project, 'Intent saved')} onDraft={async (brief) => { const result = await api.draftSpec(project.id, brief); notify(result.source === 'model' ? 'Spec refined with your configured model' : 'Spec refined locally'); return result.intent; }} />;
    if (selection.type === 'attention') return <AttentionView project={project} onOpenBranch={(id) => setSelection({ type: 'branch', id })} onResolve={async (item) => applyProject((await api.resolveAttention(project.id, item.id)).project, 'Attention item resolved')} />;
    if (selection.type === 'context') return <ContextView project={project} onAdd={() => setModal('context')} />;
    if (selection.type === 'recovery') return <RecoveryView project={project} onCheckpoint={async () => applyProject((await api.createCheckpoint(project.id, `Manual checkpoint ${project.checkpoints.length + 1}`)).project, 'Checkpoint created')} onRestore={async (checkpoint) => applyProject((await api.restoreCheckpoint(project.id, checkpoint.id)).project, `${checkpoint.name} restored`)} />;
    if (selection.type === 'activity') return <ActivityView project={project} />;
    if (selectedBranch) return <BranchView project={project} branch={selectedBranch} contexts={contexts} runs={project.agentRuns.filter((run) => run.branchId === selectedBranch.id)} adapter={adapter} onUpdate={async (updates) => applyProject((await api.updateBranch(project.id, selectedBranch.id, updates)).project, `${selectedBranch.name} moved to ${updates.status}`)} onFork={() => { setBranchDraft(null); setModal('branch'); }} onMerge={() => setModal('merge')} onAnalyze={async () => { try { const result = await api.analyzeBranch(project.id, selectedBranch.id); applyProject(result.project, result.source === 'model' ? 'Branch analyzed with your configured model' : 'Branch analyzed locally'); } catch (error) { notify(error.message); } }} onStartAgent={() => setModal('agent')} onControlAgent={async (run, action) => { try { const result = await api.controlAgentRun(project.id, run.id, action); applyProject(result.project, action === 'cancel' ? 'Cancellation requested' : `Agent ${action}d`); } catch (error) { notify(error.message); } }} />;
    return null;
  };

  if (loading) return <div className="loading-screen"><div className="brand-mark"><span></span><span></span><span></span></div><p>Loading shared understanding…</p></div>;
  if (!project) return <div className="onboarding"><div className="brand-lockup"><div className="brand-mark"><span></span><span></span><span></span></div><strong>Threadline</strong></div><h1>Keep humans and coding agents<br />on the same page.</h1><p>Open a repository, define what good looks like, and carry that understanding through every branch and change.</p><Button variant="primary" onClick={() => setModal('project')}>Start a project</Button>{modal === 'project' && <NewProjectModal onClose={() => setModal(null)} onCreate={createProject} />}</div>;

  return <div className="app-shell">
    <header className="topbar"><div className="brand-lockup"><div className="brand-mark"><span></span><span></span><span></span></div><strong>Threadline</strong></div><label className="project-select" data-tour="project-switcher"><span className="sr-only">Project</span><select value={project.id} onChange={async (event) => { setSelection({ type: 'focus', id: null }); setInspectedReasoningId(null); const result = await api.getProject(event.target.value); setProject(result.project); }}><option value={project.id}>{project.name}</option>{projects.filter((item) => item.id !== project.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>{project.repoPath || 'No repository selected'}</small></label><div className="top-search"><input aria-label="Filter branches" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter branches…" /></div><div className="top-actions"><span className="local-state"><i></i>Saved locally</span><Button onClick={startTour} icon="spark">Tour</Button><Button onClick={() => setModal('project')} icon="plus">New project</Button></div></header>
    <aside className="sidebar"><div className="sidebar-label"><span>Project</span></div><nav aria-label="Project navigation"><button data-tour="focus" className={`nav-row ${selection.type === 'focus' ? 'selected' : ''}`} onClick={() => setSelection({ type: 'focus', id: null })}><Icon name="spark" /><span className="row-copy"><strong>Focus</strong><small>What needs thinking</small></span></button><button data-tour="intent" className={`nav-row ${selection.type === 'intent' ? 'selected' : ''}`} onClick={() => setSelection({ type: 'intent', id: null })}><Icon name="target" /><span className="row-copy"><strong>Intent</strong><small>What good looks like</small></span></button><button className={`nav-row ${selection.type === 'attention' ? 'selected' : ''}`} onClick={() => setSelection({ type: 'attention', id: null })}><Icon name="inbox" /><span className="row-copy"><strong>Attention</strong><small>Only what needs you</small></span>{project.attentionItems.filter((item) => item.status === 'open').length > 0 && <span className="nav-badge">{project.attentionItems.filter((item) => item.status === 'open').length}</span>}</button><div className="branch-navigation" data-tour="branches"><div className="nav-section-heading"><span>Branches</span><button aria-label="Add branch" onClick={() => { setBranchDraft(null); setModal('branch'); }}><Icon name="plus" /></button></div><BranchTree project={project} selectedId={selection.type === 'branch' ? selection.id : null} filter={filter} onSelect={(id) => setSelection({ type: 'branch', id })} /></div></nav><div className="sidebar-bottom" data-tour="advanced"><button className="advanced-toggle" onClick={() => setAdvanced(!advanced)}><span><Icon name="layers" />Advanced</span><Icon name="chevron" /></button>{advanced && <nav className="advanced-nav"><button className={`nav-row ${selection.type === 'context' ? 'selected' : ''}`} onClick={() => setSelection({ type: 'context' })}><Icon name="layers" />Context</button><button className={`nav-row ${selection.type === 'recovery' ? 'selected' : ''}`} onClick={() => setSelection({ type: 'recovery' })}><Icon name="history" />Recovery</button><button className={`nav-row ${selection.type === 'activity' ? 'selected' : ''}`} onClick={() => setSelection({ type: 'activity' })}><Icon name="activity" />Activity</button></nav>}</div></aside>
    <main className="workspace" data-tour="workspace">{content()}</main>
    <div className="inspector-shell" data-tour="inspector"><Inspector project={project} branch={selectedBranch} contexts={contexts} reasoningItem={inspectedReasoning} /></div>
    {modal === 'project' && <NewProjectModal onClose={() => setModal(null)} onCreate={createProject} />}
    {modal === 'branch' && <BranchModal project={project} parentId={selectedBranch?.id || project.branches[0].id} initial={branchDraft} onClose={() => { setModal(null); setBranchDraft(null); }} onCreate={createBranch} />}
    {modal === 'agent' && selectedBranch && <AgentRunModal branch={selectedBranch} adapter={adapter} onClose={() => setModal(null)} onStart={async (task) => { const result = await api.startAgentRun(project.id, selectedBranch.id, task); setModal(null); applyProject(result.project, `${adapter?.name || 'Agent'} started in an isolated worktree`); }} />}
    {modal === 'context' && <ContextModal project={project} selectedBranchId={selectedBranch?.id} onClose={() => setModal(null)} onCreate={async (form) => { const result = await api.createContext(project.id, form); setModal(null); applyProject(result.project, `${form.label} added`); }} />}
    {modal === 'merge' && selectedBranch && <MergeModal project={project} source={selectedBranch} onClose={() => setModal(null)} onMerge={async (input) => { const result = await api.merge(project.id, input); setModal(null); applyProject(result.project, `${input.acceptedIds.length} changes merged with a recovery checkpoint`); }} />}
    {toast && <div className="toast" role="status"><Icon name="check" />{toast}</div>}
    {tourOpen && <OnboardingTour stepIndex={tourStep} layoutKey={`${selection.type}:${selection.id || ''}:${advanced}`} onStepChange={setTourStep} onSkip={closeTour} onFinish={closeTour} />}
  </div>;
}
