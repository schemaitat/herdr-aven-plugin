import { open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { AvenRead } from './aven.js';
import type { SourceHealth } from '../../shared/graph.js';

const value = z.string().max(16384).default('');
const phaseSchema = z.object({ task_id: z.string().min(1).max(128), task_ref: value, pane: value, session_id: value, branch: value, worktree: value, state: value });
export const attemptSchema = z.object({
  task_id: z.string().min(1).max(128), task_ref: value, workflow: z.string().min(1).max(128).default('default'),
  attempt_id: z.string().min(1).max(128), generation: z.number().int().nonnegative().safe().default(0),
  execution_mode: z.enum(['single-session', 'subsessions', 'worktrees']).default('single-session'),
  session_id: value, coordinator_session_id: value, babysitter_session_id: value,
  pane: value, babysitter_pane: value, agent: value, coordinator_agent: value,
  state: value, worktree: value, branch: value, log_task_ref: value,
  created_at: z.number().nonnegative().default(0), phases: z.array(phaseSchema).max(500).default([]),
});
export type Attempt = z.infer<typeof attemptSchema>;
export interface DispatchRead { attempts: { attempt: Attempt; origin: string; observedAt?: string }[]; health: SourceHealth }

export const ATTEMPT_LIMIT = 2000;

export async function boundedJsonFile(path: string, limit = 4 * 1024 * 1024): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Store exceeds file bounds');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, limit + 1, 0);
    if (bytesRead > limit) throw new Error('Store exceeds file bounds');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}

// Read-only and bounded: no WAL writes, no lock, no reconciliation.
export async function readSqliteAttempts(path: string | undefined): Promise<unknown[]> {
  if (path === undefined) throw new Error('Central dispatcher store not configured');
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare(
      `SELECT payload FROM attempts ORDER BY created_at, task_id, workflow LIMIT ${ATTEMPT_LIMIT + 1}`,
    ).all() as { payload: string }[];
    if (rows.length > ATTEMPT_LIMIT) throw new Error('Too many attempts');
    return rows.map(row => JSON.parse(String(row.payload)));
  } finally { database.close(); }
}

export type AttemptReader = (path: string | undefined) => Promise<unknown[]>;

export async function readDispatcher(path: string | undefined, aven: AvenRead, read: AttemptReader = readSqliteAttempts): Promise<DispatchRead> {
  const health: SourceHealth = { source: 'dispatcher', status: 'ok', observedAt: new Date().toISOString(), message: 'Read-only central SQLite store + Aven recovery snapshots; no lock or reconciliation' };
  const candidates: DispatchRead['attempts'] = [];
  let rejected = 0;
  const accept = (raw: unknown, origin: string, owner?: string, workflow?: string) => {
    const parsed = attemptSchema.safeParse(raw);
    if (!parsed.success || (owner && parsed.data.task_id !== owner) || (workflow && parsed.data.workflow !== workflow)) { rejected++; return; }
    const attempt = parsed.data;
    const context = aven.contexts.get(attempt.task_id);
    if (!context) return; // Unscoped tasks and unknown reset generations are never imported.
    const generation = context.metadata['dispatch.reset-generation'] ?? '0';
    if (typeof generation !== 'string' || !/^\d+$/.test(generation) || Number(generation) !== attempt.generation ||
      (context.metadata['dispatch.reset-state'] !== undefined && context.metadata['dispatch.reset-state'] !== 'completed')) { rejected++; return; }
    candidates.push({ attempt, origin, observedAt: origin === 'aven-recovery' ? aven.contextObservedAt?.get(attempt.task_id) ?? aven.health.observedAt : health.observedAt });
  };
  for (const [taskId, context] of aven.contexts) for (const [key, snapshot] of Object.entries(context.metadata)) {
    if (key === 'dispatch.attempt' || key.startsWith('dispatch.attempt.')) {
      try { accept(JSON.parse(z.string().parse(snapshot)), 'aven-recovery', taskId, key === 'dispatch.attempt' ? undefined : key.slice('dispatch.attempt.'.length)); }
      catch { rejected++; }
    }
  }
  try {
    if (path === undefined) throw new Error('Central dispatcher store not configured');
    const attempts = await read(path);
    if (attempts.length > ATTEMPT_LIMIT) throw new Error('Too many attempts');
    for (const raw of attempts) accept(raw, 'central-store');
  } catch {
    health.status = 'unavailable';
    health.message = path === undefined ? 'Central dispatcher store not configured; scoped Aven recovery snapshots only' : 'Central dispatcher store absent, locked, oversized, or unsupported; scoped Aven recovery snapshots remain available';
  }
  // Latest attempt per task/workflow/generation wins. The central store wins ties (may be ahead of Aven metadata).
  const merged = new Map<string, DispatchRead['attempts'][number]>();
  for (const candidate of candidates) {
    const a = candidate.attempt;
    const key = JSON.stringify([a.task_id, a.workflow, a.generation]);
    const existing = merged.get(key);
    if (!existing || a.created_at >= existing.attempt.created_at) merged.set(key, candidate);
  }
  if (rejected) {
    if (health.status === 'ok') health.status = 'incomplete';
    health.message += `; ${rejected} malformed, mismatched, reset-in-progress or obsolete generation snapshot(s) rejected`;
  }
  return { attempts: [...merged.values()], health };
}
