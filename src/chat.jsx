import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Button, Field, Icon, Modal } from './ui.jsx';
import { childrenOf, deepestDescendant, pathTo } from './nodes.js';

const MESSAGE_LIMIT = 8_000;
const activeRunStatuses = new Set(['queued', 'running', 'paused']);

const shipActionCopy = {
  create_pull_request: (args) => `Open a pull request: “${args.title || 'Untitled'}”`,
  merge_pull_request: (args) => `Merge pull request #${args.number}`,
  trigger_deployment: (args) => `Deploy ${args.ref || 'main'} to production on Vercel`,
  rollback_deployment: (args) => `Roll production back to deployment ${args.deploymentId}`,
  set_env_var: (args) => `Add environment variable ${args.key}`
};

function DiffModal({ project, run, onClose }) {
  const [diff, setDiff] = useState(null);
  useEffect(() => {
    api.agentRunDiff(project.id, run.id).then(setDiff).catch((error) => setDiff({ error: error.message }));
  }, [project.id, run.id]);
  return <Modal className="diff-modal" title={`Diff · ${run.task.slice(0, 60)}`} description={`${run.files?.length || 0} changed files from the isolated run.`} onClose={onClose}>
    {!diff ? <p className="quiet-empty">Loading diff…</p>
      : diff.error ? <p className="form-error" role="alert">{diff.error}</p>
      : <><pre className="diff-stat">{diff.diffStat || 'No summary available.'}</pre><pre className="diff-preview">{diff.diff || 'No diff content.'}</pre></>}
  </Modal>;
}

function IntegrationModal({ project, run, onClose, onDone }) {
  const files = run.files || [];
  const [selected, setSelected] = useState(files);
  const [commitMessage, setCommitMessage] = useState(`Threadline: accept ${run.task.slice(0, 60)}`);
  const [integrating, setIntegrating] = useState(false);
  const [error, setError] = useState('');
  const toggle = (file) => setSelected((current) => current.includes(file) ? current.filter((item) => item !== file) : [...current, file]);
  return <Modal title="Integrate agent code" description="Commit selected files to Threadline’s project branch. Your default branch is never changed." onClose={onClose}>
    <form className="modal-form" onSubmit={async (event) => {
      event.preventDefault();
      setIntegrating(true);
      setError('');
      try {
        const result = await api.integrateAgentRun(project.id, run.id, { filePaths: selected, commitMessage });
        onDone(result);
      } catch (caught) { setError(caught.message); setIntegrating(false); }
    }}>
      <div className="change-list">
        {files.map((file) => <label className="change-item" key={file}><input type="checkbox" checked={selected.includes(file)} onChange={() => toggle(file)} /><span><strong>{file}</strong></span></label>)}
      </div>
      <Field label="Commit message" value={commitMessage} required onChange={(event) => setCommitMessage(event.target.value)} />
      <p className="safety-note"><Icon name="shield" /><span>Applied with Git’s three-way merge onto the threadline branch; conflicts change nothing.</span></p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><span>{selected.length} of {files.length} selected</span><div><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={integrating || !selected.length || !commitMessage.trim()}>{integrating ? 'Integrating…' : 'Integrate selected files'}</Button></div></footer>
    </form>
  </Modal>;
}

function RunCard({ project, run, verifyCommand, onControl, onVerify, onInspect, onIntegrate }) {
  if (!run) return null;
  const active = activeRunStatuses.has(run.status);
  const verification = run.verification;
  return <div className="run-card">
    <header>
      <span className={`run-status ${run.status}`}><i></i>{run.status}</span>
      <strong>{run.task.length > 110 ? `${run.task.slice(0, 110)}…` : run.task}</strong>
    </header>
    {run.summary && <p className="run-card-summary">{run.summary}</p>}
    {(run.events || []).length > 0 && active && <p className="run-card-event">{run.events.at(-1).message.slice(0, 240)}</p>}
    <footer>
      <small>{run.files?.length || 0} files changed</small>
      {verification?.status && <span className={`verify-badge ${verification.status}`}>
        {verification.status === 'running' ? 'Verifying…'
          : verification.status === 'passed' ? `Tests passed${verification.durationMs ? ` · ${Math.round(verification.durationMs / 1000)}s` : ''}`
          : verification.status === 'failed' ? `Verification failed · exit ${verification.exitCode}` : 'Verification error'}
      </span>}
      {run.integration?.commit && <span className="verify-badge passed">Integrated · {run.integration.commit.slice(0, 8)}</span>}
      <div className="run-card-actions">
        {run.status === 'running' && <Button icon="pause" onClick={() => onControl(run, 'pause')}>Pause</Button>}
        {run.status === 'paused' && <Button icon="play" onClick={() => onControl(run, 'resume')}>Resume</Button>}
        {active && <Button icon="stop" onClick={() => onControl(run, 'cancel')}>Cancel run</Button>}
        {!active && run.diffStat && <Button onClick={() => onInspect(run)}>Inspect diff</Button>}
        {run.status === 'completed' && verifyCommand && verification?.status !== 'running' && <Button icon="play" onClick={() => onVerify(run)}>{verification?.status ? 'Verify again' : 'Verify'}</Button>}
        {run.status === 'completed' && run.files?.length > 0 && !run.integration?.commit && <Button variant="primary" icon="check" onClick={() => onIntegrate(run)}>Integrate selected files</Button>}
      </div>
    </footer>
  </div>;
}

