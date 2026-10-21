import { spawn } from 'node:child_process';

export interface Scope { cwd: string; project: string; workspace: string; herdr: boolean; session: string }
export type ReadCommand =
  | { kind: 'projects' }
  | { kind: 'list'; upcoming?: boolean }
  | { kind: 'context'; ref: string }
  | { kind: 'snapshot' }
  | { kind: 'worktrees' };
export const LIST_LIMIT = 500;
export type Runner = (command: ReadCommand) => Promise<unknown>;
export const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const PROJECT_LIMIT = 100;

export function commandVector(scope: Scope, command: ReadCommand): [string, string[]] {
  if (!identifier.test(scope.project) || !identifier.test(scope.workspace)) throw new Error('Invalid startup scope');
  const avenScope = ['--project', scope.project, '--workspace', scope.workspace];
  switch (command.kind) {
    case 'projects': return ['aven', ['project', 'list', '--workspace', scope.workspace, '--limit', String(PROJECT_LIMIT), '--json']];
    case 'list': return ['aven', ['list', ...avenScope, '--limit', String(LIST_LIMIT), '--json', ...(command.upcoming ? ['--upcoming'] : [])]];
    case 'context': {
      if (!/^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(command.ref)) throw new Error('Invalid task reference');
      return ['aven', ['context', command.ref, '--workspace', scope.workspace, '--json']];
    }
    case 'snapshot':
      if (!scope.herdr) throw new Error('Herdr is unavailable');
      return ['herdr', ['api', 'snapshot']];
    case 'worktrees':
      if (!scope.herdr) throw new Error('Herdr is unavailable');
      return ['herdr', ['worktree', 'list', '--cwd', scope.cwd]];
    default: throw new Error('Unsupported source command');
  }
}

// No shell, stdin, API-controlled arguments, or executable overrides. Bound both streams together.
export function commandBudget(concurrency = 4) {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    async acquire() { if (active >= concurrency) await new Promise<void>(resolve => queue.push(resolve)); else active++; },
    release() { const next = queue.shift(); if (next) next(); else active--; },
  };
}
const processBudget = commandBudget();
export function createRunner(scope: Scope, bounds = { timeout: 4000, bytes: 4 * 1024 * 1024, concurrency: 4 }, signal?: AbortSignal): Runner {
  const local = commandBudget(bounds.concurrency);
  return async command => {
    const [program, args] = commandVector(scope, command);
    await local.acquire();
    await processBudget.acquire();
    try {
      if (signal?.aborted) throw new Error('Source cancelled');
      return await new Promise<unknown>((resolve, reject) => {
        const child = spawn(program, args, { cwd: scope.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let size = 0;
        let failure = '';
        // Keep the concurrency slot until the killed process has actually exited.
        const fail = (reason: string) => { if (!failure) { failure = reason; child.kill('SIGKILL'); } };
        const timer = setTimeout(() => fail('Source timeout'), bounds.timeout);
        const abort = () => fail('Source cancelled');
        signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > bounds.bytes) fail('Source output limit');
          else if (!failure) chunks.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => { size += chunk.length; if (size > bounds.bytes) fail('Source output limit'); });
        child.on('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Source executable unavailable')); });
        child.on('close', code => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (failure) return reject(new Error(failure));
          if (code !== 0) return reject(new Error('Source command failed'));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('Malformed source JSON')); }
        });
      });
    } finally {
      processBudget.release();
      local.release();
    }
  };
}
