import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeInspect, inspectSources, snapshotSchema, createInspectSource, unavailableSources } from '../server/sources/inspect.js';
import { configuredProjectCheckouts, primaryCheckout, startupConfig } from '../server/config.js';
import { boundedJsonFile } from '../server/sources/bounded.js';
import { config, inspectSnapshot as snapshot, scratchRoot, scope } from './fixtures.js';

describe('inspector contract client', () => {
  it('maps the single inspector snapshot into dashboard graph inputs', () => {
    const sources = inspectSources(snapshot(), config);
    expect(sources.aven.tasks.map(task => task.ref)).toEqual(['DEMO-ROOT', 'DEMO-ONE', 'DEMO-TWO']);
    expect(sources.aven.contexts.get('TASK01')?.related).toEqual([{ id: 'TASK02', display_ref: 'DEMO-TWO' }]);
    expect(sources.aven.tasks[0].created_at).toBe('');
    expect(sources.dispatcher.attempts.map(item => item.attempt.workflow).sort()).toEqual(['implementation', 'planning']);
    expect(sources.dispatcher.attempts[0].attempt.terminals.coordinator.state).toBe('live');
    expect(sources.core.core.id).toBe('core-1');
    expect(sources.core.terminals.map(terminal => terminal.address)).toEqual(['t1', 't2', 't3', 't9']);
    expect(sources.worktrees.primary).toBe('/repo');
    expect(sources.worktrees.worktrees.map(tree => tree.branch)).toEqual(['refs/heads/main', 'refs/heads/phase1']);
    expect(sources.app.placements[0]).toMatchObject({ terminal: 't1', spaceName: 'demo' });
  });

  it('isolates topology for a project without a configured checkout', () => {
    const raw = snapshot();
    raw.scope.project = 'other';
    const sources = inspectSources(raw, { ...config, scope: { ...scope, project: 'other', core: false } });
    expect(sources.core.terminals).toHaveLength(0);
    expect(sources.worktrees.worktrees).toHaveLength(0);
    expect(sources.app.placements).toHaveLength(0);
    expect(sources.core.health.status).toBe('unavailable');
  });

  it('rejects a scope mismatch instead of mixing projects', () => {
    expect(() => inspectSources(snapshot(), { ...config, scope: { ...scope, project: 'other' } })).toThrow('scope mismatch');
  });

  it('degrades missing or incompatible output to unavailable sources', async () => {
    const read = createInspectSource(config, async () => ({ schema: 'wrong' }));
    const sources = await read();
    expect(sources.aven.health.status).toBe('unavailable');
    expect(sources.dispatcher.attempts).toHaveLength(0);
    expect(sources.core.terminals).toHaveLength(0);
    expect(unavailableSources(config).aven.health.status).toBe('unavailable');
  });

  it('runs the configured binary with the authorized scope and --no-api', async () => {
    const temp = await mkdtemp(join(scratchRoot, 'inspect-bin-'));
    try {
      const log = join(temp, 'args');
      const binary = join(temp, 'inspect');
      await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$*" > '${log}'\ncat <<'JSON'\n${JSON.stringify(snapshot())}\nJSON\n`);
      await chmod(binary, 0o755);
      const result = await executeInspect({ ...config, scope: { ...scope, cwd: temp } }, { UI_INSPECT_BIN: binary });
      expect(snapshotSchema.parse(result).schema).toBe('aven-dispatch-inspect/v1');
      const text = await readFile(log, 'utf8');
      expect(text).toContain('inspect');
      expect(text).toContain('--no-api');
      expect(text).toContain('--project');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('reports a missing inspector executable without falling back to another parser', async () => {
    await expect(executeInspect(config, { UI_INSPECT_BIN: '/no/such/inspector' })).rejects.toThrow('unavailable');
  });
});

it('resolves linked primary checkout and explicit relative store without opening a lock', async () => {
  const temp = await mkdtemp(join(scratchRoot, 'explorer-paths-'));
  try {
    const primary = join(temp, 'primary');
    const linked = join(temp, 'phase');
    await mkdir(primary);
    await mkdir(linked);
    await writeFile(join(temp, 'data.json'), JSON.stringify({ valid: true }));
    expect(await primaryCheckout(linked)).toBe(linked);
    const config = await startupConfig({ AVEN_DISPATCH_STORE: 'custom/dispatch.sqlite', UI_PROJECT_CHECKOUTS: JSON.stringify({ other: primary }) }, linked);
    expect(config.storePath).toBe(join(linked, 'custom/dispatch.sqlite'));
    expect(config.projectCheckouts.get('other')).toBe(primary);
    expect((await startupConfig({ XDG_STATE_HOME: join(temp, 'state') }, linked)).storePath).toBe(join(temp, 'state/aven/dispatch.sqlite'));
    expect(await boundedJsonFile(join(temp, 'data.json'))).toEqual({ valid: true });
    await expect(boundedJsonFile(join(temp, 'data.json'), 2)).rejects.toThrow('bounds');
    await configuredProjectCheckouts(JSON.stringify({ demo: temp }));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

it('accepts only bounded absolute server-configured project checkout mappings', async () => {
  const temp = await mkdtemp(join(scratchRoot, 'explorer-config-'));
  try {
    await expect(configuredProjectCheckouts(JSON.stringify({ demo: temp }))).resolves.toEqual(new Map([['demo', temp]]));
    await expect(configuredProjectCheckouts(JSON.stringify({ '../escape': temp }))).rejects.toThrow('Invalid');
    await expect(configuredProjectCheckouts(JSON.stringify({ demo: 'relative/path' }))).rejects.toThrow('Invalid');
    await expect(configuredProjectCheckouts('{not json')).rejects.toThrow();
  } finally { await rm(temp, { recursive: true, force: true }); }
});
