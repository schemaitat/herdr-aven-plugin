import type { Entity, Relationship } from './graph.js';

/** Unknown, invalid and future source dates cannot establish recency. */
export function sourceTime(value: string | undefined, now: number): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now ? time : undefined;
}

/** Current dispatcher writer uses milliseconds; seconds-based records remain compatible. */
export function attemptTime(value: number, now: number): string | undefined {
  const time = value >= 1_000_000_000_000 ? value : value * 1000;
  if (!Number.isFinite(time) || value <= 0 || time > now || time > 8_640_000_000_000_000) return;
  return new Date(time).toISOString();
}

/** Directed ownership only. Shared topology is a terminal, never a route to other owners. */
export function ownership(nodes: Entity[], edges: Relationship[], containment = false): Map<string, string[]> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const paths = new Map<string, string[]>();
  for (const edge of edges) {
    const from = byId.get(edge.source)?.kind;
    const to = byId.get(edge.target)?.kind;
    const owns = (containment && edge.kind === 'contains' && from === 'epic' && (to === 'epic' || to === 'task')) ||
      (edge.kind === 'assigned' && (from === 'task' || from === 'epic') && (to === 'attempt' || to === 'agent')) ||
      (edge.kind === 'contains' && from === 'attempt' && to === 'agent') ||
      (edge.kind === 'session' && from === 'agent' && to === 'session') ||
      (edge.kind === 'placed-in' && (from === 'agent' || from === 'session') && (to === 'pane' || (to === 'boundary' && edge.target.startsWith('pane:')))) ||
      (edge.kind === 'worktree' && from === 'agent' && (to === 'worktree' || (to === 'boundary' && edge.target.startsWith('worktree:'))));
    if (owns) paths.set(edge.source, [...(paths.get(edge.source) ?? []), edge.target]);
  }
  return paths;
}

export function reachable(root: string, paths: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...paths.get(id) ?? []);
  }
  return visited;
}

/** Resources inherit max valid time of explicit task/attempt owners, not other resources. */
export function effectiveTimes(nodes: Entity[], edges: Relationship[], now: number): Map<string, number> {
  const times = new Map<string, number>();
  const byId = new Map(nodes.map(node => [node.id, node]));
  const paths = ownership(nodes, edges);
  for (const node of nodes) {
    const time = sourceTime(node.changedAt, now);
    if (time !== undefined) times.set(node.id, time);
  }
  for (const node of nodes) {
    if (!['epic', 'task', 'attempt'].includes(node.kind)) continue;
    const time = sourceTime(node.changedAt, now);
    if (time === undefined) continue;
    for (const id of reachable(node.id, paths)) {
      if (id === node.id || byId.get(id)?.kind === 'attempt') continue;
      times.set(id, Math.max(times.get(id) ?? -Infinity, time));
    }
  }
  return times;
}
