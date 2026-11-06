import type { InspectSnapshot } from '../../server/sources/inspect.js';
import { inspectSources, type InspectSources } from '../../server/sources/inspect.js';
import type { ProjectConfig } from '../../server/config.js';
import type { Scope } from '../../server/commands.js';

export const scope: Scope = { cwd: '/repo', project: 'demo', workspace: 'default', core: true, session: 'test-session' };
export const config: ProjectConfig = { scope, primary: '/repo', storePath: '/state/aven/dispatch.sqlite', projectCheckouts: new Map<string, string>() };

const health = (source: 'aven' | 'dispatcher' | 'core' | 'worktrees' | 'app', status: 'ok' | 'incomplete' | 'unavailable' | 'stale' = 'ok', message = 'fixture') => ({ source, status, observed_at_ms: Date.parse('2026-10-20T00:00:00Z'), message });

// One consolidated structural fixture. Every dashboard test derives its view
// from this inspector snapshot instead of maintaining parallel Aven/core/app
// fixtures.
export function inspectSnapshot(): InspectSnapshot {
  return {
    schema: 'aven-dispatch-inspect/v1', observed_at_ms: Date.parse('2026-10-20T00:00:00Z'),
    scope: { project: 'demo', workspace: 'default', repository: '/repo', cwd: '/repo', project_source: 'explicit', workspace_source: 'default', core_session: 'hc' },
    core: { id: 'core-1', name: 'local-core', version: '0.1.15', machine: 'test' },
    tasks: [
      {
        id: 'ROOT01', ref: 'DEMO-ROOT', title: 'A project epic', project: 'demo', status: 'active', is_epic: true,
        deleted: false, priority: 'none', available_at: '', due_on: '', created_at: '', updated_at: '',
        epic_children: [{ kind: 'task', id: 'TASK01', ref: 'DEMO-ONE', label: 'Child task' }], dependencies: [], blocks: [], related: [],
        plan: { plan_worked_out: false, reset_generation: 0 }, hydrated: true, context_observed_at_ms: Date.parse('2026-10-20T00:00:00Z'),
      },
      {
        id: 'TASK01', ref: 'DEMO-ONE', title: 'Child task', project: 'demo', status: 'todo', is_epic: false,
        deleted: false, priority: 'none', available_at: '', due_on: '', created_at: '', updated_at: '',
        epic_parent: { kind: 'task', id: 'ROOT01', ref: 'DEMO-ROOT', label: 'A project epic' }, epic_children: [],
        dependencies: [
          { kind: 'dependency', id: 'TASK02', ref: 'DEMO-TWO', title: 'Standalone deferred', status: 'todo', hydrated: true },
          { kind: 'dependency', id: 'OUTSIDE', ref: 'OTHER-ONE', title: 'PRIVATE OTHER PROJECT TITLE', status: 'todo', hydrated: false },
        ],
        blocks: [], related: [{ kind: 'related', id: 'TASK02', ref: 'DEMO-TWO', hydrated: true }],
        plan: { plan_worked_out: false, reset_generation: 0 }, hydrated: true, context_observed_at_ms: Date.parse('2026-10-20T00:00:00Z'),
      },
      {
        id: 'TASK02', ref: 'DEMO-TWO', title: 'Standalone deferred', project: 'demo', status: 'todo', is_epic: false,
        deleted: false, priority: 'none', available_at: '2030-01-01T00:00:00Z', due_on: '', created_at: '', updated_at: '',
        epic_parent: null, epic_children: [], dependencies: [], blocks: [{ kind: 'blocker', id: 'TASK01', ref: 'DEMO-ONE', title: 'Child task', status: 'todo', hydrated: true }], related: [],
        plan: { plan_worked_out: false, reset_generation: 0 }, hydrated: true, context_observed_at_ms: Date.parse('2026-10-20T00:00:00Z'),
      },
    ],
    attempts: [
      {
        task_id: 'ROOT01', ref: 'DEMO-ROOT', workflow: 'implementation', attempt_id: 'attempt1', generation: 0,
        origin: 'central_store', observed_at_ms: Date.parse('2026-10-20T00:00:00Z'), created_at_ms: 12,
        state: 'running', execution_mode: 'worktrees', backend: 'hc', core_id: 'core-1',
        terminal: { core_id: 'core-1', address: 't1', name: '', role: 'builder', created_by_attempt: true },
        coordinator_terminal: { core_id: 'core-1', address: 't1', name: '', role: 'coordinator', created_by_attempt: true },
        babysitter_terminal: { core_id: 'core-1', address: 't2', name: '', role: 'babysitter', created_by_attempt: true },
        branch: 'main', worktree: '/repo', worktree_created_by_attempt: false, agent: 'same-name', model: '', coordinator_agent: 'same-name', coordinator_model: '',
        coordinator_session_id: 'ses_root', babysitter: false, babysitter_session_id: 'ses_baby', babysitter_pane: 'w1:p2',
        session_id: 'ses_root', pane: 'w1:p1', log_task_ref: 'DEMO-LOG',
        terminals: { coordinator: { core_id: 'core-1', address: 't1', state: 'live', status: 'working', status_kind: '', program: 'opencode', reason: '', turn: 4, seq: 1, updated_at: 1, recovery: '' } },
        phases: [{ task_id: 'TASK01', ref: 'DEMO-ONE', title: 'Child task', branch: 'phase1', worktree: '/repo-phase1', terminal: { core_id: 'core-1', address: 't3', name: '', role: 'phase', created_by_attempt: true }, pane: 'w2:p1', session_id: 'ses_worker', state: 'running' }],
      },
      {
        task_id: 'ROOT01', ref: 'DEMO-ROOT', workflow: 'planning', attempt_id: 'attemptPlan', generation: 0,
        origin: 'central_store', observed_at_ms: Date.parse('2026-10-20T00:00:00Z'), created_at_ms: 10,
        state: 'idle', execution_mode: 'single-session', backend: 'herdr', core_id: '',
        terminal: { core_id: '', address: '', name: '', role: '', created_by_attempt: false },
        coordinator_terminal: { core_id: '', address: '', name: '', role: '', created_by_attempt: false },
        babysitter_terminal: { core_id: '', address: '', name: '', role: '', created_by_attempt: false },
        branch: '', worktree: '', worktree_created_by_attempt: false, agent: 'same-name', model: '', coordinator_agent: '', coordinator_model: '',
        coordinator_session_id: '', babysitter: false, babysitter_session_id: '', babysitter_pane: '', session_id: 'ses_plan', pane: 'w0:p1', log_task_ref: '',
        terminals: {}, phases: [],
      },
    ],
    sessions: [
      { session_id: 'ses_root', roles: ['primary', 'coordinator'], task_ids: ['ROOT01'], task_refs: ['DEMO-ROOT'], workflows: ['implementation'], attempt_ids: ['attempt1'], api: { state: 'unknown', freshness: 'unknown', observed_at_ms: 0, expires_at_ms: 0, approval_waiting: 'unknown', input_waiting: 'unknown' } },
      { session_id: 'ses_baby', roles: ['babysitter'], task_ids: ['ROOT01'], task_refs: ['DEMO-ROOT'], workflows: ['implementation'], attempt_ids: ['attempt1'], api: { state: 'unknown', freshness: 'unknown', observed_at_ms: 0, expires_at_ms: 0, approval_waiting: 'unknown', input_waiting: 'unknown' } },
      { session_id: 'ses_worker', roles: ['phase_worker'], task_ids: ['ROOT01'], task_refs: ['DEMO-ROOT'], workflows: ['implementation'], attempt_ids: ['attempt1'], api: { state: 'unknown', freshness: 'unknown', observed_at_ms: 0, expires_at_ms: 0, approval_waiting: 'unknown', input_waiting: 'unknown' } },
      { session_id: 'ses_plan', roles: ['primary'], task_ids: ['ROOT01'], task_refs: ['DEMO-ROOT'], workflows: ['planning'], attempt_ids: ['attemptPlan'], api: { state: 'unknown', freshness: 'unknown', observed_at_ms: 0, expires_at_ms: 0, approval_waiting: 'unknown', input_waiting: 'unknown' } },
    ],
    panes: [
      { pane_id: 't1', workspace_id: 'w1', tab_id: '', cwd: '/repo', agent_profile: 'opencode', agent_status: 'working', focused: false, core_id: 'core-1', name: 'aven-demo-root', state: 'live', status: 'working', status_kind: '', program: 'opencode', reason: '', turn: 4, reported: true, recovered_shell: false, labels: { 'aven.task': 'DEMO-ROOT', 'aven.task_id': 'ROOT01', 'aven.role': 'coordinator', 'aven.workflow': 'implementation' } },
      { pane_id: 't2', workspace_id: 'w1', tab_id: '', cwd: '/repo', agent_profile: 'opencode', agent_status: 'idle', focused: false, core_id: 'core-1', name: 'aven-demo-babysitter', state: 'live', status: 'idle', status_kind: '', program: 'opencode', reason: '', turn: 1, reported: true, recovered_shell: false, labels: { 'aven.task': 'DEMO-ROOT', 'aven.task_id': 'ROOT01', 'aven.role': 'babysitter' } },
      { pane_id: 't3', workspace_id: 'w2', tab_id: '', cwd: '/repo-phase1', agent_profile: 'opencode', agent_status: 'blocked', focused: false, core_id: 'core-1', name: 'aven-demo-phase-one', state: 'live', status: 'blocked', status_kind: 'permission', program: 'opencode', reason: '', turn: 2, reported: true, recovered_shell: false, labels: { 'aven.task': 'DEMO-ONE', 'aven.task_id': 'TASK01', 'aven.role': 'phase' } },
      { pane_id: 't9', workspace_id: 'w3', tab_id: '', cwd: '/private', agent_profile: 'zsh', agent_status: 'working', focused: false, core_id: 'core-1', name: 'unrelated', state: 'live', status: 'working', status_kind: '', program: 'zsh', reason: '', turn: 0, reported: false, recovered_shell: true, labels: {} },
    ],
    workspaces: [
      { workspace_id: 'w1', label: 'w1', active_tab_id: '', focused: false },
      { workspace_id: 'w2', label: 'w2', active_tab_id: '', focused: false },
      { workspace_id: 'w3', label: 'w3', active_tab_id: '', focused: false },
    ],
    worktrees: [
      { path: '/repo', branch: 'refs/heads/main', head: 'deadbeef', detached: false, primary: true, origin: 'core' },
      { path: '/repo-phase1', branch: 'refs/heads/phase1', head: 'feedface', detached: false, primary: false, origin: 'core' },
    ],
    app: {
      spaces: [{ id: 'w1', name: 'demo', folder: '/repo' }, { id: 'w2', name: 'phase one', folder: '/repo-phase1' }, { id: 'w3', name: 'private', folder: '/private' }],
      placements: [
        { terminal: 't1', pane: 'w1:p1', space: 'w1', space_name: 'demo', tab: 'w1:t1', tab_name: 'root', status: 'working', app: 'opencode', name: '' },
        { terminal: 't2', pane: 'w1:p2', space: 'w1', space_name: 'demo', tab: 'w1:t1', tab_name: 'root', status: 'idle', app: 'opencode', name: '' },
        { terminal: 't3', pane: 'w2:p1', space: 'w2', space_name: 'phase one', tab: 'w2:t1', tab_name: 'phase', status: 'blocked', app: 'opencode', name: '' },
        { terminal: 't9', pane: 'w3:p1', space: 'w3', space_name: 'private', tab: 'w3:t1', tab_name: 'private', status: 'working', app: 'zsh', name: '' },
      ],
    },
    sources: [health('aven'), health('dispatcher'), health('core'), health('worktrees'), health('app')],
    candidates: [], relationships: [], conflicts: [], warnings: [],
  };
}

export function inspectSourcesFixture(): InspectSources {
  return inspectSources(inspectSnapshot(), config);
}

export function avenFixture() {
  return inspectSourcesFixture().aven;
}
