import { Icon } from './ui.jsx';
import { childrenOf, deepestDescendant } from './nodes.js';

const glyphs = { user: 'You', assistant: 'TL', notice: '·' };

function excerpt(node) {
  const text = node.content.replace(/\s+/g, ' ').trim();
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

function TreeNode({ project, node, children, runsById, activeLeafPath, onOpen, depth }) {
  const kids = children.get(node.id) || [];
  const runs = [...new Set((node.actions || []).filter((action) => action.runId).map((action) => action.runId))]
    .map((runId) => runsById.get(runId)).filter(Boolean);
  const onPath = activeLeafPath.has(node.id);
  return <li>
    <button className={`tree-node ${node.role} ${onPath ? 'on-path' : ''}`} onClick={() => onOpen(deepestDescendant(project.chatNodes, node.id))}>
      <span className={`tree-glyph ${node.role}`}>{glyphs[node.role] || '·'}</span>
      <span className="tree-copy">
        <strong>{excerpt(node)}</strong>
        <span className="tree-meta">
          {runs.map((run) => <em key={run.id} className={`run-status ${run.status}`}><i></i>{run.status}{run.verification?.status ? ` · tests ${run.verification.status}` : ''}</em>)}
          {node.directions?.map((direction) => {
            const explored = kids.some((child) => child.directionId === direction.id);
            return <em key={direction.id} className={`direction-chip ${explored ? 'explored' : ''}`}>{direction.label}{explored ? ' ✓' : ''}</em>;
          })}
        </span>
      </span>
    </button>
    {kids.length > 0 && <ul>{kids.map((child) => <TreeNode key={child.id} project={project} node={child} children={children} runsById={runsById} activeLeafPath={activeLeafPath} onOpen={onOpen} depth={depth + 1} />)}</ul>}
  </li>;
}

export function TreeView({ project, leafId, onOpen }) {
  const nodes = project.chatNodes || [];
  const children = childrenOf(nodes);
  const roots = children.get('root') || [];
  const runsById = new Map(project.agentRuns.map((run) => [run.id, run]));
  const activeLeafPath = new Set();
  {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let cursor = byId.get(leafId);
    while (cursor) { activeLeafPath.add(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : null; }
  }
  return <div className="tree-view">
    <header className="view-heading"><div><span className="eyebrow">Conversation tree</span><h1>Every direction, in one map</h1><p>Each fork is a branch. Click any node to reopen that path in Chat; unexplored directions stay available.</p></div></header>
    {!roots.length ? <div className="chat-empty"><span className="agent-mark"><Icon name="tree" size={22} /></span><h2>No conversation yet</h2><p>Start in the Chat tab — every message and direction will appear here as a tree.</p></div>
      : <ul className="tree-root">{roots.map((node) => <TreeNode key={node.id} project={project} node={node} children={children} runsById={runsById} activeLeafPath={activeLeafPath} onOpen={onOpen} depth={0} />)}</ul>}
  </div>;
}
