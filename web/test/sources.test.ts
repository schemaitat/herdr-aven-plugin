import { describe, expect, it } from 'vitest';
import { avenSource, taskSchema } from '../server/sources/aven.js';
import { readDispatcher, boundedJsonFile } from '../server/sources/dispatcher.js';
import { readHerdr } from '../server/sources/herdr.js';
import { primaryCheckout, startupConfig } from '../server/config.js';
import { fixture, scope, avenFixture, scratchRoot } from './fixtures.js';
import { LIST_LIMIT, type ReadCommand, type Runner } from '../server/commands.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

describe('Aven scoped bounded source', () => {
  it('retains optional created/updated source dates without requiring them in older records', () => {
    const task = fixture('aven').tasks[0];
    expect(taskSchema.parse({ ...task, created_at: '2026-01-01T00:00:00Z' }).created_at).toBe('2026-01-01T00:00:00Z');
    const { created_at, updated_at, ...old } = task;
    expect(taskSchema.parse(old)).toMatchObject({ created_at: '', updated_at: '' });
  });
  const data = fixture('aven');
  const runner = (commands: ReadCommand[]): Runner => async command => {
    commands.push(command);
    if (command.kind === 'list') return command.upcoming ? [data.tasks[2]] : data.tasks.slice(0, 2);
    if (command.kind === 'context') return data.contexts.find((context: { task: { display_ref: string } }) => context.task.display_ref === command.ref);
    throw new Error('Unexpected command');
  };
  it('includes deferred tasks, hydrates relations, caches and never requests outside boundary details', async () => {
    const calls: ReadCommand[] = [];
    const source = avenSource(scope, runner(calls));
    const result = await source();
    expect(result.tasks).toHaveLength(3);
    expect(result.contexts.size).toBe(3);
    expect(result.health.status).toBe('ok');
    await source();
    expect(calls.filter(command => command.kind === 'context')).toHaveLength(3);
    expect(calls).not.toContainEqual({ kind: 'context', ref: 'OTHER-ONE' });
    expect(calls.filter(command => command.kind === 'list')).toHaveLength(4);
  });
  it('rotates bounded hydration and reports partial coverage', async () => {
    const source = avenSource(scope, runner([]), 1);
    expect((await source()).health.status).toBe('incomplete');
    await source();
    expect((await source()).contexts.size).toBe(3);
  });
  it('reports capped lists rather than claiming full coverage', async () => {
    const result = await avenSource(scope, async command => command.kind === 'list' ? Array.from({ length: LIST_LIMIT }, (_, i) => ({ ...data.tasks[0], id: `ID${i}`, ref: `DEMO-N${i}` })) : {}, 0)();
    expect(result.health.status).toBe('incomplete');
    expect(result.health.message).toContain(String(LIST_LIMIT));
  });
  it.each([null, { tasks: [] }, [{ id: 42 }]])('degrades malformed lists %j', async malformed => {
    expect((await avenSource(scope, async () => malformed)()).health.status).toBe('unavailable');
  });
  it('degrades timeouts without disclosing command stderr', async () => {
    const result = await avenSource(scope, async () => { throw new Error('SECRET error'); })();
    expect(result.health.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('rejects wrong project and wrong immutable task context identity', async () => {
    const source = avenSource(scope, async command => command.kind === 'list' ? [data.tasks[0], { ...data.tasks[1], project: 'private' }] : data.contexts[1]);
    const result = await source();
    expect(result.tasks).toHaveLength(1);
    expect(result.contexts.size).toBe(0);
    expect(result.health.status).toBe('incomplete');
  });
});

describe('dispatcher immutable snapshots', () => {
  it('strips invocations, prompts and credentials while retaining separate workflows', async () => {
    const result = await readDispatcher('/unused', avenFixture(), async () => fixture('dispatcher'));
    expect(result.attempts).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('NEVER_EXPOSE');
    expect(result.attempts.map(value => value.attempt.workflow).sort()).toEqual(['implementation', 'planning']);
  });
  it('recovers absent store from Aven metadata and prefers same-attempt local phase updates', async () => {
    const aven = avenFixture();
    const store = fixture('dispatcher');
    const attempt = store.attempts['ROOT01:implementation'];
    aven.contexts.get('ROOT01')!.metadata['dispatch.attempt.implementation'] = JSON.stringify({ ...attempt, state: 'older' });
    const recovered = await readDispatcher('/missing', aven, async () => { throw new Error('ENOENT'); });
    expect(recovered.attempts[0].origin).toBe('aven-recovery');
    expect(recovered.health.status).toBe('unavailable');
    const merged = await readDispatcher('/store', aven, async () => store);
    expect(merged.attempts.find(value => value.attempt.workflow === 'implementation')?.attempt.state).toBe('running');
  });
  it('rejects obsolete reset generations and incomplete resets', async () => {
    const aven = avenFixture();
    aven.contexts.get('ROOT01')!.metadata['dispatch.reset-generation'] = '1';
    expect((await readDispatcher('/store', aven, async () => fixture('dispatcher'))).attempts).toHaveLength(0);
    aven.contexts.get('ROOT01')!.metadata['dispatch.reset-generation'] = '0';
    aven.contexts.get('ROOT01')!.metadata['dispatch.reset-state'] = 'incomplete';
    expect((await readDispatcher('/store', aven, async () => fixture('dispatcher'))).attempts).toHaveLength(0);
  });
  it('rejects owner/workflow mismatches and unsupported execution modes', async () => {
    const aven = avenFixture();
    const attempt = fixture('dispatcher').attempts['ROOT01:implementation'];
    aven.contexts.get('TASK01')!.metadata['dispatch.attempt.implementation'] = JSON.stringify(attempt);
    aven.contexts.get('ROOT01')!.metadata['dispatch.attempt.planning'] = JSON.stringify(attempt);
    const result = await readDispatcher('/store', aven, async () => ({ attempts: { bad: { ...attempt, execution_mode: 'shell' } } }));
    expect(result.attempts).toHaveLength(0);
    expect(result.health.status).toBe('incomplete');
  });
  it('does not import unrelated store tasks', async () => {
    const result = await readDispatcher('/store', avenFixture(), async () => ({ attempts: { private: { ...fixture('dispatcher').attempts['ROOT01:planning'], task_id: 'PRIVATE' } } }));
    expect(result.attempts).toHaveLength(0);
  });
});

describe('Herdr scoped topology', () => {
  const data = fixture('herdr');
  it('filters unrelated workspaces and never exposes raw terminal titles', async () => {
    const result = await readHerdr(scope, '/repo', async command => command.kind === 'snapshot' ? data.snapshot : data.worktrees);
    expect(result.panes).toHaveLength(2);
    expect(result.workspaces).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('does not invoke Herdr outside inherited context', async () => {
    let called = false;
    const result = await readHerdr({ ...scope, herdr: false }, '/repo', async () => { called = true; });
    expect(called).toBe(false);
    expect(result.health.status).toBe('unavailable');
  });
  it.each([null, {}, { result: { snapshot: { workspaces: [], panes: [{}] } } }])('degrades malformed topology %j', async malformed => {
    expect((await readHerdr(scope, '/repo', async () => malformed)).health.status).toBe('unavailable');
  });
  it('rejects a worktree inventory from another repository', async () => {
    expect((await readHerdr(scope, '/other', async command => command.kind === 'snapshot' ? data.snapshot : data.worktrees)).health.status).toBe('unavailable');
  });
});

it('resolves linked primary checkout and explicit relative store without opening a lock', async () => {
  const temp = await mkdtemp(join(scratchRoot, 'explorer-paths-'));
  try {
    const primary = join(temp, 'primary');
    const linked = join(temp, 'phase');
    await mkdir(join(primary, '.git/worktrees/phase'), { recursive: true });
    await mkdir(linked);
    await writeFile(join(linked, '.git'), `gitdir: ${primary}/.git/worktrees/phase\n`);
    await writeFile(join(primary, '.git/worktrees/phase/commondir'), '../..\n');
    expect(await primaryCheckout(linked)).toBe(primary);
    const config = await startupConfig({ AVEN_DISPATCH_STORE: 'custom/state.json' }, linked);
    expect(config.storePath).toBe(join(linked, 'custom/state.json'));
    expect((await startupConfig({}, linked)).storePath).toBe(join(primary, '.aven-dispatch/state.json'));
    await writeFile(join(temp, 'data.json'), JSON.stringify({ valid: true }));
    expect(await boundedJsonFile(join(temp, 'data.json'))).toEqual({ valid: true });
    await expect(boundedJsonFile(join(temp, 'data.json'), 2)).rejects.toThrow('bounds');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
