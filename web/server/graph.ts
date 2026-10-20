import { resolve } from 'node:path';
import { entityId, type EdgeKind, type Entity, type GraphSnapshot, type Provenance, type Relationship } from '../shared/graph.js';
import type { Runner } from './commands.js';
import type { startupConfig } from './config.js';
import { avenSource, type AvenRead } from './sources/aven.js';
import { readDispatcher, type DispatchRead } from './sources/dispatcher.js';
import { readHerdr, type HerdrRead } from './sources/herdr.js';

type Config = Awaited<ReturnType<typeof startupConfig>>;
export function normalize(config: Config, aven: AvenRead, dispatch: DispatchRead, herdr: HerdrRead): GraphSnapshot {
  const nodes = new Map<string, Entity>();
  const edges = new Map<string, Relationship>();
  const taskId = (id: string) => entityId('task', config.scope.workspace, id);
  const topologyId = (kind: 'pane' | 'workspace', id: string) => entityId(kind, config.scope.session, id);
  // API sessions are independent of terminal placement and survive Herdr session changes.
  const sessionId = (id: string, service = 'opencode') => entityId('session', service, id);
  const worktreeId = (path: string) => entityId('worktree', resolve(config.scope.cwd, path));
  const provenance = (source: Provenance['source'], record: string): Provenance => ({ source, record, observedAt: ({ aven: aven.health, dispatcher: dispatch.health, herdr: herdr.health })[source].observedAt });
  const node = (entity: Entity) => {
    const previous = nodes.get(entity.id);
    if (!previous || previous.boundary) nodes.set(entity.id, entity);
    else previous.provenance = [...previous.provenance, ...entity.provenance].filter((p, i, all) => all.findIndex(other => other.source === p.source && other.record === p.record) === i);
    return entity.id;
  };
  const stub = (id: string, label: string, p: Provenance) => {
    if (!nodes.has(id)) node({ id, kind: 'boundary', label, state: 'unresolved', boundary: true, details: { coverage: 'Outside scope, unhydrated, or missing resource' }, provenance: [p] });
    return id;
  };
  const edge = (kind: EdgeKind, source: string, target: string, p: Provenance) => {
    const id = JSON.stringify([kind, source, target]);
    const existing = edges.get(id);
    if (existing) {
      if (!existing.provenance.some(value => value.source === p.source && value.record === p.record)) existing.provenance.push(p);
    } else edges.set(id, { id, kind, source, target, provenance: [p] });
  };

  for (const task of aven.tasks) {
    node({ id: taskId(task.id), kind: task.is_epic ? 'epic' : 'task', label: `${task.ref} · ${task.title}`, state: task.deleted ? 'deleted' : task.status,
      details: { ref: task.ref, taskId: task.id, project: task.project, avenStatus: task.status, priority: task.priority, availableAt: task.available_at, dueOn: task.due_on, relationCoverage: aven.contexts.has(task.id) ? 'hydrated' : 'incomplete' },
      provenance: [provenance('aven', task.ref)] });
  }
  for (const task of aven.tasks) {
    const context = aven.contexts.get(task.id);
    const p = { ...provenance('aven', task.ref), observedAt: aven.contextObservedAt?.get(task.id) ?? aven.health.observedAt };
    const relatedTask = (other: { id: string; ref?: string; display_ref?: string }) => stub(taskId(other.id), other.ref ?? other.display_ref ?? other.id, p);
    const parent = context?.epic_parent ?? task.epic_parent;
    if (parent) edge('contains', relatedTask(parent), taskId(task.id), p);
    for (const child of context?.epic_children ?? task.epic_children) edge('contains', taskId(task.id), relatedTask(child), p);
    for (const blocker of context?.dependencies.depends_on ?? []) edge('blocks', relatedTask(blocker), taskId(task.id), p);
    for (const blocked of context?.dependencies.blocks ?? []) edge('blocks', taskId(task.id), relatedTask(blocked), p);
    for (const other of context?.related ?? []) {
      const pair = [taskId(task.id), relatedTask(other)].sort();
      edge('related', pair[0], pair[1], p);
    }
  }

  for (const workspace of herdr.workspaces) {
    const p = provenance('herdr', workspace.workspace_id);
    const id = node({ id: topologyId('workspace', workspace.workspace_id), kind: 'workspace', label: workspace.workspace_id, state: 'observed', details: { workspaceId: workspace.workspace_id }, provenance: [p] });
    if (workspace.worktree) edge('worktree', id, stub(worktreeId(workspace.worktree.checkout_path), workspace.worktree.checkout_path, p), p);
  }
  for (const tree of herdr.worktrees) node({ id: worktreeId(tree.path), kind: 'worktree', label: tree.branch ?? tree.path, state: 'observed', details: { path: tree.path, branch: tree.branch ?? '' }, provenance: [provenance('herdr', tree.path)] });
  for (const pane of herdr.panes) {
    const p = provenance('herdr', pane.pane_id);
    const paneId = node({ id: topologyId('pane', pane.pane_id), kind: 'pane', label: pane.pane_id, state: 'observed', details: { paneId: pane.pane_id, tabId: pane.tab_id, terminalObservedState: pane.agent_status }, provenance: [p] });
    edge('contains', stub(topologyId('workspace', pane.workspace_id), pane.workspace_id, p), paneId, p);
    if (pane.cwd && herdr.worktrees.some(tree => tree.path === pane.cwd)) edge('worktree', paneId, worktreeId(pane.cwd), p);
    if (pane.agent_session?.kind === 'id') {
      const session = node({ id: sessionId(pane.agent_session.value, pane.agent ?? 'unknown'), kind: 'session', label: pane.agent_session.value, state: 'unknown', details: { sessionId: pane.agent_session.value, service: pane.agent ?? 'unknown', apiActivity: 'not connected in this phase', terminalObservedState: pane.agent_status }, provenance: [p] });
      edge('placed-in', session, paneId, p);
    }
  }

  for (const { attempt: a, origin, observedAt } of dispatch.attempts) {
    const p = { ...provenance(origin === 'aven-recovery' ? 'aven' : 'dispatcher', `${origin}/${a.task_id}/${a.workflow}/${a.generation}/${a.attempt_id}`), observedAt: observedAt ?? dispatch.health.observedAt };
    const attemptId = node({ id: entityId('attempt', a.task_id, a.workflow, a.generation, a.attempt_id), kind: 'attempt', label: `${a.workflow} · ${a.attempt_id}`, state: a.state || 'unknown',
      details: { taskId: a.task_id, workflow: a.workflow, generation: a.generation, attemptId: a.attempt_id, executionMode: a.execution_mode, persistedState: a.state, origin }, provenance: [p] });
    edge('assigned', stub(taskId(a.task_id), a.task_ref, p), attemptId, p);
    const role = (key: string, task: string, session: string, pane: string, path: string, state: string, name: string) => {
      if (!session && !pane && !path && !name) return;
      const agent = node({ id: entityId('agent', a.task_id, a.workflow, a.generation, a.attempt_id, key), kind: 'agent', label: `${key}${name ? ` · ${name}` : ''}`, state: state || 'unknown', details: { role: key.split('/')[0], persistedState: state, taskId: task, workflow: a.workflow }, provenance: [p] });
      edge('contains', attemptId, agent, p);
      edge('assigned', stub(taskId(task), task, p), agent, p);
      if (session) {
        const id = node({ id: sessionId(session), kind: 'session', label: session, state: 'unknown', details: { sessionId: session, service: 'opencode', apiActivity: 'not connected in this phase' }, provenance: [p] });
        edge('session', agent, id, p);
        if (pane) edge('placed-in', id, stub(topologyId('pane', pane), pane, p), p);
      }
      if (pane) edge('placed-in', agent, stub(topologyId('pane', pane), pane, p), p);
      if (path) edge('worktree', agent, stub(worktreeId(path), path, p), p);
    };
    // A root session recorded as coordinator is one execution, not an additional fictional worker.
    if (!a.coordinator_session_id || a.session_id !== a.coordinator_session_id) role('worker', a.task_id, a.session_id, a.pane, a.worktree, a.state, a.agent);
    if (a.coordinator_session_id || a.coordinator_agent) role('coordinator', a.task_id, a.coordinator_session_id, a.coordinator_session_id === a.session_id ? a.pane : '', a.worktree, a.state, a.coordinator_agent);
    role('babysitter', a.task_id, a.babysitter_session_id, a.babysitter_pane, '', 'unknown', '');
    for (const phase of a.phases) role(`worker/${phase.task_id}`, phase.task_id, phase.session_id, phase.pane, phase.worktree, phase.state, '');
  }
  return { schema: 'local-explorer/v1', observedAt: new Date().toISOString(), scope: { project: config.scope.project, workspace: config.scope.workspace }, nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)), health: [aven.health, dispatch.health, herdr.health] };
}

export function createSnapshotSource(config: Config, run: Runner) {
  const readAven = avenSource(config.scope, run);
  let cache: GraphSnapshot | undefined;
  let time = 0;
  let pending: Promise<GraphSnapshot> | undefined;
  return async (): Promise<GraphSnapshot> => {
    if (cache && Date.now() - time < 4000) return cache;
    if (pending) return pending;
    pending = (async () => {
      const [aven, herdr] = await Promise.all([readAven(), readHerdr(config.scope, config.primary, run)]);
      const dispatch = await readDispatcher(config.storePath, aven);
      const snapshot = normalize(config, aven, dispatch, herdr);
      // Keep last good Aven entities visible during outages, explicitly stale; never turn absence into completion.
      if (aven.health.status === 'unavailable' && cache) {
        return { ...cache, health: cache.health.map(health => ({ ...health, status: 'stale' as const, message: 'Refresh unavailable; showing last snapshot' })) };
      }
      return snapshot;
    })();
    try { cache = await pending; time = Date.now(); return cache; }
    finally { pending = undefined; }
  };
}
