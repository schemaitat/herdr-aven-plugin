import { resolve } from 'node:path';
import { entityId, type EdgeKind, type Entity, type GraphSnapshot, type Provenance, type Relationship } from '../shared/graph.js';
import type { ProjectConfig } from './config.js';
import { createInspectSource, type AvenRead, type AppRead, type CoreRead, type DispatchRead, type InspectExecutor, type WorktreeRead } from './sources/inspect.js';
import { attemptTime, effectiveTimes, sourceTime } from '../shared/scope.js';

type Config = ProjectConfig;
type Sources = { core: CoreRead; worktrees: WorktreeRead; app: AppRead; dispatcher: DispatchRead };

export function normalize(config: Config, aven: AvenRead, sources: Sources, now = Date.now()): GraphSnapshot {
  const { core, worktrees, app, dispatcher: dispatch } = sources;
  const nodes = new Map<string, Entity>();
  const edges = new Map<string, Relationship>();
  const taskId = (id: string) => entityId('task', config.scope.workspace, id);
  const terminalId = (address: string, coreId = '') => entityId('terminal', coreId || 'local', address);
  const paneId = (id: string) => entityId('pane', config.scope.session, id);
  const workspaceId = (id: string) => entityId('workspace', config.scope.session, id);
  // API sessions are independent of terminal placement and survive core restarts.
  const sessionId = (id: string, service = 'opencode') => entityId('session', service, id);
  const worktreeId = (path: string) => entityId('worktree', resolve(config.primary, path));
  const provenance = (source: 'aven' | 'dispatcher' | 'core' | 'worktrees' | 'app', record: string): Provenance => ({
    source,
    record,
    observedAt: ({ aven: aven.health, dispatcher: dispatch.health, core: core.health, worktrees: worktrees.health, app: app.health })[source].observedAt,
  });
  const node = (entity: Entity) => {
    const previous = nodes.get(entity.id);
    if (!previous || previous.boundary) nodes.set(entity.id, entity);
    else previous.provenance = [...previous.provenance, ...entity.provenance].filter((p, i, all) => all.findIndex(other => other.source === p.source && other.record === p.record) === i);
    return entity.id;
  };
  const stub = (id: string, label: string, p: Provenance, state = 'unresolved') => {
    if (!nodes.has(id)) node({ id, kind: 'boundary', label, state, boundary: true, details: { coverage: 'Outside scope, unhydrated, or missing resource' }, provenance: [p] });
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
    const time = sourceTime(task.updated_at, now) ?? sourceTime(task.created_at, now);
    node({ id: taskId(task.id), kind: task.is_epic ? 'epic' : 'task', label: `${task.ref} · ${task.title}`, state: task.deleted ? 'deleted' : task.status,
      ...(time === undefined ? {} : { changedAt: new Date(time).toISOString() }),
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

  // Git worktree inventory is proven by hc-executed Git, never by a path guess.
  for (const tree of worktrees.worktrees) {
    const p = provenance('worktrees', tree.path);
    node({ id: worktreeId(tree.path), kind: 'worktree', label: tree.branch.replace(/^refs\/heads\//, '') || tree.path, state: tree.detached ? 'detached' : 'observed',
      details: { path: tree.path, branch: tree.branch, head: tree.head, primary: tree.path === worktrees.primary }, provenance: [p] });
  }

  const projectTaskIds = new Set([...aven.contexts.keys(), ...aven.tasks.map(task => task.id)]);
  const owned = new Set<string>();
  for (const { attempt } of dispatch.attempts) {
    for (const ref of [attempt.terminal, attempt.coordinator_terminal, attempt.babysitter_terminal, ...attempt.phases.map(phase => phase.terminal)]) {
      if (ref.address) owned.add(ref.address);
    }
  }

  // Terminal entities come from core facts. Labels authorize correlation with
  // this project; a bare address never does. Hidden terminals remain observable.
  const coreTerminals = new Map<string, typeof core.terminals[number]>();
  for (const terminal of core.terminals) {
    const task = terminal.labels['aven.task_id'];
    if (!owned.has(terminal.address) && !(task && projectTaskIds.has(task))) continue;
    coreTerminals.set(terminal.address, terminal);
    const p = provenance('core', terminal.address);
    node({ id: terminalId(terminal.address, core.core.id), kind: 'terminal', label: `${terminal.address}${terminal.name ? ` · ${terminal.name}` : ''}`,
      state: terminal.status || terminal.state,
      details: {
        address: terminal.address, coreId: core.core.id, coreName: core.core.name, coreVersion: core.core.version,
        terminalState: terminal.state, terminalStatus: terminal.status || 'unknown', statusKind: terminal.status_kind,
        program: terminal.program, reported: terminal.reported, recoveredShell: terminal.recovered_shell,
        reason: terminal.reason, turn: terminal.turn, observation: 'core fact; not API activity or acceptance',
        ...(terminal.labels['aven.task'] ? { taskRef: terminal.labels['aven.task'] } : {}),
        ...(terminal.labels['aven.role'] ? { role: terminal.labels['aven.role'] } : {}),
        ...(terminal.labels['aven.workflow'] ? { workflow: terminal.labels['aven.workflow'] } : {}),
      }, provenance: [p] });
  }

  // Optional app placement. Absence never removes a terminal or implies control.
  const visibleSpaces = new Set<string>();
  for (const placement of app.placements) {
    if (!coreTerminals.has(placement.terminal)) continue;
    const p = provenance('app', placement.space);
    visibleSpaces.add(placement.space);
    const pane = paneId(placement.pane || `${placement.tab}:${placement.terminal}`);
    node({ id: pane, kind: 'pane', label: placement.tabName || placement.pane, state: 'observed', details: { paneId: placement.pane, tabId: placement.tab, tabName: placement.tabName }, provenance: [p] });
    const workspace = node({ id: workspaceId(placement.space), kind: 'workspace', label: placement.spaceName || placement.space, state: 'observed', details: { spaceId: placement.space, folder: app.spaces.find(space => space.id === placement.space)?.folder ?? '' }, provenance: [p] });
    edge('contains', workspace, pane, p);
    edge('placed-in', terminalId(placement.terminal, core.core.id), pane, p);
  }
  for (const space of app.spaces) {
    if (!visibleSpaces.has(space.id)) continue;
    const workspace = workspaceId(space.id);
    if (space.folder) {
      const tree = worktrees.worktrees.find(candidate => candidate.path === space.folder);
      if (tree) edge('worktree', workspace, worktreeId(tree.path), provenance('app', space.id));
    }
  }

  for (const { attempt: a, origin, observedAt } of dispatch.attempts) {
    const p = { ...provenance(origin === 'aven-recovery' ? 'aven' : 'dispatcher', `${origin}/${a.task_id}/${a.workflow}/${a.generation}/${a.attempt_id}`), observedAt: observedAt ?? dispatch.health.observedAt };
    const attemptId = node({ id: entityId('attempt', a.task_id, a.workflow, a.generation, a.attempt_id), kind: 'attempt', label: `${a.workflow} · ${a.attempt_id}`, state: a.state || 'unknown',
      changedAt: attemptTime(a.created_at, now),
      details: { taskId: a.task_id, workflow: a.workflow, generation: a.generation, attemptId: a.attempt_id, executionMode: a.execution_mode, persistedState: a.state, origin, logRef: a.log_task_ref, backend: a.backend || 'legacy-herdr', coreId: a.core_id, acceptance: 'Aven task status is separate from this execution state' }, provenance: [p] });
    edge('assigned', stub(taskId(a.task_id), a.task_ref, p), attemptId, p);
    const role = (key: string, task: string, session: string, ref: { address: string; core_id: string } | undefined, legacyPane: string, path: string, state: string, name: string) => {
      if (!session && !ref?.address && !legacyPane && !path && !name) return;
      const observationKey = key.startsWith('worker/') ? `phase:${key.slice('worker/'.length)}` : key.split('/')[0];
      const observation = a.terminals[observationKey] ?? a.terminals[key];
      const agent = node({ id: entityId('agent', a.task_id, a.workflow, a.generation, a.attempt_id, key), kind: 'agent', label: `${key}${name ? ` · ${name}` : ''}`, state: state || 'unknown',
        details: { role: key.split('/')[0], persistedState: state, taskId: task, workflow: a.workflow, generation: a.generation, attemptId: a.attempt_id,
          terminalAddress: ref?.address ?? '', terminalState: observation?.state ?? 'unknown', terminalStatus: observation?.status || 'unknown', recovery: observation?.recovery ?? '',
          observation: observation ? 'core observation; never acceptance' : 'no terminal observation' }, provenance: [p] });
      edge('contains', attemptId, agent, p);
      edge('assigned', stub(taskId(task), task, p), agent, p);
      if (session) {
        const id = node({ id: sessionId(session), kind: 'session', label: session, state: 'unknown', details: { sessionId: session, service: 'opencode', apiActivity: 'unknown (awaiting API observation)' }, provenance: [p] });
        edge('session', agent, id, p);
        if (ref?.address) edge('placed-in', id, stub(terminalId(ref.address, ref.core_id || a.core_id), ref.address, p), p);
      }
      if (ref?.address) {
        edge('placed-in', agent, stub(terminalId(ref.address, ref.core_id || a.core_id), ref.address, p), p);
      }
      if (legacyPane) {
        // Legacy panes are historical evidence only; they are never treated as
        // a core terminal address or as permission to control anything.
        const id = node({ id: paneId(legacyPane), kind: 'pane', label: `legacy ${legacyPane}`, state: 'legacy', details: { paneId: legacyPane, legacy: true, note: 'Retired herdr runtime; read-only evidence' }, provenance: [p] });
        edge('placed-in', agent, id, p);
      }
      if (path) edge('worktree', agent, stub(worktreeId(path), path, p), p);
    };
    // A root session recorded as coordinator is one execution, not an additional fictional worker.
    if (!a.coordinator_session_id || a.session_id !== a.coordinator_session_id) role('worker', a.task_id, a.session_id, a.terminal, a.pane, a.worktree, a.state, a.agent);
    if (a.coordinator_session_id || a.coordinator_agent) role('coordinator', a.task_id, a.coordinator_session_id, a.coordinator_terminal, a.coordinator_session_id === a.session_id ? a.pane : '', a.worktree, a.state, a.coordinator_agent);
    role('babysitter', a.task_id, a.babysitter_session_id, a.babysitter_terminal, a.babysitter_pane, '', 'unknown', '');
    for (const phase of a.phases) role(`worker/${phase.task_id}`, phase.task_id, phase.session_id, phase.terminal, phase.pane, phase.worktree, phase.state, '');
  }
  const times = effectiveTimes([...nodes.values()], [...edges.values()], now);
  for (const entity of nodes.values()) {
    const time = times.get(entity.id);
    if (time !== undefined) entity.changedAt = new Date(time).toISOString();
  }
  return {
    schema: 'local-explorer/v1', observedAt: new Date(now).toISOString(),
    scope: { project: config.scope.project, workspace: config.scope.workspace },
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    health: [aven.health, dispatch.health, core.health, worktrees.health, app.health],
  };
}

// One structural snapshot source. Both collector lanes share its cache so the
// inspector is never run twice for the same cycle.
export function createSnapshotSource(config: Config, execute?: InspectExecutor) {
  const read = createInspectSource(config, execute);
  let cache: GraphSnapshot | undefined;
  let time = 0;
  let pending: Promise<GraphSnapshot> | undefined;
  return async (): Promise<GraphSnapshot> => {
    if (cache && Date.now() - time < 4000) return cache;
    if (pending) return pending;
    pending = (async () => {
      const sources = await read();
      const snapshot = normalize(config, sources.aven, sources);
      // Keep last good Aven entities visible during outages, explicitly stale; never turn absence into completion.
      if (sources.aven.health.status === 'unavailable' && cache) {
        return { ...cache, health: cache.health.map(health => ({ ...health, status: 'stale' as const, message: 'Refresh unavailable; showing last snapshot' })) };
      }
      return snapshot;
    })();
    try { cache = await pending; time = Date.now(); return cache; }
    finally { pending = undefined; }
  };
}

// The inspector is the structural source for every lane; live OpenCode activity
// is applied by the collector after each structural refresh.
export function createGraphReader(config: Config, execute?: InspectExecutor) {
  const read = createInspectSource(config, execute);
  let aven: AvenRead | undefined;
  let dispatcher: DispatchRead | undefined;
  let core: CoreRead | undefined;
  let worktrees: WorktreeRead | undefined;
  let app: AppRead | undefined;
  return async (_lane: 'fast' | 'slow') => {
    const next = await read();
    aven = next.aven.health.status === 'unavailable' && aven?.tasks.length ? { ...aven, health: { ...aven.health, status: 'stale', message: next.aven.health.message } } : next.aven;
    dispatcher = next.dispatcher.health.status === 'unavailable' && dispatcher?.attempts.length ? { ...dispatcher, health: { ...dispatcher.health, status: 'stale', message: next.dispatcher.health.message } } : next.dispatcher;
    core = next.core.health.status === 'unavailable' && core?.terminals.length ? { ...core, health: { ...core.health, status: 'stale', message: next.core.health.message } } : next.core;
    worktrees = next.worktrees.health.status === 'unavailable' && worktrees?.worktrees.length ? { ...worktrees, health: { ...worktrees.health, status: 'stale', message: next.worktrees.health.message } } : next.worktrees;
    app = next.app;
    return normalize(config, aven, { core, worktrees, app, dispatcher });
  };
}
