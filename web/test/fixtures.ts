import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { taskSchema, contextSchema, type AvenRead } from '../server/sources/aven.js';
import type { Scope } from '../server/commands.js';

export const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
export const scratchRoot = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
export const scope: Scope = { cwd: '/repo', project: 'demo', workspace: 'default', herdr: true, session: 'test-session' };
export const config = { scope, primary: '/repo', storePath: '/repo/.aven-dispatch/state.json', projectCheckouts: new Map<string, string>() };
export function avenFixture(): AvenRead {
  const data = fixture('aven');
  return { tasks: data.tasks.map((task: unknown) => taskSchema.parse(task)), contexts: new Map(data.contexts.map((context: unknown) => { const parsed = contextSchema.parse(context); return [parsed.task.id, parsed]; })), health: { source: 'aven', status: 'ok', observedAt: '2026-10-20T00:00:00Z', message: 'fixture' } };
}
