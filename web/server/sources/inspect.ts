import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { SourceHealth, SourceName } from '../../shared/graph.js';
import type { ProjectConfig } from '../config.js';

// The Rust inspector is the single structural snapshot implementation. This
// module validates that contract and maps it to the dashboard's graph inputs;
// it must never grow an Aven/hc/herdr-app parser of its own.
export const INSPECT_SCHEMA = 'aven-dispatch-inspect/v1';
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 12_000;

const text = z.string().max(16384);
const healthSchema = z.object({
  source: z.enum(['aven', 'dispatcher', 'core', 'worktrees', 'app', 'opencode']),
  status: z.enum(['ok', 'incomplete', 'unavailable', 'stale']),
  observed_at_ms: z.number().nonnegative(),
  message: text,
});
const refSchema = z.object({ kind: z.string().max(64), id: z.string().max(128), ref: text.optional(), label: text.optional() });
const boundarySchema = z.object({ kind: z.string().max(64), id: z.string().max(128), ref: text.optional(), title: text.optional(), status: text.optional(), hydrated: z.boolean() });
const terminalLinkSchema = z.object({ core_id: text.default(''), address: text.default(''), name: text.default(''), role: text.default(''), created_by_attempt: z.boolean().default(false) });
const planSchema = z.object({ plan_root: text.optional(), plan_phase: text.optional(), plan_kind: text.optional(), plan_worked_out: z.boolean().default(false), reset_generation: z.number().nonnegative().default(0), reset_state: text.optional() });
const deliverySchema = z.object({ state: text.optional(), commit: text.optional(), branch: text.optional(), repository: text.optional(), target: text.optional(), merged: text.optional(), pr: text.optional(), obligation: text.optional(), provenance: text.optional() });
const taskSchema = z.object({
  id: z.string().max(128), ref: z.string().max(256), title: text, project: text, status: text, is_epic: z.boolean(),
  deleted: z.boolean().default(false), priority: text.default('none'), available_at: text.default(''), due_on: text.default(''),
  created_at: text.default(''), updated_at: text.default(''), epic_parent: refSchema.nullish(), epic_children: z.array(refSchema).max(1000).default([]),
  dependencies: z.array(boundarySchema).max(1000).default([]), blocks: z.array(boundarySchema).max(1000).default([]), related: z.array(boundarySchema).max(1000).default([]),
  plan: planSchema.default({ plan_worked_out: false, reset_generation: 0 }), delivery: deliverySchema.optional(), hydrated: z.boolean(), context_observed_at_ms: z.number().nonnegative().optional(),
});
const observationSchema = z.object({ core_id: text.default(''), address: text.default(''), state: text.default(''), status: text.default(''), status_kind: text.default(''), program: text.default(''), reason: text.default(''), turn: z.number().nonnegative().default(0), seq: z.number().nonnegative().default(0), updated_at: z.number().nonnegative().default(0), recovery: text.default('') });
const phaseSchema = z.object({ task_id: z.string().max(128), ref: text.default(''), title: text.default(''), branch: text.default(''), worktree: text.default(''), terminal: terminalLinkSchema.default({ core_id: '', address: '', name: '', role: '', created_by_attempt: false }), pane: text.default(''), session_id: text.default(''), state: text.default(''), commit: text.optional(), integrated_commit: text.optional() });
const attemptSchema = z.object({
  task_id: z.string().max(128), ref: text, workflow: text.default('default'), attempt_id: z.string().max(128), generation: z.number().nonnegative().default(0),
  origin: z.enum(['central_store', 'aven_recovery']), observed_at_ms: z.number().nonnegative(), created_at_ms: z.number().nonnegative().default(0),
  state: text, execution_mode: z.enum(['single-session', 'subsessions', 'worktrees']).default('single-session'), backend: text.default(''), core_id: text.default(''),
  terminal: terminalLinkSchema, coordinator_terminal: terminalLinkSchema, babysitter_terminal: terminalLinkSchema,
  branch: text.default(''), worktree: text.default(''), worktree_created_by_attempt: z.boolean().default(false), agent: text.default(''), model: text.default(''),
  coordinator_agent: text.default(''), coordinator_model: text.default(''), coordinator_session_id: text.default(''), babysitter: z.boolean().default(false),
  babysitter_session_id: text.default(''), babysitter_pane: text.default(''), session_id: text.default(''), pane: text.default(''), log_task_ref: text.default(''),
  terminals: z.record(z.string().max(256), observationSchema).default({}), phases: z.array(phaseSchema).max(500).default([]),
});
const sessionSchema = z.object({
  session_id: z.string().max(132), roles: z.array(z.enum(['primary', 'coordinator', 'babysitter', 'phase_worker'])).default([]),
  task_ids: z.array(text).default([]), task_refs: z.array(text).default([]), workflows: z.array(text).default([]), attempt_ids: z.array(text).default([]),
  pane: text.optional(), api: z.object({ state: z.enum(['working', 'idle', 'missing', 'unknown']), freshness: z.enum(['current', 'expired', 'unknown']), observed_at_ms: z.number().nonnegative(), expires_at_ms: z.number().nonnegative(), approval_waiting: z.enum(['yes', 'no', 'unknown']), input_waiting: z.enum(['yes', 'no', 'unknown']), parent_id: text.optional() }),
});
const paneSchema = z.object({ pane_id: z.string().max(128), workspace_id: text, tab_id: text, cwd: text, agent_profile: text.optional(), agent_status: text, agent_session_id: text.optional(), focused: z.boolean(), core_id: text.default(''), name: text.default(''), state: text.default(''), status: text.default(''), status_kind: text.default(''), program: text.default(''), reason: text.default(''), turn: z.number().nonnegative().default(0), reported: z.boolean().default(false), recovered_shell: z.boolean().default(false), labels: z.record(z.string().max(256), z.string().max(1024)).default({}) });
const workspaceSchema = z.object({ workspace_id: text, label: text, repo_root: text.optional(), checkout_path: text.optional(), active_tab_id: text, focused: z.boolean() });
const worktreeSchema = z.object({ path: text, branch: text, head: text.default(''), detached: z.boolean().default(false), primary: z.boolean().default(false), open_workspace_id: text.optional(), origin: z.enum(['core', 'attempt']) });
const coreSchema = z.object({ id: text.default(''), name: text.default(''), version: text.default(''), machine: text.default('') });
const appSchema = z.object({ spaces: z.array(z.object({ id: text, name: text, folder: text.optional() })).max(200).default([]), placements: z.array(z.object({ terminal: text, pane: text, space: text, space_name: text, tab: text, tab_name: text, status: text, app: text, name: text })).max(4000).default([]) });
export const snapshotSchema = z.object({
  schema: z.literal(INSPECT_SCHEMA), observed_at_ms: z.number().nonnegative(), scope: z.object({ project: text, workspace: text, repository: text, cwd: text, project_source: text, workspace_source: text, core_session: text }),
  core: coreSchema.default({ id: '', name: '', version: '', machine: '' }), tasks: z.array(taskSchema).max(5000), attempts: z.array(attemptSchema).max(2000),
  sessions: z.array(sessionSchema).max(64), panes: z.array(paneSchema).max(4000), workspaces: z.array(workspaceSchema).max(2000),
  worktrees: z.array(worktreeSchema).max(2000), app: appSchema.default({ spaces: [], placements: [] }), sources: z.array(healthSchema).max(8),
  candidates: z.array(z.unknown()).max(8000).default([]), relationships: z.array(z.unknown()).max(16000).default([]), conflicts: z.array(z.unknown()).max(4000).default([]), warnings: z.array(text).max(256).default([]),
});
export type InspectSnapshot = z.infer<typeof snapshotSchema>;

