import type { Entity, GraphSnapshot, NodeKind } from '../../shared/graph.js';
import { effectiveTimes, ownership, reachable } from '../../shared/scope.js';
import { relationships, waitingCue, type GraphEdge, type RelationKind } from './elements.js';
import { searchEntities } from './search.js';

export const ALL_TYPES: NodeKind[] = ['epic', 'task', 'attempt', 'agent', 'session', 'workspace', 'pane', 'worktree', 'boundary'];
export const DEFAULT_TYPES: NodeKind[] = ['epic', 'task', 'attempt', 'agent', 'session'];
export const DEFAULT_RELATION_KINDS: RelationKind[] = ['contains', 'blocks'];
export const TIME_WINDOWS = { '24h': 24, '72h': 72, '7d': 168, '14d': 336, '30d': 720 } as const;
export type TimePreset = 'all' | keyof typeof TIME_WINDOWS;
export interface Filters { query: string; kinds: Set<NodeKind>; relationKinds: Set<RelationKind>; state: string; time: TimePreset; epic?: string }
export function defaultFilters(): Filters { return { query: '', kinds: new Set(DEFAULT_TYPES), relationKinds: new Set(DEFAULT_RELATION_KINDS), state: 'all', time: 'all' }; }
/** Clone mutable filter sets whenever scope is retained outside an immediate UI event. */
export function copyFilters(filters: Filters): Filters { return { ...filters, kinds: new Set(filters.kinds), relationKinds: new Set(filters.relationKinds) }; }
export function withRelationKind(filters: Filters, kind: RelationKind, selected: boolean): Filters {
  const relationKinds = new Set(filters.relationKinds);
  if (selected) relationKinds.add(kind); else relationKinds.delete(kind);
  return { ...filters, relationKinds };
}
export function withRelationKinds(filters: Filters, relationKinds: Iterable<RelationKind>): Filters { return { ...filters, relationKinds: new Set(relationKinds) }; }
export const VISIBLE_NODE_CAP = 500;
export function componentMembers(ids: Set<string>, edges: GraphEdge[], anchor?: string): Set<string> | undefined {
  if (!anchor || !ids.has(anchor)) return undefined;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    for (const [a, b] of [[edge.source, edge.target], [edge.target, edge.source]]) {
      const neighbors = adjacency.get(a) ?? []; neighbors.push(b); adjacency.set(a, neighbors);
    }
  }
  const result = new Set([anchor]);
  for (const id of result) for (const other of adjacency.get(id) ?? []) result.add(other);
  return result;
}

/** Cached callers use this together with component membership; relationships are undirected only for distance. */
export function hopDistances(ids: Set<string>, edges: GraphEdge[], anchor?: string): Map<string, number> {
  const distances = new Map<string, number>();
  if (!anchor || !ids.has(anchor)) return distances;
  const adjacent = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) continue;
    adjacent.set(edge.source, [...(adjacent.get(edge.source) ?? []), edge.target]);
    adjacent.set(edge.target, [...(adjacent.get(edge.target) ?? []), edge.source]);
  }
  distances.set(anchor, 0);
  for (const id of distances.keys()) for (const next of adjacent.get(id) ?? []) if (!distances.has(next)) distances.set(next, distances.get(id)! + 1);
  return distances;
}

export function componentResolver() {
  let key: string | undefined, members: Set<string> | undefined;
  return (ids: Set<string>, edges: GraphEdge[], anchor?: string) => {
    const next = JSON.stringify([anchor, [...ids].sort(), edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => [edge.source, edge.target]).sort()]);
    if (key !== next) { key = next; members = componentMembers(ids, edges, anchor); }
    return members;
  };
}

