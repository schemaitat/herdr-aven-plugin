import type { ElementDefinition } from 'cytoscape';
import type { Entity, GraphSnapshot, Relationship } from '../../shared/graph.js';

export interface GraphEdge extends Omit<Relationship, 'kind'> {
  kind: Relationship['kind'] | 'agent-dependency';
  evidence?: string[];
  summary?: boolean;
}

// Never derive from agent names, proximity, attempt containment, or session activity.
export function relationships(snapshot: GraphSnapshot): GraphEdge[] {
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
  const assignments = snapshot.edges.filter(edge => edge.kind === 'assigned' &&
    ['task', 'epic'].includes(byId.get(edge.source)?.kind ?? '') && byId.get(edge.target)?.kind === 'agent');
  const derived: GraphEdge[] = [];
  for (const blocker of snapshot.edges.filter(edge => edge.kind === 'blocks')) {
    for (const from of assignments.filter(edge => edge.source === blocker.source)) {
      for (const to of assignments.filter(edge => edge.source === blocker.target)) {
        if (from.target === to.target) continue;
        const evidence = [blocker.id, from.id, to.id];
        derived.push({ id: JSON.stringify(['derived', ...evidence]), kind: 'agent-dependency', source: from.target, target: to.target,
          evidence, provenance: [...blocker.provenance, ...from.provenance, ...to.provenance] });
      }
    }
  }
  return [...snapshot.edges, ...derived];
}

export function elements(nodes: Entity[], edges: GraphEdge[]): ElementDefinition[] {
  return [...nodes.map(node => ({ data: { id: node.id, kind: node.kind, label: `${node.label}\n${node.kind} · ${node.state}`, state: node.state } })),
    ...edges.map(edge => ({ data: { id: edge.id, source: edge.source, target: edge.target, kind: edge.kind,
      label: `${edge.summary ? 'collapsed · ' : ''}${edge.kind === 'agent-dependency' ? 'derived dependency' : edge.kind}`, summary: Boolean(edge.summary) } }))];
}
