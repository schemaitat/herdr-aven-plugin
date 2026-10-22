import type { EdgeKind, Entity, GraphSnapshot, Relationship } from '../../shared/graph.js';
import { graphFixture } from './graph-snapshot.js';
import { largeGraph } from './large-graph.js';

const observedAt = '2026-10-21T12:00:00Z';
const provenance = [{ source: 'aven' as const, observedAt, record: 'layout readability fixture' }];
const node = (id: string, kind: Entity['kind'], label: string, state = 'todo'): Entity => ({ id, kind, label, state,
  details: kind === 'task' || kind === 'epic' ? { avenStatus: state } : { persistedState: state, workflow: 'implementation', generation: 2 }, provenance });
const edge = (kind: EdgeKind, from: string, to: string): Relationship => ({ id: JSON.stringify([kind, from, to]), kind, source: from, target: to, provenance });
const snapshot = (project: string, nodes: Entity[], edges: Relationship[]): GraphSnapshot => ({ schema: 'local-explorer/v1', observedAt,
  scope: { project, workspace: 'default' }, nodes, edges, health: [{ source: 'aven', status: 'ok', observedAt, message: 'Deterministic layout fixture' }] });

/** One epic's full pipeline: tasks, blocker fan-out, attempts, agents, sessions and resources. */
const singleEpic = snapshot('layout-single-epic', [
  node('epic:alpha', 'epic', 'Alpha epic', 'active'),
  node('task:1', 'task', 'Design schema', 'done'), node('task:2', 'task', 'Build adapter', 'active'),
  node('task:3', 'task', 'Build layout', 'active'), node('task:4', 'task', 'Integrate adapter', 'todo'),
  node('task:5', 'task', 'Verify dashboard', 'todo'), node('task:6', 'task', 'Write guide', 'todo'),
  node('attempt:1', 'attempt', 'Adapter attempt', 'running'), node('attempt:2', 'attempt', 'Layout attempt', 'running'),
  node('agent:1', 'agent', 'worker / adapter', 'running'), node('agent:2', 'agent', 'worker / layout', 'running'),
  node('agent:3', 'agent', 'verifier', 'completed'),
  node('session:1', 'session', 'Adapter session', 'unknown'), node('session:2', 'session', 'Layout session', 'unknown'),
  node('pane:1', 'pane', 'Adapter pane', 'observed'), node('pane:2', 'pane', 'Layout pane', 'observed'),
  node('worktree:1', 'worktree', 'Adapter checkout', 'observed'),
], [
  edge('contains', 'epic:alpha', 'task:1'), edge('contains', 'epic:alpha', 'task:2'), edge('contains', 'epic:alpha', 'task:3'),
  edge('contains', 'epic:alpha', 'task:4'), edge('contains', 'epic:alpha', 'task:5'), edge('contains', 'epic:alpha', 'task:6'),
  edge('blocks', 'task:1', 'task:2'), edge('blocks', 'task:1', 'task:3'), edge('blocks', 'task:2', 'task:4'),
  edge('blocks', 'task:3', 'task:5'), edge('blocks', 'task:4', 'task:6'), edge('blocks', 'task:5', 'task:6'),
  edge('assigned', 'task:2', 'attempt:1'), edge('contains', 'attempt:1', 'agent:1'),
  edge('assigned', 'task:3', 'attempt:2'), edge('contains', 'attempt:2', 'agent:2'),
  edge('assigned', 'task:5', 'agent:3'),
  edge('session', 'agent:1', 'session:1'), edge('session', 'agent:2', 'session:2'), edge('session', 'agent:3', 'session:2'),
  edge('placed-in', 'session:1', 'pane:1'), edge('placed-in', 'session:2', 'pane:2'),
  edge('worktree', 'agent:1', 'worktree:1'),
]);