export interface AvenTask {
  id: string; ref: string; title: string; project: string; status: string; is_epic: boolean; deleted: boolean;
  priority: string; available_at: string; due_on: string; created_at: string; updated_at: string;
  epic_parent?: { id: string; ref?: string } | null; epic_children: { id: string; ref?: string }[];
}
export interface AvenContext {
  task: { id: string; display_ref: string; status: string };
  project: { key: string }; workspace: { key: string }; metadata: Record<string, unknown>;
  dependencies: { depends_on: { id: string; ref?: string }[]; blocks: { id: string; ref?: string }[] };
  related: { id: string; display_ref?: string }[];
  epic_parent?: { id: string; ref?: string } | null; epic_children: { id: string; ref?: string }[];
}
export interface AvenRead { tasks: AvenTask[]; contexts: Map<string, AvenContext>; contextObservedAt?: Map<string, string>; health: SourceHealth }

export interface Attempt {
  task_id: string; task_ref: string; workflow: string; attempt_id: string; generation: number;
  execution_mode: 'single-session' | 'subsessions' | 'worktrees'; backend: string; core_id: string; core_name: string;
  terminal: TerminalRef; coordinator_terminal: TerminalRef; babysitter_terminal: TerminalRef;
  terminals: Record<string, TerminalObservation>; session_id: string; coordinator_session_id: string; babysitter_session_id: string;
  pane: string; babysitter_pane: string; agent: string; coordinator_agent: string; state: string; worktree: string; branch: string;
  log_task_ref: string; created_at: number; phases: Phase[];
}
export interface TerminalRef { core_id: string; core_name: string; address: string; name: string; role: string; created_by_attempt: boolean }
export interface TerminalObservation { core_id: string; address: string; state: string; status: string; status_kind: string; program: string; reason: string; turn: number; seq: number; updated_at: number; recovery: string }
export interface Phase { task_id: string; task_ref: string; title: string; branch: string; worktree: string; terminal: TerminalRef; pane: string; session_id: string; state: string; commit?: string; integrated_commit?: string }
export interface DispatchRead { attempts: { attempt: Attempt; origin: string; observedAt?: string }[]; health: SourceHealth }

