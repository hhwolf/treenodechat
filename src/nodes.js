export function childrenOf(chatNodes = []) {
  const map = new Map();
  for (const node of chatNodes) {
    const key = node.parentId || 'root';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(node);
  }
  for (const list of map.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return map;
}

export function pathTo(chatNodes = [], leafId) {
  const byId = new Map(chatNodes.map((node) => [node.id, node]));
  const path = [];
  let cursor = byId.get(leafId);
  while (cursor && path.length < 1_000) {
    path.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
  }
  return path;
}

export function deepestDescendant(chatNodes = [], nodeId) {
  const children = childrenOf(chatNodes);
  let cursor = nodeId;
  for (let depth = 0; depth < 1_000; depth += 1) {
    const kids = children.get(cursor) || [];
    if (!kids.length) return cursor;
    cursor = kids.at(-1).id;
  }
  return cursor;
}

export function defaultLeaf(chatNodes = []) {
  return chatNodes.length ? chatNodes.at(-1).id : null;
}
