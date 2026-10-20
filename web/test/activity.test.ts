import { describe, expect, it, vi } from 'vitest';
import { Service } from '@opencode/client/service';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { scratchRoot } from './fixtures.js';
import { applyActivity, linkedSessions } from '../server/activity.js';
import { createOpenCodeSource, allowedApiRead } from '../server/sources/opencode.js';
import { expireSnapshot } from '../shared/live.js';
import { elements } from '../src/graph/elements.js';
import { controlledApi, liveFixture } from './fixtures/opencode-api.js';

describe('OpenCode V2 authority and project scope', () => {
  it('queries active/snapshot/pending reads and propagates Working without Aven writes, even pane-less/backgrounded', async () => {
    const fixture = controlledApi();
    let discoveries = 0;
    const api = createOpenCodeSource({ UI_OPENCODE_URL: 'http://fixture.test', UI_OPENCODE_AUTHORIZATION: 'Bearer fixture-secret' }, fixture.transport, async () => { discoveries++; throw new Error('Must not discover explicit server'); });
    const graph = liveFixture();
    expect([...linkedSessions(graph)]).toEqual(['ses_one', 'ses_two']); // terminal-only session excluded
    const initial = await api.read(linkedSessions(graph), new AbortController().signal);
    expect(initial.health.status).toBe('ok');
    expect(initial.readings.get('ses_one')).toMatchObject({ state: 'working', approval: true, input: true, freshness: 'current' });
    expect(initial.readings.get('ses_two')?.state).toBe('idle');
    const active = applyActivity(graph, initial.readings);
    expect(active.nodes.find(node => node.id === 'task:one')).toMatchObject({ state: 'todo', details: { avenStatus: 'todo' }, activity: [{ sessionId: 'ses_one', state: 'working' }, { sessionId: 'ses_two', state: 'idle' }] });
    expect(active.nodes.find(node => node.details.sessionId === 'ses_one')?.details.terminalObservedState).toBe('idle');
    expect(elements(active.nodes, active.edges).find(item => item.data.id === 'task:one')?.data.working).toBe('yes');
    fixture.setActive(['ses_two']);
    const changed = await api.read(linkedSessions(graph), new AbortController().signal);
    expect(changed.readings.get('ses_one')?.state).toBe('idle');
    expect(changed.readings.get('ses_two')?.state).toBe('working');
    expect(discoveries).toBe(0);
    expect(fixture.audit.every(call => allowedApiRead(call.method, call.path) && call.auth === 'Bearer fixture-secret')).toBe(true);
    expect(fixture.audit.some(call => call.path.includes('ses_terminal'))).toBe(false);
    expect(JSON.stringify(active)).not.toMatch(/fixture-secret|private question|private prompt|resources/);
    api.close();
  });
  it('uses discover + server-side Service.headers, never starts a service or fabricates idle for missing/unsupported/outage', async () => {
    const fixture = controlledApi(); fixture.setMissing(['ses_two']);
    const api = createOpenCodeSource({}, fixture.transport, async () => ({ url: 'http://127.0.0.1:4196', auth: { type: 'basic', username: 'opencode', password: 'known-password' } }));
    const result = await api.read(new Set(['ses_one', 'ses_two']), new AbortController().signal);
    expect(result.readings.get('ses_two')?.state).toBe('missing');
    expect(fixture.audit[0].auth).toBe(`Basic ${Buffer.from('opencode:known-password').toString('base64')}`);
    fixture.setOutage(true);
    const outage = await api.read(new Set(['ses_one']), new AbortController().signal);
    expect(outage.health.status).toBe('unavailable'); expect(outage.readings.size).toBe(0);
    expect(JSON.stringify(outage)).not.toContain('known-password');
    api.close();
    const absent = createOpenCodeSource({}, fixture.transport, async () => undefined);
    expect((await absent.read(new Set(['ses_one']), new AbortController().signal)).health.status).toBe('unavailable'); absent.close();
  });
  it('rejects nonlocal discovered endpoints before client authentication and single-flights discovery', async () => {
    const fixture = controlledApi(); let discoveries = 0;
    const unsafe = createOpenCodeSource({}, fixture.transport, async () => ({ url: 'https://outside.test', auth: { type: 'basic', username: 'opencode', password: 'private-password' } }));
    expect((await unsafe.read(new Set(['ses_one']), new AbortController().signal)).health.status).toBe('unavailable');
    expect(fixture.audit).toHaveLength(0); unsafe.close();
    const api = createOpenCodeSource({}, fixture.transport, async () => { discoveries++; await new Promise(resolve => setTimeout(resolve, 5)); return { url: 'http://127.0.0.1:4196', auth: undefined }; });
    const controller = new AbortController();
    const event = api.events(controller.signal)[Symbol.asyncIterator]().next().catch(() => {});
    await api.read(new Set(['ses_one']), controller.signal); await event;
    expect(discoveries).toBe(1); api.close();
  });
  it('preflights the real service registration before Service.discover can send its authenticated health probe', async () => {
    const temp = await mkdtemp(join(scratchRoot, 'opencode-registration-')); const file = join(temp, 'service.json');
    const probe = vi.fn(async () => Response.json({ version: '2.1.1', pid: 42 }));
    vi.stubGlobal('fetch', probe);
    try {
      await writeFile(file, JSON.stringify({ url: 'https://nonlocal.invalid', password: 'fixture-private-password', version: '2.1.1', pid: 42 }), { mode: 0o600 });
      // Demonstrate the real client's probe is observable in this fixture, without network traffic.
      await Service.discover({ file }); expect(probe).toHaveBeenCalledTimes(1); probe.mockClear();
      const api = createOpenCodeSource({ UI_OPENCODE_SERVICE_FILE: file }, controlledApi().transport);
      const result = await api.read(new Set(['ses_one']), new AbortController().signal);
      expect(result.health.status).toBe('unavailable'); expect(probe).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('fixture-private-password'); api.close();
    } finally { vi.unstubAllGlobals(); await rm(temp, { recursive: true, force: true }); }
  });
  it('expires server AND disconnected browser activity into stale/unknown, recovering without changing task status', async () => {
    const fixture = controlledApi(); const api = createOpenCodeSource({ UI_OPENCODE_URL: 'http://fixture.test' }, fixture.transport);
    const readings = (await api.read(linkedSessions(liveFixture()), new AbortController().signal)).readings;
    const active = applyActivity(liveFixture(), readings);
    const after = Date.now() + 5000;
    const stale = applyActivity(liveFixture(), readings, after);
    const browser = expireSnapshot(active, after);
    for (const snapshot of [stale, browser]) {
      expect(snapshot.nodes.flatMap(node => node.activity ?? []).every(item => item.state === 'unknown' && item.freshness === 'stale')).toBe(true);
      expect(snapshot.nodes.find(node => node.kind === 'task')?.state).toBe('todo');
      expect(elements(snapshot.nodes, snapshot.edges).find(item => item.data.id === 'task:one')?.data.working).toBe('no');
    }
    expect(applyActivity(liveFixture(), readings).nodes.find(node => node.kind === 'task')?.activity?.[0].state).toBe('working'); api.close();
  });
  it('retains explicit parent provenance, scoped child activity and separate workflow/role identities', async () => {
    const fixture = controlledApi(); const api = createOpenCodeSource({ UI_OPENCODE_URL: 'http://fixture.test' }, fixture.transport);
    const readings = (await api.read(new Set(['ses_one', 'ses_two']), new AbortController().signal)).readings;
    readings.set('ses_child', { ...readings.get('ses_one')!, sessionId: 'ses_child', parentId: 'ses_one' });
    readings.set('ses_grandchild', { ...readings.get('ses_one')!, sessionId: 'ses_grandchild', parentId: 'ses_child' });
    const snapshot = applyActivity(liveFixture(), readings);
    expect(snapshot.nodes.find(node => node.id === 'agent:worker')?.activity?.map(item => item.sessionId)).toEqual(['ses_one', 'ses_child', 'ses_grandchild']);
    expect(snapshot.nodes.find(node => node.id === 'agent:coordinator')?.details).toMatchObject({ role: 'coordinator', workflow: 'review', generation: 3 });
    expect(snapshot.edges.find(edge => edge.id.includes('api-child'))).toMatchObject({ source: 'session:opencode:ses_one', target: 'session:opencode:ses_child' }); api.close();
  });
  it('rejects every upstream mutation and arbitrary route at the transport boundary', () => {
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) expect(allowedApiRead(method, '/api/session/ses_one')).toBe(false);
    for (const path of ['/api/session/ses_one/prompt', '/api/session/ses_one/view', '/api/session/ses_one/interrupt', '/api/session/ses_one/permission/id/reply', '/api/worktree', '/api/fs/read/etc/passwd', '/api/session', '/api/credential']) expect(allowedApiRead('GET', path)).toBe(false);
    expect(allowedApiRead('GET', '/api/session', '?parentID=ses_one&limit=32')).toBe(true);
    for (const query of ['?limit=500', '?parentID=ses_one&limit=32&search=private', '?parentID=ses_one&limit=32&limit=32']) expect(allowedApiRead('GET', '/api/session', query)).toBe(false);
  });
  it('recovers existing API children only through a bounded parent-filtered query with an explicit matching relation', async () => {
    const fixture = controlledApi(); const queries: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init); const url = new URL(request.url);
      if (url.pathname === '/openapi.json') { const response = await fixture.transport(request); const schema = await response.json(); schema.paths['/api/session'] = { get: { parameters: [{ name: 'parentID', in: 'query' }, { name: 'limit', in: 'query' }] } }; return Response.json(schema); }
      if (url.pathname === '/api/session') { queries.push(url.search); return Response.json({ data: [{ id: 'ses_child', parentID: 'ses_one' }, { id: 'ses_outside', parentID: 'ses_other' }], cursor: {} }); }
      if (url.pathname === '/api/session/ses_child') return Response.json({ data: { id: 'ses_child', parentID: 'ses_one' } });
      return fixture.transport(request);
    };
    const api = createOpenCodeSource({ UI_OPENCODE_URL: 'http://fixture.test' }, transport);
    const result = await api.read(new Set(['ses_one']), new AbortController().signal);
    expect(result.readings.get('ses_child')?.parentId).toBe('ses_one'); expect(result.readings.has('ses_outside')).toBe(false);
    expect(queries).toEqual(['?limit=32&parentID=ses_one']); api.close();
  });
  it('bounds API fan-out to four workers and 64 sessions, and capability-falls back to unknown waiting facets', async () => {
    const fixture = controlledApi(); let active = 0; let max = 0;
    const transport: typeof fetch = async (input, init) => {
      active++; max = Math.max(max, active);
      try { await new Promise(resolve => setTimeout(resolve, 1)); return await fixture.transport(input, init); }
      finally { active--; }
    };
    const api = createOpenCodeSource({ UI_OPENCODE_URL: 'http://fixture.test' }, transport);
    const result = await api.read(new Set(Array.from({ length: 70 }, (_, i) => `ses_${i}`)), new AbortController().signal);
    expect(result.readings.size).toBe(64); expect(result.health.status).toBe('incomplete'); expect(result.health.message).toContain('cap 64'); expect(max).toBe(4); api.close();
    const limited: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/openapi.json') return Response.json({ paths: { '/api/session/active': { get: {} }, '/api/session/{sessionID}': { get: {} } } });
      return fixture.transport(request);
    };
    const unsupported = createOpenCodeSource({ UI_OPENCODE_URL: 'http://fixture.test' }, limited);
    expect((await unsupported.read(new Set(['ses_one']), new AbortController().signal)).readings.get('ses_one')).toMatchObject({ state: 'working', approval: 'unknown', input: 'unknown' });
    await expect(unsupported.events(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('unsupported'); unsupported.close();
  });
});
