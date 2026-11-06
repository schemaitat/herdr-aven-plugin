import { describe, expect, it, vi } from 'vitest';
import { normalize, createSnapshotSource } from '../server/graph.js';
import { entityId } from '../shared/graph.js';
import { avenFixture, config, inspectSourcesFixture, inspectSnapshot, scope } from './fixtures.js';

function sources(mode = 'worktrees') {
  const next = inspectSourcesFixture();
  next.dispatcher.attempts.find(item => item.attempt.workflow === 'implementation')!.attempt.execution_mode = mode as 'worktrees';
  return next;
}

describe('normalized identity and directed edges', () => {
  it('uses source dates, explicitly converts attempt seconds and ignores observation-only refreshes', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const aven = avenFixture();
    aven.tasks[0].updated_at = 'invalid';
    aven.tasks[0].created_at = '2026-10-01T00:00:00Z';
    aven.tasks[1].updated_at = '2026-10-20T10:00:00Z';
    aven.tasks[2].updated_at = '2099-01-01T00:00:00Z';
    aven.tasks[2].created_at = '';
    const topology = sources();
    topology.dispatcher.attempts.forEach(({ attempt }) => { attempt.created_at = Date.parse('2026-10-19T12:00:00Z') / 1000; });
    const first = normalize(config, aven, topology, now);
    expect(first.nodes.find(node => node.details.taskId === 'ROOT01' && node.kind === 'epic')?.changedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(first.nodes.filter(node => node.kind === 'attempt').map(node => node.changedAt)).toEqual(['2026-10-19T12:00:00.000Z', '2026-10-19T12:00:00.000Z']);
    expect(first.nodes.find(node => node.details.taskId === 'TASK02' && node.kind === 'task')?.changedAt).toBeUndefined();
    expect(first.nodes.filter(node => node.kind === 'workspace').every(node => node.changedAt === undefined)).toBe(true);
    expect(first.nodes.find(node => node.details.sessionId === 'ses_worker')?.changedAt).toBe('2026-10-20T10:00:00.000Z');
    aven.health.observedAt = topology.dispatcher.health.observedAt = '2026-10-20T12:00:01Z';
    expect(normalize(config, aven, topology, now + 1000).nodes.map(node => [node.id, node.changedAt])).toEqual(first.nodes.map(node => [node.id, node.changedAt]));
    topology.dispatcher.attempts.forEach(({ attempt }) => { attempt.created_at = now; }); // current writer persists milliseconds
    expect(normalize(config, aven, topology, now).nodes.filter(node => node.kind === 'attempt').every(node => node.changedAt === new Date(now).toISOString())).toBe(true);
    for (const invalid of [0, NaN, Infinity, now + 1, (now + 1000) / 1000]) {
      topology.dispatcher.attempts.forEach(({ attempt }) => { attempt.created_at = invalid; });
      expect(normalize(config, aven, topology, now).nodes.filter(node => node.kind === 'attempt').every(node => node.changedAt === undefined)).toBe(true);
    }
  });
  it('retains stable IDs, deduplicates mirrored blockers/containment and keeps standalone tasks', () => {
    const graph = normalize(config, avenFixture(), sources());
    expect(graph.nodes.map(node => node.id)).toEqual(normalize(config, avenFixture(), sources()).nodes.map(node => node.id));
    expect(new Set(graph.nodes.map(node => node.id)).size).toBe(graph.nodes.length);
    const one = entityId('task', 'default', 'TASK01');
    const two = entityId('task', 'default', 'TASK02');
    expect(graph.edges.filter(edge => edge.kind === 'blocks' && edge.source === two && edge.target === one)).toHaveLength(1);
    expect(graph.edges.filter(edge => edge.kind === 'contains' && edge.target === one)).toHaveLength(1);
    expect(graph.nodes.find(node => node.id === two)?.details.availableAt).toContain('2030');
  });
  it('retains cross-project stubs without private titles/details', () => {
    const graph = normalize(config, avenFixture(), sources());
    expect(graph.nodes.find(node => node.id === entityId('task', 'default', 'OUTSIDE'))?.boundary).toBe(true);
    expect(JSON.stringify(graph)).not.toContain('PRIVATE');
  });
  it('never treats deleted tasks or missing contexts as completed or relation-complete', () => {
    const aven = avenFixture();
    aven.tasks[1].deleted = true;
    aven.contexts.delete('TASK02');
    const graph = normalize(config, aven, sources());
    expect(graph.nodes.find(node => node.details.taskId === 'TASK01' && node.kind === 'task')?.state).toBe('deleted');
    expect(graph.nodes.find(node => node.details.taskId === 'TASK02' && node.kind === 'task')?.details.relationCoverage).toBe('incomplete');
    expect(graph.nodes.filter(node => node.kind === 'session').every(node => node.state === 'unknown')).toBe(true);
  });
  it('uses API-session identity independently of Herdr session and retains cached-context timestamps', () => {
    const aven = avenFixture();
    aven.contextObservedAt = new Map([['TASK01', '2026-10-19T00:00:00Z']]);
    const topology = sources();
    const first = normalize(config, aven, topology);
    const second = normalize({ ...config, scope: { ...scope, session: 'other-terminal-server' } }, aven, topology);
    expect(first.nodes.filter(node => node.kind === 'session').map(node => node.id)).toEqual(second.nodes.filter(node => node.kind === 'session').map(node => node.id));
    expect(first.edges.find(edge => edge.kind === 'related')?.provenance[0].observedAt).toBe('2026-10-19T00:00:00Z');
  });
  it.each(['single-session', 'subsessions', 'worktrees'])('preserves role/session/resource joins in %s mode', mode => {
    const graph = normalize(config, avenFixture(), sources(mode));
    const agents = graph.nodes.filter(node => node.kind === 'agent');
    expect(agents.map(node => node.details.role)).toEqual(expect.arrayContaining(['worker', 'coordinator', 'babysitter']));
    expect(new Set(agents.map(node => node.id)).size).toBe(agents.length);
    const session = graph.nodes.filter(node => node.details.sessionId === 'ses_root');
    expect(session).toHaveLength(1);
    expect(session[0].state).toBe('unknown');
    expect(graph.nodes.find(node => node.kind === 'terminal' && node.details.address === 't1')?.state).toBe('working');
    expect(graph.edges.filter(edge => edge.kind === 'session' && edge.target === session[0].id)).toHaveLength(1);
    expect(graph.nodes.find(node => node.id === entityId('task', 'default', 'TASK01'))?.state).toBe('todo');
    expect(graph.edges.some(edge => edge.kind === 'worktree' && edge.target === entityId('worktree', '/repo-phase1'))).toBe(true);
    expect(graph.nodes.filter(node => node.kind === 'attempt')).toHaveLength(2);
  });
  it('preserves missing panes/sessions as unresolved resources and strips raw store payloads', () => {
    const graph = normalize(config, avenFixture(), sources());
    expect(graph.nodes.find(node => node.id === entityId('pane', scope.session, 'w0:p1'))?.state).toBe('legacy');
    expect(graph.nodes.some(node => node.kind === 'terminal' && node.details.address === 't2')).toBe(true);
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
  it('coalesces concurrent snapshot requests and caches one inspector call', async () => {
    let calls = 0;
    const source = createSnapshotSource({ ...config, scope: { ...scope, core: false } }, async () => { calls++; return inspectSnapshot(); });
    const [one, two] = await Promise.all([source(), source()]);
    expect(one).toBe(two);
    expect(await source()).toBe(one);
    expect(calls).toBe(1);
    expect(one.health.find(health => health.source === 'core')?.status).toBe('unavailable');
  });
  it('retains the last snapshot explicitly stale during an inspector outage', async () => {
    let fail = false;
    const source = createSnapshotSource({ ...config, scope: { ...scope, core: false } }, async () => {
      if (fail) throw new Error('Offline');
      return inspectSnapshot();
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