function ApprovalCard({ project, node, action, onResolved, notify }) {
  const [busy, setBusy] = useState(false);
  const [envValue, setEnvValue] = useState('');
  const describe = shipActionCopy[action.tool] || (() => action.tool);
  const approve = async () => {
    setBusy(true);
    try {
      if (action.tool === 'create_pull_request') await api.createPullRequest(project.id, { title: action.args.title, body: action.args.body });
      if (action.tool === 'merge_pull_request') await api.mergePullRequest(project.id, action.args.number);
      if (action.tool === 'trigger_deployment') await api.triggerDeployment(project.id, { ref: action.args.ref });
      if (action.tool === 'rollback_deployment') await api.rollbackDeployment(project.id, action.args.deploymentId);
      if (action.tool === 'set_env_var') {
        if (!envValue) throw new Error('Enter the value to store (it is sent encrypted, never to the model).');
        await api.createEnv(project.id, { key: action.args.key, value: envValue, target: action.args.target });
      }
      const result = await api.resolveChatAction(project.id, node.id, action.id, 'approved');
      onResolved(result.project, `${describe(action.args)} — approved and executed`);
    } catch (error) {
      notify(error.message);
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    try {
      const result = await api.resolveChatAction(project.id, node.id, action.id, 'dismissed');
      onResolved(result.project, 'Proposal dismissed');
    } catch (error) { notify(error.message); setBusy(false); }
  };
  return <div className="approval-card">
    <div><Icon name="shield" /><div>
      <strong>{describe(action.args || {})}</strong>
      <small>Proposed by the model — this external action requires your approval.</small>
      {action.tool === 'set_env_var' && <input type="password" value={envValue} placeholder="Value (stored encrypted)" aria-label="Environment variable value" onChange={(event) => setEnvValue(event.target.value)} />}
    </div></div>
    <div className="approval-actions">
      <Button onClick={dismiss} disabled={busy}>Dismiss</Button>
      <Button variant="primary" icon="check" onClick={approve} disabled={busy}>{busy ? 'Working…' : 'Approve & run'}</Button>
    </div>
  </div>;
}

export function ChatView({ project, adapter, leafId, onSelectLeaf, applyProject, notify, verifyCommand }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [target, setTarget] = useState(null);
  const [diffRun, setDiffRun] = useState(null);
  const [integrateRun, setIntegrateRun] = useState(null);
  const composerRef = useRef(null);
  const endRef = useRef(null);

  const nodes = project.chatNodes || [];
  const children = childrenOf(nodes);
  const path = leafId ? pathTo(nodes, leafId) : [];
  const leaf = path.at(-1) || null;
  const runsById = new Map(project.agentRuns.map((run) => [run.id, run]));

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [leafId, nodes.length, sending]);

  const send = async (overrides = {}) => {
    const content = String(overrides.message ?? message).trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const parentNodeId = overrides.parentNodeId !== undefined ? overrides.parentNodeId : (target?.parentId ?? leaf?.id ?? null);
      const result = await api.chat(project.id, {
        message: content.slice(0, MESSAGE_LIMIT),
        parentNodeId,
        ...(overrides.directionId || target?.directionId ? { directionId: overrides.directionId || target.directionId } : {}),
        ...(overrides.kind ? { kind: overrides.kind } : {})
      });
      applyProject(result.project);
      onSelectLeaf(result.assistantNode.id);
      setMessage('');
      setTarget(null);
    } catch (error) {
      notify(error.message);
    } finally {
      setSending(false);
    }
  };

  const continueWithRun = (run) => send({
    message: `Run finished with status "${run.status}". Summary: ${run.summary || 'none'}. Files: ${(run.files || []).slice(0, 20).join(', ') || 'none'}${run.verification ? `. Verification ${run.verification.status}.` : ''} Decide the next step.`,
    parentNodeId: leaf?.id ?? null,
    kind: 'run-update'
  });

  const pickDirection = (node, direction) => {
    const explored = (children.get(node.id) || []).find((child) => child.directionId === direction.id);
    if (explored) {
      onSelectLeaf(deepestDescendant(nodes, explored.id));
      return;
    }
    setTarget({ parentId: node.id, directionId: direction.id, label: direction.label });
    composerRef.current?.focus();
  };

  const linkedRuns = (node) => (node.actions || []).filter((action) => action.runId).map((action) => runsById.get(action.runId)).filter(Boolean);
  const uniqueRuns = (node) => [...new Map(linkedRuns(node).map((run) => [run.id, run])).values()];
  const leafRunActive = leaf ? uniqueRuns(leaf).some((run) => activeRunStatuses.has(run.status)) : false;
  const leafRunDone = leaf && leaf.role === 'assistant' && !children.get(leaf.id)?.length
    ? uniqueRuns(leaf).find((run) => run.status === 'completed' || run.status === 'failed')
    : null;

  return <div className="chat-view">
    <div className="chat-scroll">
      {!nodes.length && <div className="chat-empty">
        <span className="agent-mark"><Icon name="terminal" size={22} /></span>
        <h2>Talk to your project</h2>
        <p>Describe what you want. Threadline answers, deploys coding agents in isolated sandboxes when work is needed, and proposes directions when a real decision is open. Everything lands in the tree.</p>
      </div>}
      {path.map((node) => <article key={node.id} className={`chat-node ${node.role}`}>
        <div className="chat-bubble">
          {node.role === 'notice' ? <small className="notice-label">Update</small> : null}
          <p>{node.content}</p>
          <button className="fork-button" title="Fork from here" onClick={() => { setTarget({ parentId: node.id, directionId: null, label: null }); composerRef.current?.focus(); }}><Icon name="branch" size={12} />Fork from here</button>
        </div>
        {uniqueRuns(node).map((run) => <RunCard key={run.id} project={project} run={run} verifyCommand={verifyCommand}
          onControl={async (target, action) => { try { const result = await api.controlAgentRun(project.id, target.id, action); applyProject(result.project, action === 'cancel' ? 'Cancellation requested' : `Agent ${action}d`); } catch (error) { notify(error.message); } }}
          onVerify={async (target) => { try { const result = await api.verifyAgentRun(project.id, target.id); applyProject(result.project, 'Verification started'); } catch (error) { notify(error.message); } }}
          onInspect={setDiffRun}
          onIntegrate={setIntegrateRun}
        />)}
        {(node.actions || []).filter((action) => action.status === 'needs_approval').map((action) => <ApprovalCard key={action.id} project={project} node={node} action={action} notify={notify} onResolved={(updated, toast) => { applyProject(updated, toast); send({ message: toast, parentNodeId: leaf?.id ?? null, kind: 'run-update' }); }} />)}
        {node.directions?.length > 0 && <div className="direction-cards">
          {node.directions.map((direction) => {
            const explored = (children.get(node.id) || []).some((child) => child.directionId === direction.id);
            return <button key={direction.id} className={`direction-card ${explored ? 'explored' : ''}`} onClick={() => pickDirection(node, direction)}>
              <strong>{direction.label}{direction.recommended && <em className="recommended-chip">Recommended</em>}</strong>
              <span>{direction.summary}</span>
              <small>{explored ? 'Explored — open this branch' : 'Continue in this direction'}</small>
            </button>;
          })}
        </div>}
      </article>)}
      {sending && <article className="chat-node assistant"><div className="chat-bubble thinking"><p>Thinking…</p></div></article>}
      {leafRunDone && !sending && <div className="continue-row"><Button icon="play" onClick={() => continueWithRun(leafRunDone)}>Continue with the run result</Button></div>}
      {leafRunActive && !sending && <p className="quiet-empty">An agent run is in progress — live updates stream into its card above.</p>}
      <div ref={endRef} />
    </div>
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
      {target && <div className="composer-chip"><Icon name="branch" size={12} />{target.label ? `Continuing in “${target.label}”` : 'Forking from an earlier message'}<button type="button" aria-label="Clear target" onClick={() => setTarget(null)}><Icon name="close" size={12} /></button></div>}
      <div className="composer-row">
        <textarea
          ref={composerRef}
          rows={2}
          value={message}
          aria-label="Message"
          placeholder={project.repoPath ? 'Describe what you want to do — the model deploys agents when work is needed.' : 'Connect a repository in Rules to let agents work on code, or just start planning here.'}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); send(); } }}
        />
        <Button type="submit" variant="primary" icon="send" disabled={sending || !message.trim() || message.length > MESSAGE_LIMIT}>{sending ? 'Sending…' : 'Send'}</Button>
      </div>
      <small className="composer-note">{adapter?.available
        ? `Agents run isolated (${adapter.name}) and stay review-only until you accept changes.`
        : adapter?.error || 'Coding agents are unavailable; chat still works.'}{message.length > MESSAGE_LIMIT * 0.8 ? ` · ${message.length}/${MESSAGE_LIMIT}` : ''}</small>
    </form>
    {diffRun && <DiffModal project={project} run={runsById.get(diffRun.id) || diffRun} onClose={() => setDiffRun(null)} />}
    {integrateRun && <IntegrationModal project={project} run={runsById.get(integrateRun.id) || integrateRun} onClose={() => setIntegrateRun(null)}
      onDone={(result) => { setIntegrateRun(null); applyProject(result.project, `Integrated into ${result.integration.branchName}`); }} />}
  </div>;
}