/** Two epics joined by cross-epic blockers, including a same-rank cycle for deterministic ordering. */
const twoEpics = snapshot('layout-two-epics', [
  node('epic:alpha', 'epic', 'Alpha epic', 'active'), node('epic:beta', 'epic', 'Beta epic', 'active'),
  node('task:a1', 'task', 'Alpha one', 'done'), node('task:a2', 'task', 'Alpha two', 'active'),
  node('task:a3', 'task', 'Alpha three', 'todo'), node('task:b1', 'task', 'Beta one', 'done'),
  node('task:b2', 'task', 'Beta two', 'active'), node('task:b3', 'task', 'Beta three', 'todo'),
  node('agent:a1', 'agent', 'alpha worker', 'running'), node('agent:a2', 'agent', 'alpha verifier', 'unknown'),
  node('agent:b1', 'agent', 'beta worker', 'running'), node('agent:b2', 'agent', 'beta verifier', 'unknown'),
  node('session:s1', 'session', 'Shared session', 'unknown'), node('pane:p1', 'pane', 'Shared pane', 'observed'),
  node('worktree:w1', 'worktree', 'Alpha checkout', 'observed'),
], [
  edge('contains', 'epic:alpha', 'task:a1'), edge('contains', 'epic:alpha', 'task:a2'), edge('contains', 'epic:alpha', 'task:a3'),
  edge('contains', 'epic:beta', 'task:b1'), edge('contains', 'epic:beta', 'task:b2'), edge('contains', 'epic:beta', 'task:b3'),
  edge('blocks', 'task:a1', 'task:a2'), edge('blocks', 'task:a2', 'task:a3'),
  edge('blocks', 'task:b1', 'task:b2'), edge('blocks', 'task:b2', 'task:b3'),
  edge('blocks', 'task:a2', 'task:b1'), edge('blocks', 'task:b2', 'task:a3'),
  edge('blocks', 'task:a2', 'task:a3'), edge('blocks', 'task:a3', 'task:a2'),
  edge('assigned', 'task:a2', 'agent:a1'), edge('assigned', 'task:b2', 'agent:b1'),
  edge('assigned', 'task:a3', 'agent:a2'), edge('assigned', 'task:b3', 'agent:b2'),
  edge('session', 'agent:a1', 'session:s1'), edge('session', 'agent:b1', 'session:s1'),
  edge('placed-in', 'session:s1', 'pane:p1'), edge('worktree', 'agent:a1', 'worktree:w1'),
]);

/** Mixed shapes plus `related` edges, an unassigned resource and a lone component. */
const mixed = snapshot('layout-mixed', [
  node('epic:main', 'epic', 'Main epic'),
  node('task:x', 'task', 'Refactor sources', 'active'), node('task:y', 'task', 'Harden server', 'todo'),
  node('task:z', 'task', 'Document API', 'todo'), node('task:lonely', 'task', 'Standalone spike'),
  node('attempt:shared', 'attempt', 'Shared attempt', 'running'),
  node('agent:x1', 'agent', 'worker / sources', 'running'), node('agent:y1', 'agent', 'worker / server', 'completed'),
  node('session:mixed', 'session', 'Mixed session', 'unknown'), node('pane:unused', 'pane', 'Unassigned pane', 'observed'),
  node('worktree:main', 'worktree', 'Main checkout', 'observed'), node('workspace:local', 'workspace', 'Local workspace', 'observed'),
  node('boundary:repo', 'boundary', 'Repository boundary', 'observed'),
], [
  edge('contains', 'epic:main', 'task:x'), edge('contains', 'epic:main', 'task:y'), edge('contains', 'epic:main', 'task:z'),
  edge('blocks', 'task:x', 'task:y'), edge('blocks', 'task:y', 'task:z'), edge('blocks', 'task:x', 'task:z'),
  edge('assigned', 'task:x', 'attempt:shared'), edge('contains', 'attempt:shared', 'agent:x1'),
  edge('assigned', 'task:y', 'agent:y1'), edge('session', 'agent:x1', 'session:mixed'),
  edge('session', 'agent:y1', 'session:mixed'), edge('placed-in', 'session:mixed', 'pane:unused'),
  edge('worktree', 'agent:x1', 'worktree:main'), edge('related', 'worktree:main', 'workspace:local'),
  edge('related', 'workspace:local', 'boundary:repo'), edge('related', 'task:lonely', 'boundary:repo'),
]);

export interface LayoutFixture { name: string; snapshot: GraphSnapshot }
/** Primary readability targets first; the 500-node snapshot is only a performance guardrail. */
export const layoutFixtures: LayoutFixture[] = [
  { name: 'graph', snapshot: graphFixture },
  { name: 'single-epic', snapshot: singleEpic },
  { name: 'two-epics', snapshot: twoEpics },
  { name: 'mixed', snapshot: mixed },
  { name: 'large', snapshot: largeGraph() },
];
