import { describe, expect, it, vi } from 'vitest';
import { normalize, createSnapshotSource } from '../server/graph.js';
import { readDispatcher } from '../server/sources/dispatcher.js';
import { readHerdr } from '../server/sources/herdr.js';
import { entityId } from '../shared/graph.js';
import { avenFixture, config, fixture, scope } from './fixtures.js';

async function snapshot(mode = 'worktrees') {
  const aven = avenFixture();
  const store = fixture('dispatcher');
  store.attempts['ROOT01:implementation'].execution_mode = mode;
  const dispatch = await readDispatcher('/store', aven, async () => store);
  const data = fixture('herdr');
  const herdr = await readHerdr(scope, '/repo', async command => command.kind === 'snapshot' ? data.snapshot : data.worktrees);
  return normalize(config, aven, dispatch, herdr);
}

describe('normalized identity and directed edges', () => {
  it('uses source dates, explicitly converts attempt seconds and ignores observation-only refreshes', async () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const aven = avenFixture();
    aven.tasks[0].updated_at = 'invalid';
    aven.tasks[0].created_at = '2026-10-01T00:00:00Z';
    aven.tasks[1].updated_at = '2026-10-20T10:00:00Z';
    aven.tasks[2].updated_at = '2099-01-01T00:00:00Z';
    aven.tasks[2].created_at = '';
    const dispatch = await readDispatcher('/store', aven, async () => fixture('dispatcher'));
    dispatch.attempts.forEach(({ attempt }) => { attempt.created_at = Date.parse('2026-10-19T12:00:00Z') / 1000; });
    const data = fixture('herdr');
    const herdr = await readHerdr(scope, '/repo', async command => command.kind === 'snapshot' ? data.snapshot : data.worktrees);
    const first = normalize(config, aven, dispatch, herdr, now);
    expect(first.nodes.find(node => node.details.taskId === 'ROOT01' && node.kind === 'epic')?.changedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(first.nodes.filter(node => node.kind === 'attempt').map(node => node.changedAt)).toEqual(['2026-10-19T12:00:00.000Z', '2026-10-19T12:00:00.000Z']);
    expect(first.nodes.find(node => node.details.taskId === 'TASK02' && node.kind === 'task')?.changedAt).toBeUndefined();
    expect(first.nodes.filter(node => node.kind === 'workspace').every(node => node.changedAt === undefined)).toBe(true);
    expect(first.nodes.find(node => node.details.sessionId === 'ses_worker')?.changedAt).toBe('2026-10-20T10:00:00.000Z');
    aven.health.observedAt = dispatch.health.observedAt = herdr.health.observedAt = '2026-10-20T12:00:01Z';
    expect(normalize(config, aven, dispatch, herdr, now + 1000).nodes.map(node => [node.id, node.changedAt])).toEqual(first.nodes.map(node => [node.id, node.changedAt]));
    dispatch.attempts.forEach(({ attempt }) => { attempt.created_at = now; }); // current writer persists milliseconds
    expect(normalize(config, aven, dispatch, herdr, now).nodes.filter(node => node.kind === 'attempt').every(node => node.changedAt === new Date(now).toISOString())).toBe(true);
    for (const invalid of [0, NaN, Infinity, now + 1, (now + 1000) / 1000]) {
      dispatch.attempts.forEach(({ attempt }) => { attempt.created_at = invalid; });
      expect(normalize(config, aven, dispatch, herdr, now).nodes.filter(node => node.kind === 'attempt').every(node => node.changedAt === undefined)).toBe(true);
    }
  });
  it('retains stable IDs, deduplicates mirrored blockers/containment and keeps standalone tasks', async () => {
    const graph = await snapshot();
    expect(graph.nodes.map(node => node.id)).toEqual((await snapshot()).nodes.map(node => node.id));
    expect(new Set(graph.nodes.map(node => node.id)).size).toBe(graph.nodes.length);
    const one = entityId('task', 'default', 'TASK01');
    const two = entityId('task', 'default', 'TASK02');
    expect(graph.edges.filter(edge => edge.kind === 'blocks' && edge.source === two && edge.target === one)).toHaveLength(1);
    expect(graph.edges.filter(edge => edge.kind === 'contains' && edge.target === one)).toHaveLength(1);
    expect(graph.nodes.find(node => node.id === two)?.details.availableAt).toContain('2030');
  });
  it('retains cross-project stubs without private titles/details', async () => {
    const graph = await snapshot();
    expect(graph.nodes.find(node => node.id === entityId('task', 'default', 'OUTSIDE'))?.boundary).toBe(true);
    expect(JSON.stringify(graph)).not.toContain('PRIVATE');
  });
  it('never treats deleted tasks or missing contexts as completed or relation-complete', async () => {
    const aven = avenFixture();
    aven.tasks[1].deleted = true;
    aven.contexts.delete('TASK02');
    const dispatch = await readDispatcher('/store', aven, async () => fixture('dispatcher'));
    const herdr = await readHerdr({ ...scope, herdr: false }, '/repo', async () => { throw new Error('No Herdr'); });
    const graph = normalize(config, aven, dispatch, herdr);
    expect(graph.nodes.find(node => node.details.taskId === 'TASK01' && node.kind === 'task')?.state).toBe('deleted');
    expect(graph.nodes.find(node => node.details.taskId === 'TASK02' && node.kind === 'task')?.details.relationCoverage).toBe('incomplete');
    expect(graph.nodes.filter(node => node.kind === 'session').every(node => node.state === 'unknown')).toBe(true);
  });
  it('uses API-session identity independently of Herdr session and retains cached-context timestamps', async () => {
    const aven = avenFixture();
    aven.contextObservedAt = new Map([['TASK01', '2026-10-19T00:00:00Z']]);
    const dispatch = await readDispatcher('/store', aven, async () => fixture('dispatcher'));
    const data = fixture('herdr');
    const herdr = await readHerdr(scope, '/repo', async command => command.kind === 'snapshot' ? data.snapshot : data.worktrees);
    const first = normalize(config, aven, dispatch, herdr);
    const second = normalize({ ...config, scope: { ...scope, session: 'other-terminal-server' } }, aven, dispatch, herdr);
    expect(first.nodes.filter(node => node.kind === 'session').map(node => node.id)).toEqual(second.nodes.filter(node => node.kind === 'session').map(node => node.id));
    expect(first.edges.find(edge => edge.kind === 'related')?.provenance[0].observedAt).toBe('2026-10-19T00:00:00Z');
  });
  it.each(['single-session', 'subsessions', 'worktrees'])('preserves role/session/resource joins in %s mode', async mode => {
    const graph = await snapshot(mode);
    const agents = graph.nodes.filter(node => node.kind === 'agent');
    expect(agents.map(node => node.details.role)).toEqual(expect.arrayContaining(['worker', 'coordinator', 'babysitter']));
    expect(new Set(agents.map(node => node.id)).size).toBe(agents.length);
    const session = graph.nodes.filter(node => node.details.sessionId === 'ses_root');
    expect(session).toHaveLength(1);
    expect(session[0].state).toBe('unknown');
    expect(session[0].details.terminalObservedState).toBe('working');
    expect(graph.edges.filter(edge => edge.kind === 'session' && edge.target === session[0].id)).toHaveLength(1);
    expect(graph.nodes.find(node => node.id === entityId('task', 'default', 'TASK01'))?.state).toBe('todo');
    expect(graph.edges.some(edge => edge.kind === 'worktree' && edge.target === entityId('worktree', '/repo-phase1'))).toBe(true);
    expect(graph.nodes.filter(node => node.kind === 'attempt')).toHaveLength(2);
  });
  it('preserves missing panes/sessions as unresolved resources and strips raw store payloads', async () => {
    const graph = await snapshot();
    expect(graph.nodes.find(node => node.id === entityId('pane', scope.session, 'w1:p2'))?.boundary).toBe(true);
    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain('NEVER_EXPOSE');
    expect(serialized).not.toContain('pending_prompt');
    expect(serialized).not.toContain('headers');
    for (const edge of graph.edges) {
      expect(graph.nodes.some(node => node.id === edge.source)).toBe(true);
      expect(graph.nodes.some(node => node.id === edge.target)).toBe(true);
    }
  });
  it('fences attempt identity across reset generations and avoids delimiter collisions', () => {
    expect(entityId('agent', 'a:b', 'c')).not.toBe(entityId('agent', 'a', 'b:c'));
    expect(entityId('attempt', 'ROOT01', 'implementation', 1, 'a')).not.toBe(entityId('attempt', 'ROOT01', 'implementation', 2, 'a'));
  });
  it('coalesces concurrent snapshot requests and caches bounded source reads', async () => {
    const data = fixture('aven');
    let calls = 0;
    const source = createSnapshotSource({ ...config, scope: { ...scope, herdr: false }, storePath: '/nonexistent' }, async command => {
      calls++;
      if (command.kind === 'list') return command.upcoming ? [] : data.tasks;
      if (command.kind === 'context') return data.contexts.find((context: { task: { display_ref: string } }) => context.task.display_ref === command.ref);
      throw new Error('Forbidden');
    });
    const [one, two] = await Promise.all([source(), source()]);
    expect(one).toBe(two);
    expect(await source()).toBe(one);
    expect(calls).toBe(5);
    expect(one.health.find(health => health.source === 'herdr')?.status).toBe('unavailable');
  });
  it('retains the last snapshot explicitly stale during an Aven outage', async () => {
    const data = fixture('aven');
    let fail = false;
    const source = createSnapshotSource({ ...config, scope: { ...scope, herdr: false }, storePath: '/nonexistent' }, async command => {
      if (fail) throw new Error('Offline');
      if (command.kind === 'list') return command.upcoming ? [] : data.tasks;
      if (command.kind === 'context') return data.contexts.find((context: { task: { display_ref: string } }) => context.task.display_ref === command.ref);
      throw new Error('Forbidden');
    });
    const first = await source();
    fail = true;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
    try {
      const stale = await source();
      expect(stale.nodes).toEqual(first.nodes);
      expect(stale.observedAt).toBe(first.observedAt);
      expect(stale.health.every(health => health.status === 'stale')).toBe(true);
      fail = false;
      clock.mockReturnValue(Date.now() + 5000);
      expect((await source()).health.find(health => health.source === 'aven')?.status).toBe('ok');
    } finally { clock.mockRestore(); }
  });
});
