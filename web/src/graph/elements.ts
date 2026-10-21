import type { ElementDefinition } from 'cytoscape';
import type { Entity, GraphSnapshot, Relationship } from '../../shared/graph.js';
import { graphLabel } from './labels.js';
import { isCurrentWorking } from './activity.js';

/** Client presentation kinds include the evidenced dependency derived locally. */
export const RELATION_KINDS = ['contains', 'blocks', 'related', 'assigned', 'session', 'placed-in', 'worktree', 'agent-dependency'] as const;
export type RelationKind = typeof RELATION_KINDS[number];

export interface GraphEdge extends Omit<Relationship, 'kind'> {
  kind: RelationKind;
  evidence?: string[];
  summary?: boolean;
}

// Never derive from agent names, proximity, attempt containment, or session activity.
export function relationships(snapshot: GraphSnapshot): GraphEdge[] {
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
  const assignments = snapshot.edges.filter(edge => edge.kind === 'assigned' &&
    ['task', 'epic'].includes(byId.get(edge.source)?.kind ?? '') && byId.get(edge.target)?.kind === 'agent');
  const derived: GraphEdge[] = [];
  const assignedByTask = new Map<string, typeof assignments>();
  for (const edge of assignments) assignedByTask.set(edge.source, [...(assignedByTask.get(edge.source) ?? []), edge]);
  for (const blocker of snapshot.edges.filter(edge => edge.kind === 'blocks')) {
    for (const from of assignedByTask.get(blocker.source) ?? []) {
      for (const to of assignedByTask.get(blocker.target) ?? []) {
        if (from.target === to.target) continue;
        const evidence = [blocker.id, from.id, to.id];
        derived.push({ id: JSON.stringify(['derived', ...evidence]), kind: 'agent-dependency', source: from.target, target: to.target,
          evidence, provenance: [...blocker.provenance, ...from.provenance, ...to.provenance] });
      }
    }
  }
  return [...snapshot.edges, ...derived];
}

export function waitingCue(node: Entity): string {
  const approval = node.activity?.some(item => item.freshness === 'current' && item.approval === true);
  const input = node.activity?.some(item => item.freshness === 'current' && item.input === true);
  return approval || input ? `Awaiting ${approval ? 'approval' : ''}${approval && input ? ' / ' : ''}${input ? 'input' : ''}` : '';
}

export function elements(nodes: Entity[], edges: GraphEdge[]): ElementDefinition[] {
  return [...nodes.map(node => ({ data: { id: node.id, kind: node.kind, label: graphLabel(node), fullLabel: node.label, state: node.state, working: isCurrentWorking(node) ? 'yes' : 'no' } })),
    ...edges.map(edge => ({ data: { id: edge.id, source: edge.source, target: edge.target, kind: edge.kind,
      label: `${edge.summary ? 'collapsed · ' : ''}${edge.kind === 'agent-dependency' ? 'derived dependency' : edge.kind}`, summary: Boolean(edge.summary) } }))];
}
