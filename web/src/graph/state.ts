import type { Entity, GraphSnapshot } from '../../shared/graph.js';
import { relationships, waitingCue, type GraphEdge } from './elements.js';
import { searchEntities } from './search.js';

export interface Filters { query: string; kind: string; state: string }
const order = ['epic', 'task', 'attempt', 'agent', 'session', 'workspace', 'pane', 'worktree', 'boundary'];
export const VISIBLE_NODE_CAP = 500;
export function projectGraph(snapshot: GraphSnapshot, filters: Filters, collapsed: Set<string>) {
  const allEdges = relationships(snapshot);
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
  const parent = new Map<string, string>();
  for (const edge of snapshot.edges) {
    if (edge.kind === 'contains' && collapsed.has(edge.source) && byId.get(edge.source)?.kind === 'epic' && byId.get(edge.target)?.kind === 'task') parent.set(edge.target, edge.source);
  }
  const eligible = snapshot.nodes.filter(node => !parent.has(node.id) &&
    (filters.kind === 'all' || node.kind === filters.kind) && (filters.state === 'all' || node.state === filters.state));
  const nodes = filters.query.trim() ? searchEntities(eligible, filters.query) : eligible.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.label.localeCompare(b.label));
  const visibleNodes = nodes.slice(0, VISIBLE_NODE_CAP);
  const cappedIds = new Set(nodes.slice(VISIBLE_NODE_CAP).map(node => node.id));
  const ids = new Set(visibleNodes.map(node => node.id));
  let hiddenRelationships = 0;
  const edges: GraphEdge[] = [];
  for (const edge of allEdges) {
    const source = parent.get(edge.source) ?? edge.source;
    const target = parent.get(edge.target) ?? edge.target;
    if (source !== edge.source || target !== edge.target) hiddenRelationships++;
    if (!ids.has(source) || !ids.has(target) || source === target) continue;
    edges.push(source === edge.source && target === edge.target ? edge : {
      ...edge, id: JSON.stringify(['collapsed', edge.id, source, target]), source, target, summary: true, evidence: [edge.id, ...(edge.evidence ?? [])],
    });
  }
  return { nodes: visibleNodes, discoveryNodes: nodes, edges, allEdges, cappedNodes: nodes.length - visibleNodes.length, omittedRelationships: allEdges.filter(edge => cappedIds.has(edge.source) || cappedIds.has(edge.target)).length, hiddenRelationships, hiddenTasks: parent.size };
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