export function projectGraph(snapshot: GraphSnapshot, filters: Filters, collapsed: Set<string>, now: number, anchor?: string, resolveComponent = componentMembers) {
  const allEdges = relationships(snapshot);
  // Scope topology before resolving components or distances. allEdges remains the
  // complete canonical/evidenced relationship set for details and inspection.
  const scopedEdges = allEdges.filter(edge => filters.relationKinds.has(edge.kind));
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
  const membership = filters.epic ? (byId.get(filters.epic)?.kind === 'epic' ? reachable(filters.epic, ownership(snapshot.nodes, snapshot.edges, true)) : new Set<string>()) : undefined;
  const times = effectiveTimes(snapshot.nodes, snapshot.edges, now);
  const cutoff = filters.time === 'all' ? undefined : now - TIME_WINDOWS[filters.time] * 3600000;
  let unknownTimeExclusions = 0;
  const candidates = snapshot.nodes.filter(node => {
    if (membership && !membership.has(node.id) || !filters.kinds.has(node.kind) || filters.state !== 'all' && node.state !== filters.state) return false;
    return true;
  });
  const searched = filters.query.trim() ? searchEntities(candidates, filters.query) : [...candidates].sort((a, b) => ALL_TYPES.indexOf(a.kind) - ALL_TYPES.indexOf(b.kind) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const filtered = searched.filter(node => {
    if (cutoff === undefined) return true;
    const time = times.get(node.id);
    if (time === undefined) { unknownTimeExclusions++; return false; }
    return time >= cutoff;
  });
  const filteredIds = new Set(filtered.map(node => node.id));
  const component = resolveComponent(filteredIds, scopedEdges, anchor);
  const eligible = component ? filtered.filter(node => component.has(node.id)) : filtered;
  const eligibleIds = new Set(eligible.map(node => node.id));
  const eligibleEdges = scopedEdges.filter(edge => eligibleIds.has(edge.source) && eligibleIds.has(edge.target));
  const parent = new Map<string, string>();
  for (const edge of snapshot.edges) {
    if (edge.kind === 'contains' && collapsed.has(edge.source) && eligibleIds.has(edge.source) && eligibleIds.has(edge.target) && byId.get(edge.source)?.kind === 'epic' && byId.get(edge.target)?.kind === 'task') parent.set(edge.target, edge.source);
  }
  const nodes = eligible.filter(node => !parent.has(node.id));
  // A selected eligible anchor remains inspectable on the canvas even when sort/cap
  // order would otherwise hide it. The cap itself never changes.
  const orderedNodes = anchor && nodes.some(node => node.id === anchor) && !nodes.slice(0, VISIBLE_NODE_CAP).some(node => node.id === anchor)
    ? [nodes.find(node => node.id === anchor)!, ...nodes.filter(node => node.id !== anchor)] : nodes;
  const visibleNodes = orderedNodes.slice(0, VISIBLE_NODE_CAP);
  const cappedIds = new Set(nodes.slice(VISIBLE_NODE_CAP).map(node => node.id));
  const ids = new Set(visibleNodes.map(node => node.id));
  let hiddenRelationships = 0;
  const edges: GraphEdge[] = [];
  const omittedRelationships = eligibleEdges.filter(edge => cappedIds.has(parent.get(edge.source) ?? edge.source) || cappedIds.has(parent.get(edge.target) ?? edge.target)).length;
  for (const edge of eligibleEdges) {
    const source = parent.get(edge.source) ?? edge.source;
    const target = parent.get(edge.target) ?? edge.target;
    if (source !== edge.source || target !== edge.target) hiddenRelationships++;
    if (!ids.has(source) || !ids.has(target) || source === target) continue;
    edges.push(source === edge.source && target === edge.target ? edge : {
      ...edge, id: JSON.stringify(['collapsed', edge.id, source, target]), source, target, summary: true, evidence: [edge.id, ...(edge.evidence ?? [])],
    });
  }
  return { nodes: visibleNodes, discoveryNodes: nodes, eligibleGraph: { nodes: eligible, edges: eligibleEdges }, distances: hopDistances(eligibleIds, eligibleEdges, anchor), componentAvailable: !anchor || filteredIds.has(anchor), edges, allEdges, cappedNodes: nodes.length - visibleNodes.length, omittedRelationships, hiddenRelationships, hiddenTasks: parent.size, unknownTimeExclusions };
}

export function toggleEpic(previous: Set<string>, id: string): Set<string> {
  const next = new Set(previous);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

export function canonicalSelection(edges: GraphEdge[], id: string) {
  const edge = edges.find(edge => edge.id === id);
  return edge?.summary ? edge.evidence?.[0] ?? id : id;
}

export function stateDescription(entity: Entity) {
  return `${entity.kind === 'task' || entity.kind === 'epic' ? 'Task status' : entity.kind === 'agent' || entity.kind === 'attempt' ? 'Persisted execution state' : 'Source state'}: ${entity.state}${entity.activity?.some(item => item.state === 'working' && item.freshness === 'current') ? ' · Working (linked execution, not acceptance)' : ''}${waitingCue(entity) ? ` · ${waitingCue(entity)}` : ''}`;
}