export interface CoreTerminal { address: string; name: string; state: string; status: string; status_kind: string; program: string; reason: string; turn: number; reported: boolean; recovered_shell: boolean; labels: Record<string, string> }
export interface CoreRead { core: { id: string; name: string; version: string; machine: string }; terminals: CoreTerminal[]; observedAt: string; health: SourceHealth }
export interface CoreWorktree { path: string; head: string; branch: string; bare: boolean; detached: boolean }
export interface WorktreeRead { primary: string; worktrees: CoreWorktree[]; health: SourceHealth }
export interface AppPlacement { terminal: string; pane: string; space: string; spaceName: string; tab: string; tabName: string; status: string; app: string; name: string }
export interface AppRead { spaces: { id: string; name: string; folder?: string }[]; placements: AppPlacement[]; health: SourceHealth }
export interface InspectSources { aven: AvenRead; dispatcher: DispatchRead; core: CoreRead; worktrees: WorktreeRead; app: AppRead }

const iso = (ms: number) => new Date(ms || 0).toISOString();
const sourceHealth = (snapshot: InspectSnapshot, name: SourceName): SourceHealth => {
  const health = snapshot.sources.find(item => item.source === name);
  return health ? { source: health.source, status: health.status, observedAt: iso(health.observed_at_ms), message: health.message }
    : { source: name, status: 'unavailable', observedAt: iso(snapshot.observed_at_ms), message: `${name} source was not reported by the inspector` };
};
const terminalRef = (value: InspectSnapshot['attempts'][number]['terminal']): TerminalRef => ({ core_id: value.core_id, core_name: '', address: value.address, name: value.name, role: value.role, created_by_attempt: value.created_by_attempt });
const ref = (value: { id: string; ref?: string } | null | undefined) => value ? { id: value.id, ref: value.ref } : null;

