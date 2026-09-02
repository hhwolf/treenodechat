import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Button, Field, Icon } from './ui.jsx';
import { timeAgo } from './ui.jsx';

function syncState(doc) {
  if (!doc.committedAt) return { label: 'Never committed', tone: 'pending' };
  if (doc.committedAt < doc.updatedAt) return { label: 'Modified since commit', tone: 'stale' };
  return { label: `Committed ${timeAgo(doc.committedAt)}`, tone: 'synced' };
}

function IntentEditor({ project, applyProject, notify }) {
  const [intent, setIntent] = useState(project.intent);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => setIntent(project.intent), [project.id]);
  const update = (field, value) => setIntent((current) => ({ ...current, [field]: value }));
  return <section className="rules-card" data-tour="intent">
    <header><div><span className="eyebrow">Project intent</span><h2>What good looks like</h2><p>The durable contract every chat turn and agent run inherits.</p></div>
      <div>
        <Button icon="spark" disabled={drafting} onClick={async () => { setDrafting(true); try { const result = await api.draftSpec(project.id, intent.objective); setIntent(result.intent); notify(result.source === 'model' ? 'Spec refined with your configured model' : 'Spec refined locally'); } catch (error) { notify(error.message); } finally { setDrafting(false); } }}>{drafting ? 'Drafting…' : 'Refine spec'}</Button>
        <Button variant="primary" onClick={async () => { try { applyProject((await api.updateIntent(project.id, intent)).project, 'Intent saved'); } catch (error) { notify(error.message); } }}>Save intent</Button>
      </div>
    </header>
    <div className="intent-grid">
      <Field as="textarea" label="Objective" value={intent.objective} onChange={(event) => update('objective', event.target.value)} />
      <Field as="textarea" label="Who this is for" value={intent.audience} onChange={(event) => update('audience', event.target.value)} />
      <Field as="textarea" label="Desired outcome" value={intent.outcome} onChange={(event) => update('outcome', event.target.value)} />
      <Field as="textarea" label="What to avoid" value={intent.avoid} onChange={(event) => update('avoid', event.target.value)} />
      <Field as="textarea" label="Output format" value={intent.format} onChange={(event) => update('format', event.target.value)} />
      <Field as="textarea" label="What good looks like" value={intent.qualityBar} onChange={(event) => update('qualityBar', event.target.value)} />
    </div>
  </section>;
}

export function RulesView({ project, applyProject, notify }) {
  const documents = project.documents || [];
  const [selectedId, setSelectedId] = useState(documents[0]?.id || null);
  const selected = documents.find((doc) => doc.id === selectedId) || documents[0] || null;
  const [draft, setDraft] = useState(selected?.content || '');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [repoLocation, setRepoLocation] = useState(project.repoPath || '');
  useEffect(() => { setDraft(selected?.content || ''); }, [selected?.id, project.id]);

  const dirty = selected && draft !== selected.content;
  const act = async (fn, toast) => {
    setBusy(true);
    try { const result = await fn(); applyProject(result.project, toast); return result; }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };

  return <div className="rules-view">
    <header className="view-heading"><div><span className="eyebrow">Rules</span><h1>One home for every rule</h1><p>Intent, CLAUDE.md, skills, and guidelines live here. They are injected into every chat turn and agent run, and can be committed to the repository.</p></div></header>

    <section className="rules-card">
      <header><div><span className="eyebrow">Repository</span><h2>{project.repository?.scannedAt ? `${project.repository.name} · ${project.repository.branch}` : 'No repository connected'}</h2><p>{project.repository?.scannedAt ? `${project.repository.fileCount} tracked files · scanned ${timeAgo(project.repository.scannedAt)}` : 'Connect the repository agents should work on.'}</p></div>
        <div>
          {project.repoPath && <Button disabled={busy} onClick={() => act(() => api.scanRepository(project.id), 'Repository snapshot refreshed')}>Rescan</Button>}
        </div>
      </header>
      <form className="repo-row" onSubmit={(event) => { event.preventDefault(); if (repoLocation.trim()) act(() => api.connectRepository(project.id, repoLocation.trim()), 'Repository connected and scanned'); }}>
        <input value={repoLocation} aria-label="Repository location" placeholder="https://github.com/owner/repository" onChange={(event) => setRepoLocation(event.target.value)} />
        <Button type="submit" disabled={busy || !repoLocation.trim()}>{project.repoPath ? 'Change repository' : 'Connect repository'}</Button>
      </form>
    </section>

    <IntentEditor project={project} applyProject={applyProject} notify={notify} />

    <section className="rules-card documents-card">
      <header><div><span className="eyebrow">Rule documents</span><h2>CLAUDE.md, skills, and guidelines</h2><p>Markdown documents injected into every agent prompt. Commit to sync them onto the project’s threadline branch on GitHub.</p></div></header>
      <div className="documents-layout">
        <aside>
          {documents.map((doc) => {
            const sync = syncState(doc);
            return <button key={doc.id} className={`document-row ${selected?.id === doc.id ? 'selected' : ''}`} onClick={() => setSelectedId(doc.id)}>
              <strong>{doc.name}</strong>
              <em className={`sync-pill ${sync.tone}`}>{sync.label}</em>
            </button>;
          })}
          <form className="new-document" onSubmit={(event) => { event.preventDefault(); if (newName.trim()) act(() => api.createDocument(project.id, { name: newName.trim(), content: '' }), `${newName.trim()} added`).then(() => setNewName('')); }}>
            <input value={newName} placeholder="skills/research.md" aria-label="New document name" onChange={(event) => setNewName(event.target.value)} />
            <Button type="submit" icon="plus" disabled={busy || !newName.trim()}>Add</Button>
          </form>
        </aside>
        {selected ? <div className="document-editor">
          <textarea value={draft} aria-label={`Content of ${selected.name}`} onChange={(event) => setDraft(event.target.value)} spellCheck="false" />
          <footer>
            <small>{dirty ? 'Unsaved changes' : syncState(selected).label}</small>
            <div>
              <Button disabled={busy} onClick={() => { if (window.confirm(`Delete ${selected.name}?`)) act(() => api.deleteDocument(project.id, selected.id), `${selected.name} deleted`); }}>Delete</Button>
              <Button disabled={busy || !dirty} onClick={() => act(() => api.updateDocument(project.id, selected.id, { content: draft }), `${selected.name} saved`)}>Save</Button>
              <Button variant="primary" icon="check" disabled={busy || dirty} title={dirty ? 'Save first' : ''} onClick={() => act(() => api.commitDocument(project.id, selected.id), `${selected.name} committed to the repository`)}>Commit to repo</Button>
            </div>
          </footer>
        </div> : <p className="quiet-empty">Add a document to define rules for agents.</p>}
      </div>
    </section>

    <section className="rules-card">
      <header><div><span className="eyebrow">Verification</span><h2>Verify command</h2><p>Run against agent changes when you click Verify on a run.</p></div></header>
      <form className="repo-row" onSubmit={async (event) => {
        event.preventDefault();
        const value = new FormData(event.target).get('verifyCommand');
        act(() => api.updateProjectSettings(project.id, { verifyCommand: String(value) }), 'Verify command saved');
      }}>
        <input name="verifyCommand" defaultValue={project.verifyCommand || ''} placeholder="npm test" aria-label="Verify command" />
        <Button type="submit" disabled={busy}>Save command</Button>
      </form>
    </section>

    <p className="safety-note boundary-note"><Icon name="shield" /><span>Agents can read shared repository context and take reversible actions. Private, external, and irreversible actions remain gated behind your approval.</span></p>
  </div>;
}
