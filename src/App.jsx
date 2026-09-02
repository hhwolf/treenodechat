import { useEffect, useState } from 'react';
import { api, getAccessToken, setAccessToken } from './api.js';
import { Button, Field, Icon, Modal } from './ui.jsx';
import { ChatView } from './chat.jsx';
import { TreeView } from './tree.jsx';
import { RulesView } from './rules.jsx';
import { ShipView } from './ship.jsx';
import { defaultLeaf } from './nodes.js';

const activeRunStatuses = new Set(['queued', 'running', 'paused']);
const tabs = [
  { id: 'chat', label: 'Chat', icon: 'terminal' },
  { id: 'tree', label: 'Tree', icon: 'tree' },
  { id: 'rules', label: 'Rules', icon: 'rules' },
  { id: 'ship', label: 'Ship', icon: 'ship' }
];

function effectiveVerifyCommand(project) {
  if (project.verifyCommand) return project.verifyCommand;
  const excerpt = (project.repository?.excerpts || []).find((item) => item.path === 'package.json' || item.path.endsWith('/package.json'));
  if (!excerpt) return '';
  try {
    const scripts = JSON.parse(excerpt.content).scripts || {};
    return scripts.test && !/no test specified/i.test(scripts.test) ? 'npm test' : '';
  } catch { return ''; }
}

function leafStorageKey(projectId) {
  return `threadline:leaf:${projectId}`;
}