export function inspectSources(snapshot: InspectSnapshot, config: ProjectConfig): InspectSources {
  if (snapshot.scope.project !== config.scope.project) throw new Error('Inspector scope mismatch');
  const avenHealth = sourceHealth(snapshot, 'aven');
  const contexts = new Map<string, AvenContext>();
  const contextObservedAt = new Map<string, string>();
  for (const task of snapshot.tasks) {
    if (!task.hydrated) continue;
    contexts.set(task.id, {
      task: { id: task.id, display_ref: task.ref, status: task.status },
      project: { key: task.project }, workspace: { key: config.scope.workspace }, metadata: {},
      dependencies: { depends_on: task.dependencies.map(item => ({ id: item.id, ref: item.ref })), blocks: task.blocks.map(item => ({ id: item.id, ref: item.ref })) },
      related: task.related.map(item => ({ id: item.id, display_ref: item.ref })),
      epic_parent: ref(task.epic_parent), epic_children: task.epic_children.map(item => ({ id: item.id, ref: item.ref })),
    });
    if (task.context_observed_at_ms !== undefined) contextObservedAt.set(task.id, iso(task.context_observed_at_ms));
  }
  const aven: AvenRead = {
    tasks: snapshot.tasks.map(task => ({
      id: task.id, ref: task.ref, title: task.title, project: task.project, status: task.status, is_epic: task.is_epic,
      deleted: task.deleted, priority: task.priority || 'none', available_at: task.available_at, due_on: task.due_on,
      created_at: task.created_at, updated_at: task.updated_at,
      epic_parent: ref(task.epic_parent), epic_children: task.epic_children.map(item => ({ id: item.id, ref: item.ref })),
    })),
    contexts, contextObservedAt, health: avenHealth,
  };
  const dispatchHealth = sourceHealth(snapshot, 'dispatcher');
  const dispatcher: DispatchRead = {
    attempts: snapshot.attempts.map(item => ({
      origin: item.origin === 'central_store' ? 'central-store' : 'aven-recovery',
      observedAt: item.origin === 'aven_recovery' ? contextObservedAt.get(item.task_id) ?? avenHealth.observedAt : dispatchHealth.observedAt,
      attempt: {
        task_id: item.task_id, task_ref: item.ref, workflow: item.workflow, attempt_id: item.attempt_id, generation: item.generation,
        execution_mode: item.execution_mode, backend: item.backend, core_id: item.core_id, core_name: '',
        terminal: terminalRef(item.terminal), coordinator_terminal: terminalRef(item.coordinator_terminal), babysitter_terminal: terminalRef(item.babysitter_terminal),
        terminals: item.terminals, session_id: item.session_id, coordinator_session_id: item.coordinator_session_id, babysitter_session_id: item.babysitter_session_id,
        pane: item.pane, babysitter_pane: item.babysitter_pane, agent: item.agent, coordinator_agent: item.coordinator_agent, state: item.state,
        worktree: item.worktree, branch: item.branch, log_task_ref: item.log_task_ref, created_at: item.created_at_ms,
        phases: item.phases.map(phase => ({ ...phase, task_ref: phase.ref, terminal: terminalRef(phase.terminal) })),
      },
    })),
    health: dispatchHealth,
  };
  const coreHealth = sourceHealth(snapshot, 'core');
  const worktreeHealth = sourceHealth(snapshot, 'worktrees');
  const appHealth = sourceHealth(snapshot, 'app');
  const enabled = config.scope.core;
  const core: CoreRead = {
    core: snapshot.core,
    terminals: enabled ? snapshot.panes.map(pane => ({
      address: pane.pane_id, name: pane.name, state: pane.state || pane.agent_status, status: pane.status || pane.agent_status,
      status_kind: pane.status_kind, program: pane.program || pane.agent_profile || '', reason: pane.reason, turn: pane.turn,
      reported: pane.reported, recovered_shell: pane.recovered_shell, labels: pane.labels,
    })) : [],
    observedAt: coreHealth.observedAt,
    health: enabled ? coreHealth : { ...coreHealth, status: 'unavailable', message: 'Project has no configured checkout; terminal topology is isolated.' },
  };
  const primary = snapshot.worktrees.find(tree => tree.primary)?.path ?? snapshot.scope.repository;
  const worktrees: WorktreeRead = {
    primary,
    worktrees: enabled ? snapshot.worktrees.map(tree => ({ path: tree.path, head: tree.head, branch: tree.branch, bare: false, detached: tree.detached })) : [],
    health: enabled ? worktreeHealth : { ...worktreeHealth, status: 'unavailable', message: 'Project has no configured checkout; worktree topology is isolated.' },
  };
  const app: AppRead = {
    spaces: enabled ? snapshot.app.spaces : [],
    placements: enabled ? snapshot.app.placements.map(item => ({ terminal: item.terminal, pane: item.pane, space: item.space, spaceName: item.space_name, tab: item.tab, tabName: item.tab_name, status: item.status, app: item.app, name: item.name })) : [],
    health: enabled ? appHealth : { ...appHealth, status: 'unavailable', message: 'Project has no configured checkout; app placement is isolated.' },
  };
  return { aven, dispatcher, core, worktrees, app };
}

