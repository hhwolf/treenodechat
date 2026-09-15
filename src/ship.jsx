import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Button, Icon, confirmTyped, timeAgo } from './ui.jsx';

export function ShipView({ project, notify, status, onRefresh }) {
  const [envs, setEnvs] = useState(null);
  const [settings, setSettings] = useState(project.shipSettings || { vercelProjectId: '', vercelTeamId: '' });
  const [pr, setPr] = useState({ title: '', body: '' });
  const [deployRef, setDeployRef] = useState('');
  const [envDraft, setEnvDraft] = useState({ key: '', value: '', production: true, preview: false, development: false });
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    await onRefresh(project.id);
    if (project.shipSettings?.vercelProjectId) api.listEnv(project.id).then((result) => setEnvs(result.envs)).catch(() => setEnvs(null));
  };
  useEffect(() => { setEnvs(null); refresh(); }, [project.id]);
  useEffect(() => { if (status?.branch && !deployRef) setDeployRef(status.branch); }, [status?.branch]);
  useEffect(() => { setSettings(project.shipSettings || { vercelProjectId: '', vercelTeamId: '' }); }, [project.id, project.shipSettings?.vercelProjectId]);

  const act = async (fn, toast) => {
    setBusy(true);
    try { await fn(); if (toast) notify(toast); await refresh(); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };

  if (!status) return <div className="ship-view"><p className="quiet-empty">Loading ship status… {!project.repoPath && 'Connect a repository in Rules first.'}</p></div>;

  return <div className="ship-view">
    <header className="view-heading"><div><span className="eyebrow">Ship</span><h1>From accepted code to production</h1><p>Push the threadline branch through a pull request, deploy on Vercel, and manage environment variables. Every action here requires your explicit confirmation.</p></div><Button onClick={refresh}>Refresh</Button></header>

    <section className="rules-card">
      <header><div><span className="eyebrow">Vercel link</span><h2>Ship settings</h2><p>Auto-detected from the connected repository when VERCEL_TOKEN is set — override here only if detection picks the wrong project.</p></div></header>
      <form className="ship-settings" onSubmit={(event) => { event.preventDefault(); act(() => api.updateShipSettings(project.id, settings), 'Ship settings saved'); }}>
        <input value={settings.vercelProjectId} placeholder="Vercel project id (prj_…)" aria-label="Vercel project id" onChange={(event) => setSettings({ ...settings, vercelProjectId: event.target.value })} />
        <input value={settings.vercelTeamId} placeholder="Team id (team_…, optional)" aria-label="Vercel team id" onChange={(event) => setSettings({ ...settings, vercelTeamId: event.target.value })} />
        <Button type="submit" disabled={busy}>Save</Button>
      </form>
      {!status.configured.vercel && <p className="quiet-empty">Vercel shipping needs VERCEL_TOKEN on the server plus a project id above. GitHub shipping works independently.</p>}
    </section>

    <section className="rules-card">
      <header><div><span className="eyebrow">GitHub</span><h2>{status.branch}</h2><p>{status.compare ? `${status.compare.aheadBy} commit${status.compare.aheadBy === 1 ? '' : 's'} ahead of ${status.defaultBranch}${status.compare.behindBy ? `, ${status.compare.behindBy} behind` : ''}.` : status.errors?.github || 'Accepted agent code lands on this branch.'}</p></div>
        {status.configured.github && <Button variant="primary" icon="ship" disabled={busy} onClick={() => {
          if (window.confirm(`Ship it? This merges ${status.branch} into ${status.defaultBranch || 'main'} and deploys production in one step.`)) {
            act(() => api.shipRelease(project.id, {}), 'Shipped — merged and deploying');
          }
        }}>Ship to production</Button>}
      </header>
      {status.pulls.length > 0 && <div className="ship-list">
        {status.pulls.map((pull) => <div className="ship-row" key={pull.number}>
          <div><strong>#{pull.number} {pull.title}</strong><small><a href={pull.url} target="_blank" rel="noreferrer">Open on GitHub</a></small></div>
          <Button variant="primary" disabled={busy} onClick={() => { if (window.confirm(`Squash-merge pull request #${pull.number} into ${status.defaultBranch}?`)) act(() => api.mergePullRequest(project.id, pull.number), `Pull request #${pull.number} merged`); }}>Merge</Button>
        </div>)}
      </div>}
      {status.configured.github && !status.pulls.length && <form className="ship-settings" onSubmit={(event) => {
        event.preventDefault();
        if (!pr.title.trim()) return;
        act(() => api.createPullRequest(project.id, pr), 'Pull request opened').then(() => setPr({ title: '', body: '' }));
      }}>
        <input value={pr.title} placeholder="Pull request title" aria-label="Pull request title" onChange={(event) => setPr({ ...pr, title: event.target.value })} />
        <input value={pr.body} placeholder="Description (optional)" aria-label="Pull request description" onChange={(event) => setPr({ ...pr, body: event.target.value })} />
        <Button type="submit" icon="branch" disabled={busy || !pr.title.trim()}>Create pull request</Button>
      </form>}
      {!status.configured.github && <p className="quiet-empty">Connect a GitHub repository and configure GITHUB_TOKEN to ship.</p>}
    </section>

    <section className="rules-card test-link-card">
      <header><div><span className="eyebrow">Test it yourself</span><h2>Test your product</h2><p>{status.testLink
        ? `A ${status.testLink.kind === 'integration-preview' ? `preview of the accepted agent work (${status.testLink.ref})` : 'production deployment'} is live.`
        : status.configured.vercel
          ? 'No live deployment yet — deploy a test preview of the accepted agent work.'
          : 'Add VERCEL_TOKEN and a project id in Ship settings to get a test link.'}</p></div>
        {status.testLink
          ? <a className="button primary" href={status.testLink.url} target="_blank" rel="noreferrer">Open test link</a>
          : status.configured.vercel && <Button variant="primary" icon="play" disabled={busy} onClick={() => {
              if (window.confirm(`Deploy a preview of ${status.branch} so you can test it?`)) {
                act(() => api.triggerDeployment(project.id, { ref: status.branch, target: 'preview' }), 'Test preview building — refresh in a minute')
                  .then(() => window.setTimeout(refresh, 10_000));
              }
            }}>Deploy a test preview</Button>}
      </header>
    </section>

    {status.configured.vercel && <section className="rules-card">
      <header><div><span className="eyebrow">Vercel</span><h2>Deployments</h2><p>{status.errors?.vercel || 'Trigger production deployments and roll back when needed.'}</p></div></header>
      <form className="ship-settings" onSubmit={(event) => { event.preventDefault(); if (window.confirm(`Deploy ${deployRef} to production?`)) act(() => api.triggerDeployment(project.id, { ref: deployRef }), 'Deployment started'); }}>
        <input value={deployRef} aria-label="Git ref to deploy" onChange={(event) => setDeployRef(event.target.value)} />
        <Button type="submit" variant="primary" icon="ship" disabled={busy || !deployRef.trim()}>Deploy to production</Button>
      </form>
      <div className="ship-list">
        {status.deployments.map((deployment, index) => <div className="ship-row" key={deployment.id}>
          <div>
            <strong><span className={`deploy-state ${String(deployment.state || '').toLowerCase()}`}>{deployment.state}</span> {deployment.ref || deployment.target}</strong>
            <small>{deployment.url ? <a href={deployment.url} target="_blank" rel="noreferrer">{deployment.url}</a> : deployment.id} · {timeAgo(deployment.createdAt)}</small>
          </div>
          {index > 0 && deployment.state === 'READY' && deployment.target === 'production' && <Button disabled={busy} onClick={() => { if (confirmTyped('rollback', `Roll production back to ${deployment.url || deployment.id}.`)) act(() => api.rollbackDeployment(project.id, deployment.id), 'Rollback requested'); }}>Roll back to this</Button>}
        </div>)}
        {!status.deployments.length && <p className="quiet-empty">No deployments yet.</p>}
      </div>
    </section>}

    {status.configured.vercel && <section className="rules-card">
      <header><div><span className="eyebrow">Vercel</span><h2>Environment variables</h2><p>Values are stored encrypted and never displayed.</p></div></header>
      <div className="ship-list">
        {(envs || []).map((env) => <div className="ship-row" key={env.id}>
          <div><strong>{env.key}</strong><small>{(env.target || []).join(', ')}</small></div>
          <Button disabled={busy} onClick={() => { if (window.confirm(`Delete ${env.key}?`)) act(() => api.deleteEnv(project.id, env.id), `${env.key} deleted`); }}>Delete</Button>
        </div>)}
        {envs && !envs.length && <p className="quiet-empty">No environment variables.</p>}
      </div>
      <form className="ship-settings env-form" onSubmit={(event) => {
        event.preventDefault();
        const target = ['production', 'preview', 'development'].filter((item) => envDraft[item]);
        act(() => api.createEnv(project.id, { key: envDraft.key, value: envDraft.value, target }), `${envDraft.key} added`).then(() => setEnvDraft({ key: '', value: '', production: true, preview: false, development: false }));
      }}>
        <input value={envDraft.key} placeholder="KEY" aria-label="Environment variable key" onChange={(event) => setEnvDraft({ ...envDraft, key: event.target.value })} />
        <input type="password" value={envDraft.value} placeholder="Value" aria-label="Environment variable value" onChange={(event) => setEnvDraft({ ...envDraft, value: event.target.value })} />
        {['production', 'preview', 'development'].map((item) => <label key={item} className="env-target"><input type="checkbox" checked={envDraft[item]} onChange={(event) => setEnvDraft({ ...envDraft, [item]: event.target.checked })} />{item}</label>)}
        <Button type="submit" icon="plus" disabled={busy || !envDraft.key.trim() || !envDraft.value}>Add</Button>
      </form>
    </section>}

    <p className="safety-note boundary-note"><Icon name="shield" /><span>Merging, deploying, rolling back, and changing environment variables are external actions — each one requires your approval here and is never executed by the model on its own.</span></p>
  </div>;
}