function HostedGate({ configured, onUnlock }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  if (!configured) return <div className="onboarding hosted-gate">
    <div className="brand-lockup"><div className="brand-mark"><span></span><span></span><span></span></div><strong>Threadline</strong></div>
    <span className="eyebrow">Hosted setup required</span>
    <h1>Complete hosted setup<br />before opening the workspace.</h1>
    <p>Add a Postgres integration in Vercel, then configure <code>DATABASE_URL</code> and a strong <code>THREADLINE_ACCESS_TOKEN</code> for Production and Preview.</p>
  </div>;
  return <div className="onboarding hosted-gate">
    <div className="brand-lockup"><div className="brand-mark"><span></span><span></span><span></span></div><strong>Threadline</strong></div>
    <span className="eyebrow">Private workspace</span>
    <h1>Enter your Threadline<br />access code.</h1>
    <p>The code stays in this browser tab and protects project context and agent controls.</p>
    <form className="access-form" onSubmit={async (event) => {
      event.preventDefault();
      setChecking(true);
      setError('');
      try { await onUnlock(token); } catch (caught) { setError(caught.message); setChecking(false); }
    }}>
      <input type="password" required autoFocus value={token} onChange={(event) => setToken(event.target.value)} placeholder="Access code" aria-label="Threadline access code" />
      <Button type="submit" variant="primary" disabled={checking}>{checking ? 'Checking…' : 'Open workspace'}</Button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

function NewProjectModal({ repositoryInput = 'path', onClose, onCreate }) {
  const [form, setForm] = useState({ name: '', repoPath: '', brief: '' });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  return <Modal title="Start a project" description="One screen: name it, connect the code, say what good looks like — then just chat." onClose={onClose}>
    <form className="modal-form" onSubmit={async (event) => {
      event.preventDefault();
      setCreating(true);
      setError('');
      try { await onCreate(form); } catch (caught) { setError(caught.message); setCreating(false); }
    }}>
      <Field label="Project name" required autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Preflop Lab" />
      <Field
        label={repositoryInput === 'url' ? 'GitHub repository URL' : 'Repository path'}
        hint="Optional now — agents need it before they can work on code."
        value={form.repoPath}
        onChange={(event) => setForm({ ...form, repoPath: event.target.value })}
        placeholder={repositoryInput === 'url' ? 'https://github.com/owner/repository' : '/Users/you/code/product'}
      />
      <Field as="textarea" label="What are you trying to accomplish?" required value={form.brief} onChange={(event) => setForm({ ...form, brief: event.target.value })} placeholder="Build a preflop trainer with reviewable ranges…" />
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={creating || !form.name.trim() || !form.brief.trim()}>{creating ? 'Creating project…' : 'Create project'}</Button></footer>
    </form>
  </Modal>;
}

export function App() {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [adapter, setAdapter] = useState(null);
  const [health, setHealth] = useState(null);
  const [needsAccess, setNeedsAccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('chat');
  const [leafId, setLeafId] = useState(null);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');

  const notify = (message) => {
    setToast(message);
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(''), 3600);
  };

  const selectLeaf = (projectId, nodeId) => {
    setLeafId(nodeId);
    try { window.localStorage.setItem(leafStorageKey(projectId), nodeId || ''); } catch { /* Optional persistence only. */ }
  };

  const adoptProject = (next) => {
    setProject(next);
    if (!next) return;
    let stored = null;
    try { stored = window.localStorage.getItem(leafStorageKey(next.id)); } catch { /* Optional persistence only. */ }
    const valid = stored && next.chatNodes.some((node) => node.id === stored) ? stored : defaultLeaf(next.chatNodes);
    setLeafId(valid);
  };

  const applyProject = (next, message) => {
    setProject(next);
    if (next && leafId && !next.chatNodes.some((node) => node.id === leafId)) setLeafId(defaultLeaf(next.chatNodes));
    if (message) notify(message);
  };

  const refreshProjects = async (selectId) => {
    const result = await api.listProjects();
    setProjects(result.projects);
    const id = selectId || project?.id || result.projects[0]?.id;
    if (id) adoptProject((await api.getProject(id)).project);
    setLoading(false);
  };

  const loadWorkspace = async () => {
    try {
      await refreshProjects();
      const result = await api.listAdapters();
      setAdapter(result.adapters[0] || null);
      setNeedsAccess(false);
    } catch (error) {
      if (error.status === 401) {
        setAccessToken('');
        setNeedsAccess(true);
      } else notify(error.message);
      setLoading(false);
      throw error;
    }
  };

  useEffect(() => {
    api.health().then(async (result) => {
      setHealth(result);
      if (result.mode === 'cloud' && !result.configured) { setLoading(false); return; }
      if (result.authRequired && !getAccessToken()) { setNeedsAccess(true); setLoading(false); return; }
      await loadWorkspace();
    }).catch((error) => { notify(error.message); setLoading(false); });
  }, []);

  useEffect(() => {
    const hasActiveRun = project?.agentRuns?.some((run) => activeRunStatuses.has(run.status) || run.verification?.status === 'running');
    if (!hasActiveRun) return undefined;
    const interval = window.setInterval(async () => {
      try {
        const result = await api.getProject(project.id);
        setProject(result.project);
      } catch { /* A transient poll failure should not interrupt the workspace. */ }
    }, 1200);
    return () => window.clearInterval(interval);
  }, [project?.id, project?.agentRuns?.map((run) => `${run.id}:${run.status}:${run.verification?.status || ''}`).join('|')]);

  const unlockHostedWorkspace = async (token) => {
    setAccessToken(token);
    try { await loadWorkspace(); }
    catch (error) { setAccessToken(''); throw error; }
  };

  const createProject = async (form) => {
    const result = await api.createProject(form);
    setModal(null);
    setTab('chat');
    await refreshProjects(result.project.id);
    notify('Project created — describe your first task in the chat');
  };

  if (loading) return <div className="loading-screen"><div className="brand-mark"><span></span><span></span><span></span></div><p>Loading shared understanding…</p></div>;
  if (health?.mode === 'cloud' && (!health.configured || needsAccess)) return <HostedGate configured={health.configured} onUnlock={unlockHostedWorkspace} />;
  if (!project) return <div className="onboarding"><div className="brand-lockup"><div className="brand-mark"><span></span><span></span><span></span></div><strong>Threadline</strong></div><h1>Keep humans and coding agents<br />on the same page.</h1><p>One chat that deploys real agents, a tree of every direction, one home for the rules, and a ship pipeline to production.</p><Button variant="primary" onClick={() => setModal('project')}>Start a project</Button>{modal === 'project' && <NewProjectModal repositoryInput={health?.repositoryInput} onClose={() => setModal(null)} onCreate={createProject} />}</div>;

  const openAttention = project.attentionItems.filter((item) => item.status === 'open').length;

  return <div className="app-shell chat-shell">
    <header className="topbar">
      <div className="brand-lockup"><div className="brand-mark"><span></span><span></span><span></span></div><strong>Threadline</strong></div>
      <label className="project-select"><span className="sr-only">Project</span>
        <select value={project.id} onChange={async (event) => { setTab('chat'); adoptProject((await api.getProject(event.target.value)).project); }}>
          <option value={project.id}>{project.name}</option>
          {projects.filter((item) => item.id !== project.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <small>{project.repoPath || 'No repository connected'}</small>
      </label>
      <nav className="tab-bar" aria-label="Workspace views">
        {tabs.map((item) => <button key={item.id} className={`tab ${tab === item.id ? 'selected' : ''}`} onClick={() => setTab(item.id)}>
          <Icon name={item.icon} />{item.label}
          {item.id === 'chat' && openAttention > 0 && <span className="nav-badge">{openAttention}</span>}
        </button>)}
      </nav>
      <div className="top-actions">
        <span className="local-state"><i></i>{health?.mode === 'cloud' ? 'Saved to cloud' : 'Saved locally'}</span>
        <Button onClick={() => setModal('project')} icon="plus">New project</Button>
      </div>
    </header>
    <main className="workspace chat-workspace">
      {tab === 'chat' && <ChatView project={project} adapter={adapter} leafId={leafId} verifyCommand={effectiveVerifyCommand(project)}
        onSelectLeaf={(nodeId) => selectLeaf(project.id, nodeId)} applyProject={applyProject} notify={notify} />}
      {tab === 'tree' && <TreeView project={project} leafId={leafId} onOpen={(nodeId) => { selectLeaf(project.id, nodeId); setTab('chat'); }} />}
      {tab === 'rules' && <RulesView project={project} applyProject={applyProject} notify={notify} />}
      {tab === 'ship' && <ShipView project={project} notify={notify} />}
    </main>
    {modal === 'project' && <NewProjectModal repositoryInput={health?.repositoryInput} onClose={() => setModal(null)} onCreate={createProject} />}
    {toast && <div className="toast" role="status"><Icon name="check" />{toast}</div>}
  </div>;
}