export function unavailableSources(config: ProjectConfig, message = 'aven-dispatch inspect unavailable or returned an incompatible payload'): InspectSources {
  const health = (source: SourceName): SourceHealth => ({ source, status: 'unavailable', observedAt: new Date().toISOString(), message });
  return {
    aven: { tasks: [], contexts: new Map(), health: health('aven') },
    dispatcher: { attempts: [], health: health('dispatcher') },
    core: { core: { id: '', name: '', version: '', machine: '' }, terminals: [], observedAt: health('core').observedAt, health: health('core') },
    worktrees: { primary: config.primary, worktrees: [], health: health('worktrees') },
    app: { spaces: [], placements: [], health: health('app') },
  };
}

async function resolveBinary(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.UI_INSPECT_BIN) return env.UI_INSPECT_BIN;
  const local = resolve(process.cwd(), '..', 'target/debug/aven-dispatch');
  try { await access(local, constants.X_OK); return local; } catch { return 'aven-dispatch'; }
}

export type InspectExecutor = (config: ProjectConfig) => Promise<unknown>;

export async function executeInspect(config: ProjectConfig, env = process.env): Promise<unknown> {
  const binary = await resolveBinary(env);
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--store', config.storePath, 'inspect', '--project', config.scope.project, '--workspace', config.scope.workspace, '--cwd', config.scope.cwd, '--json', '--no-api'], { cwd: config.scope.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure = '';
    const fail = (message: string) => { if (!failure) { failure = message; child.kill('SIGKILL'); } };
    const timer = setTimeout(() => fail('Inspector timed out'), TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) fail('Inspector output exceeded the bound'); else if (!failure) chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) fail('Inspector output exceeded the bound'); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Inspector executable unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(new Error(failure));
      if (code !== 0) return reject(new Error('Inspector command failed'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Inspector returned malformed JSON')); }
    });
  });
}

// Structural snapshots change slowly compared with the live API lane. Cache and
// coalesce so both collector lanes share at most one inspector process.
export function createInspectSource(config: ProjectConfig, execute: InspectExecutor = executeInspect) {
  let cached: InspectSources | undefined;
  let time = 0;
  let pending: Promise<InspectSources> | undefined;
  return async (): Promise<InspectSources> => {
    if (cached && Date.now() - time < 3000) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const snapshot = snapshotSchema.parse(await execute(config));
        return inspectSources(snapshot, config);
      } catch {
        return unavailableSources(config);
      }
    })();
    try { cached = await pending; time = Date.now(); return cached; }
    finally { pending = undefined; }
  };
}

// Kept for tests and callers that already have a validated snapshot.
export function staticInspectSource(sources: InspectSources) { return async () => sources; }

