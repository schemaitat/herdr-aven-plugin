import type { Entity, GraphSnapshot, Relationship } from '../../shared/graph.js';

const observedAt = '2026-10-20T12:00:00Z';
export const source = { source: 'aven' as const, observedAt, record: 'fixture task context' };
const node = (id: string, kind: Entity['kind'], label: string, state = 'todo'): Entity => ({ id, kind, label, state,
  details: kind === 'task' || kind === 'epic' ? { avenStatus: state } : { persistedState: state, workflow: 'implementation', generation: 2 }, provenance: [source] });
const edge = (kind: Relationship['kind'], from: string, to: string): Relationship => ({ id: JSON.stringify([kind, from, to]), kind, source: from, target: to, provenance: [source] });
export const graphFixture: GraphSnapshot = {
  schema: 'local-explorer/v1', observedAt, scope: { project: 'graph-fixture', workspace: 'default' },
  nodes: [node('epic:a', 'epic', 'Aurora epic'), node('epic:b', 'epic', 'Borealis epic'),
    node('task:a', 'task', 'Build adapter', 'done'), node('task:b', 'task', 'Build graph', 'active'), node('task:c', 'task', 'Review graph'),
    node('task:solo', 'task', 'Standalone investigation'),
    node('agent:a', 'agent', 'worker / adapter', 'completed'), node('agent:b', 'agent', 'worker / graph', 'running'), node('agent:c', 'agent', 'coordinator', 'unknown'),
    node('session:a', 'session', 'Session A', 'unknown'), node('pane:a', 'pane', 'Pane A', 'observed'), node('worktree:a', 'worktree', 'Checkout A', 'observed'),
    node('pane:unused', 'pane', 'Unassigned pane', 'observed'), node('worktree:unused', 'worktree', 'Unassigned checkout', 'observed')],
  edges: [edge('contains', 'epic:a', 'task:a'), edge('contains', 'epic:a', 'task:b'), edge('contains', 'epic:b', 'task:c'),
    edge('blocks', 'task:a', 'task:b'), edge('blocks', 'task:b', 'task:c'), edge('blocks', 'task:solo', 'task:c'),
    edge('assigned', 'task:a', 'agent:a'), edge('assigned', 'task:b', 'agent:b'), edge('assigned', 'task:c', 'agent:c'),
    edge('session', 'agent:a', 'session:a'), edge('placed-in', 'agent:a', 'pane:a'), edge('worktree', 'agent:a', 'worktree:a')],
  health: [{ source: 'aven', status: 'ok', observedAt, message: 'Deterministic fixture; no live agents' }],
};
