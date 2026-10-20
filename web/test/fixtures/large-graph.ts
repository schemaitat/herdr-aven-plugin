import type { GraphSnapshot, Entity, Relationship } from '../../shared/graph.js';

// Fixed topology/labels/order: 20 hubs, 480 tasks, 480 containment + 520 blockers.
export function largeGraph(count = 500): GraphSnapshot {
  const observedAt = '2026-10-20T12:00:00Z';
  const provenance = [{ source: 'aven' as const, observedAt, record: 'deterministic performance fixture' }];
  const id = (index: number) => `${index < 20 ? 'epic' : 'task'}:${String(index).padStart(3, '0')}`;
  const nodes: Entity[] = Array.from({ length: count }, (_, index) => ({ id: id(index), kind: index < 20 ? 'epic' : 'task', label: `${index < 20 ? 'Orbit' : 'Task'} ${String(index).padStart(3, '0')}`, state: index % 3 === 0 ? 'active' : 'todo', details: { avenStatus: index % 3 === 0 ? 'active' : 'todo' }, provenance }));
  const ids = new Set(nodes.map(node => node.id));
  const edges = Array.from({ length: 1000 }, (_, index): Relationship => ({ id: `edge:${index}`, kind: index < 480 ? 'contains' : 'blocks', source: index < 480 ? id(Math.floor(index / 24)) : id(20 + (index - 480) % 480), target: index < 480 ? id(20 + index) : id(20 + (index - 480 + 1 + Math.floor((index - 480) / 480)) % 480), provenance })).filter(edge => ids.has(edge.source) && ids.has(edge.target));
  for (let index = 500; index < count; index++) edges.push({ id: `overflow:${index}`, kind: 'related', source: id(index), target: id(20 + (index - 500) % 480), provenance });
  return { schema: 'local-explorer/v1', observedAt, scope: { project: 'performance-fixture', workspace: 'default' }, nodes, edges, health: [{ source: 'aven', status: 'ok', observedAt, message: 'Deterministic 500-node / 1,000-edge baseline' }] };
}
