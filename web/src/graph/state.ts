import type { Entity, GraphSnapshot, NodeKind } from '../../shared/graph.js';
import { effectiveTimes, ownership, reachable } from '../../shared/scope.js';
import { relationships, waitingCue, type GraphEdge } from './elements.js';
import { searchEntities } from './search.js';

export const ALL_TYPES: NodeKind[] = ['epic', 'task', 'attempt', 'agent', 'session', 'workspace', 'pane', 'worktree', 'boundary'];
export const DEFAULT_TYPES: NodeKind[] = ['epic', 'task', 'attempt', 'agent', 'session'];
export const TIME_WINDOWS = { '24h': 24, '72h': 72, '7d': 168, '14d': 336, '30d': 720 } as const;
export type TimePreset = 'all' | keyof typeof TIME_WINDOWS;
export interface Filters { query: string; kinds: Set<NodeKind>; state: string; time: TimePreset; epic?: string }
export function defaultFilters(): Filters { return { query: '', kinds: new Set(DEFAULT_TYPES), state: 'all', time: 'all' }; }
export const VISIBLE_NODE_CAP = 500;
export function projectGraph(snapshot: GraphSnapshot, filters: Filters, collapsed: Set<string>, now: number) {
  const allEdges = relationships(snapshot);
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
  const eligible = searched.filter(node => {
    if (cutoff === undefined) return true;
    const time = times.get(node.id);
    if (time === undefined) { unknownTimeExclusions++; return false; }
    return time >= cutoff;
  });
  const eligibleIds = new Set(eligible.map(node => node.id));
  const eligibleEdges = allEdges.filter(edge => eligibleIds.has(edge.source) && eligibleIds.has(edge.target));
  const parent = new Map<string, string>();
  for (const edge of snapshot.edges) {
    if (edge.kind === 'contains' && collapsed.has(edge.source) && eligibleIds.has(edge.source) && eligibleIds.has(edge.target) && byId.get(edge.source)?.kind === 'epic' && byId.get(edge.target)?.kind === 'task') parent.set(edge.target, edge.source);
  }
  const nodes = eligible.filter(node => !parent.has(node.id));
  const visibleNodes = nodes.slice(0, VISIBLE_NODE_CAP);
  const cappedIds = new Set(nodes.slice(VISIBLE_NODE_CAP).map(node => node.id));
  const ids = new Set(visibleNodes.map(node => node.id));
  let hiddenRelationships = 0;
  const edges: GraphEdge[] = [];
  const omittedRelationships = allEdges.filter(edge => cappedIds.has(parent.get(edge.source) ?? edge.source) || cappedIds.has(parent.get(edge.target) ?? edge.target)).length;
  for (const edge of eligibleEdges) {
    const source = parent.get(edge.source) ?? edge.source;
    const target = parent.get(edge.target) ?? edge.target;
    if (source !== edge.source || target !== edge.target) hiddenRelationships++;
    if (!ids.has(source) || !ids.has(target) || source === target) continue;
    edges.push(source === edge.source && target === edge.target ? edge : {
      ...edge, id: JSON.stringify(['collapsed', edge.id, source, target]), source, target, summary: true, evidence: [edge.id, ...(edge.evidence ?? [])],
    });
  }
  return { nodes: visibleNodes, discoveryNodes: nodes, eligibleGraph: { nodes: eligible, edges: eligibleEdges }, edges, allEdges, cappedNodes: nodes.length - visibleNodes.length, omittedRelationships, hiddenRelationships, hiddenTasks: parent.size, unknownTimeExclusions };
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
