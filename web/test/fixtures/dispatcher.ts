import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Mirrors the dispatcher's central `attempts` table so dashboard tests exercise
// the same read path as production.
export interface DispatcherFixture { attempts: Record<string, any> }

export function dispatcherFixture(): DispatcherFixture {
  return {
    attempts: {
      'ROOT01:implementation': {
        task_id: 'ROOT01', task_ref: 'DEMO-ROOT', workflow: 'implementation', attempt_id: 'attempt1', generation: 0,
        execution_mode: 'worktrees', session_id: 'ses_root', coordinator_session_id: 'ses_root', pane: 'w1:p1', agent: 'same-name', coordinator_agent: 'same-name', state: 'running', worktree: '/repo', branch: 'main', created_at: 12,
        babysitter_session_id: 'ses_baby', babysitter_pane: 'w1:p2',
        pending_prompt: 'NEVER_EXPOSE_PROMPT', aven: { headers: 'NEVER_EXPOSE_CREDENTIAL', origin_cwd: '/private' },
        phases: [{ task_id: 'TASK01', task_ref: 'DEMO-ONE', session_id: 'ses_worker', pane: 'w2:p1', branch: 'phase1', worktree: '/repo-phase1', state: 'running' }],
      },
      'ROOT01:planning': { task_id: 'ROOT01', task_ref: 'DEMO-ROOT', workflow: 'planning', attempt_id: 'attemptPlan', generation: 0, session_id: 'ses_plan', agent: 'same-name', state: 'idle', created_at: 10 },
    },
  };
}

export function dispatcherAttempts(store: DispatcherFixture = dispatcherFixture()): unknown[] {
  return Object.values(store.attempts);
}

export function seedDispatcherStore(path: string, attempts: unknown[] = dispatcherAttempts()): void {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE attempts (
      task_id TEXT NOT NULL, workflow TEXT NOT NULL, attempt_id TEXT NOT NULL, task_ref TEXT NOT NULL,
      state TEXT NOT NULL, generation INTEGER NOT NULL, session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (task_id, workflow)
    )`);
    const insert = database.prepare(`INSERT INTO attempts
      (task_id, workflow, attempt_id, task_ref, state, generation, session_id, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const raw of attempts) {
      const attempt = raw as Record<string, any>;
      insert.run(
        String(attempt.task_id), String(attempt.workflow ?? 'default'), String(attempt.attempt_id),
        String(attempt.task_ref ?? ''), String(attempt.state ?? ''), Number(attempt.generation ?? 0),
        String(attempt.session_id ?? ''), Number(attempt.created_at ?? 0), Date.now(),
        JSON.stringify(attempt),
      );
    }
  } finally { database.close(); }
}
