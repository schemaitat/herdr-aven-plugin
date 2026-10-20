import type { Entity } from '../../shared/graph.js';

// Bound work per field/query; snapshots are already bounded at the source.
export function searchScore(entity: Entity, query: string): number | undefined {
  const needle = query.trim().toLowerCase().slice(0, 256);
  if (!needle) return 0;
  let best: number | undefined;
  for (const field of [entity.label, String(entity.details.ref ?? ''), entity.id]) {
    const text = field.toLowerCase().slice(0, 4096);
    let score: number;
    if (text === needle) score = 0;
    else if (text.startsWith(needle)) score = 1;
    else {
      let cursor = 0;
      for (const character of needle) {
        const index = text.indexOf(character, cursor);
        if (index < 0) { cursor = -1; break; }
        cursor = index + 1;
      }
      if (cursor < 0) continue;
      score = 2 + cursor / 4097;
    }
    best = Math.min(best ?? Infinity, score);
  }
  return best;
}

export function searchEntities(nodes: Entity[], query: string): Entity[] {
  return nodes.map(node => ({ node, score: searchScore(node, query) }))
    .filter((entry): entry is { node: Entity; score: number } => entry.score !== undefined)
    .sort((a, b) => a.score - b.score || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0))
    .map(entry => entry.node);
}

export function slashShortcut(event: KeyboardEvent): boolean {
  return event.key === '/' && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
    !(event.target instanceof Element && event.target.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])'));
}
