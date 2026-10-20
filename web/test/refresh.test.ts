import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { request as httpRequest } from 'node:http';
import { createCollector, type Collector } from '../server/refresh.js';
import { createOpenCodeSource, type OpenCodeSource, type ApiEvent } from '../server/sources/opencode.js';
import { createGraphReader } from '../server/graph.js';
import { streamRoute } from '../server/stream.js';
import { routes } from '../server/routes.js';
import { secure } from '../server/security.js';
import { config, fixture } from './fixtures.js';
import { controlledApi, liveFixture, apiEvent } from './fixtures/opencode-api.js';

const collectors: Collector[] = [];
afterEach(async () => { await Promise.all(collectors.splice(0).map(collector => collector.close())); vi.useRealTimers(); });
const hangingEvents = async function* (signal: AbortSignal): AsyncGenerator<ApiEvent> {
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
};
function source() {
  const control = controlledApi();
  const api = createOpenCodeSource({ UI_OPENCODE_URL: 'http://fixture.test' }, control.transport);
  api.events = hangingEvents;
  return { control, api };
}
describe('shared bounded live collector', () => {
  it('recovers failed initialization without unhandled rejection or stopping retry lanes', async () => {
    vi.useFakeTimers();
    const { api } = source(); let failed = true;
    const collector = createCollector(async () => { if (failed) throw new Error('initial failure'); return liveFixture(); }, api); collectors.push(collector);
    const initial = await collector.snapshot(); expect(initial.nodes).toHaveLength(0); expect(initial.health.some(item => item.status === 'unavailable')).toBe(true);
    failed = false; await vi.advanceTimersByTimeAsync(5100);
    expect((await collector.snapshot()).nodes.some(node => node.id === 'task:one')).toBe(true);
  });
  it('shares collection across browsers, keeps independent 2s/5s lanes, expires outage and recovers', async () => {
    vi.useFakeTimers();
    const { api, control } = source();
    const readGraph = vi.fn(async (_lane: 'fast' | 'slow') => liveFixture());
    const collector = createCollector(readGraph, api); collectors.push(collector);
    const [first, second] = await Promise.all([collector.snapshot(), collector.snapshot()]);
    expect(first.version).toBe(second.version); expect(readGraph).toHaveBeenCalledTimes(2);
    const one = vi.fn(); const two = vi.fn(); const unsubscribe = collector.subscribe(one); collector.subscribe(two);
    control.setActive(['ses_two']);
    await vi.advanceTimersByTimeAsync(2100);
    expect((await collector.snapshot()).nodes.find(node => node.details.sessionId === 'ses_two')?.activity?.[0].state).toBe('working');
    expect(control.audit.filter(call => call.path === '/api/session/active')).toHaveLength(2);
    expect(readGraph.mock.calls.map(call => call[0])).toEqual(['fast', 'slow', 'fast']);
    unsubscribe(); const count = one.mock.calls.length;
    control.setOutage(true);
    await vi.advanceTimersByTimeAsync(7000);
    const stale = await collector.snapshot();
    expect(stale.nodes.find(node => node.details.sessionId === 'ses_two')?.activity?.[0]).toMatchObject({ state: 'unknown', freshness: 'stale' });
    expect(stale.nodes.find(node => node.kind === 'task')?.state).toBe('todo');
    expect(one).toHaveBeenCalledTimes(count); expect(two.mock.calls.length).toBeGreaterThan(count);
    control.setOutage(false); control.setActive(['ses_one']);
    await vi.advanceTimersByTimeAsync(2100);
    expect((await collector.snapshot()).nodes.find(node => node.details.sessionId === 'ses_one')?.activity?.[0].state).toBe('working');
    await collector.close();
    const reads = control.audit.length; await vi.advanceTimersByTimeAsync(10000); expect(control.audit.length).toBe(reads);
  });
  it('serializes slow source reads without overlapping or blocking API freshness', async () => {
    vi.useFakeTimers();
    const { api, control } = source();
    let calls = 0; let inFlight = 0; let maximum = 0;
    const collector = createCollector(async lane => {
      if (calls++ >= 2 && lane === 'fast') {
        inFlight++; maximum = Math.max(maximum, inFlight);
        await new Promise(resolve => setTimeout(resolve, 4000)); inFlight--;
      }
      return liveFixture();
    }, api); collectors.push(collector);
    await collector.snapshot(); control.setActive(['ses_two']);
    await vi.advanceTimersByTimeAsync(4100);
    expect((await collector.snapshot()).nodes.find(node => node.details.sessionId === 'ses_two')?.activity?.[0].state).toBe('working');
    expect(maximum).toBe(1);
    const closing = collector.close(); await vi.advanceTimersByTimeAsync(5000); await closing;
  });
  it('schedules the first API fallback from collection start rather than adding a second delay after slow initialization', async () => {
    vi.useFakeTimers(); const { api } = source();
    const original = api.read; const starts: number[] = []; const start = Date.now();
    api.read = async (...args) => { starts.push(Date.now() - start); await new Promise(resolve => setTimeout(resolve, 1500)); return original(...args); };
    const collector = createCollector(async () => liveFixture(), api); collectors.push(collector);
    const ready = collector.snapshot(); await vi.advanceTimersByTimeAsync(1500); await ready;
    await vi.advanceTimersByTimeAsync(2000); expect(starts).toEqual([0, 2000]);
    await collector.close();
  });
  it('explicitly resubscribes after termination, resnapshots, scopes children, dedupes/orders and bounds events', async () => {
    vi.useFakeTimers();
    const { api } = source(); let subscriptions = 0;
    const read = vi.spyOn(api, 'read');
    api.events = async function* (signal) {
      subscriptions++;
      if (subscriptions === 1) {
        yield { ...apiEvent(1, 'ses_unrelated'), data: { sessionID: 'ses_unrelated', text: 'do not retain' } };
        yield { ...apiEvent(2, 'ses_child'), data: { sessionID: 'ses_child', parentID: 'ses_one' } };
        for (let i = 1100; i >= 1; i--) { yield apiEvent(i); yield apiEvent(i); }
        throw new Error('simulated disconnect');
      }
      yield* hangingEvents(signal);
    };
    const collector = createCollector(async () => liveFixture(), api); collectors.push(collector);
    await collector.snapshot(); await vi.advanceTimersByTimeAsync(1);
    const snapshot = await collector.snapshot();
    expect(snapshot.events).toHaveLength(1000);
    expect(new Set(snapshot.events!.map(event => event.id)).size).toBe(1000);
    expect(snapshot.events?.some(event => event.sessionId === 'ses_unrelated')).toBe(false);
    expect(snapshot.events?.[0].id).toBe('opencode:ses_one:event-101');
    expect(snapshot.stream?.gaps).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(subscriptions).toBe(2); expect(read.mock.calls.some(([ids]) => ids.has('ses_child'))).toBe(true);
    expect(JSON.stringify(await collector.snapshot())).not.toContain('private prompt');
  });
  it('consumes the real generated V2 event iterator, reopens it on EOF and cancels the upstream stream', async () => {
    vi.useFakeTimers();
    const control = controlledApi(); let subscriptions = 0; let cancelled = 0;
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== '/api/event') return control.transport(request);
      subscriptions++;
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        if (subscriptions === 1) { controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(apiEvent(1))}\n\n`)); controller.close(); }
        else request.signal.addEventListener('abort', () => { cancelled++; controller.error(new Error('cancelled')); }, { once: true });
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const api = createOpenCodeSource({ UI_OPENCODE_URL: 'http://fixture.test' }, transport);
    const collector = createCollector(async () => liveFixture(), api); collectors.push(collector);
    await collector.snapshot(); await vi.advanceTimersByTimeAsync(600);
    const snapshot = await collector.snapshot(); expect(subscriptions).toBe(2); expect(snapshot.stream?.gaps).toBe(1); expect(snapshot.events?.[0].text).toBe('session.execution.started');
    await collector.close(); expect(cancelled).toBe(1);
  });
  it('renews an upstream event body that stalls, explicitly marking idle continuity uncertainty while polling stays healthy', async () => {
    vi.useFakeTimers();
    const control = controlledApi(); let subscriptions = 0;
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== '/api/event') return control.transport(request);
      subscriptions++;
      return new Response(new ReadableStream<Uint8Array>(), { headers: { 'content-type': 'text/event-stream' } });
    };
    const api = createOpenCodeSource({ UI_OPENCODE_URL: 'http://fixture.test' }, transport);
    const collector = createCollector(async () => liveFixture(), api); collectors.push(collector);
    await collector.snapshot(); await vi.advanceTimersByTimeAsync(30001);
    const snapshot = await collector.snapshot(); expect(snapshot.stream?.status).toContain('idle renewal'); expect(snapshot.stream?.gaps).toBe(1);
    expect(snapshot.health.find(health => health.source === 'opencode')?.status).toBe('ok');
    expect(snapshot.nodes.find(node => node.id === 'task:one')?.activity?.[0].state).toBe('working');
    await vi.advanceTimersByTimeAsync(600); expect(subscriptions).toBe(2);
  });
  it('authenticates stream reads, sends versioned health/heartbeat, and cancels connections on shutdown', async () => {
    const { api } = source();
    const collector = createCollector(async () => liveFixture(), api); collectors.push(collector);
    const app = Fastify();
    secure(app, 'http://127.0.0.1:4318', 'fixture-token');
    routes(app, () => collector.snapshot()); streamRoute(app, collector);
    expect((await app.inject({ url: '/api/stream', headers: { host: '127.0.0.1:4318' } })).statusCode).toBe(401);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.addresses()[0];
    // Security's expected Host remains fixed, even when the test listener uses an ephemeral port.
    try {
      const { headers, first, heartbeat } = await new Promise<{ headers: Record<string, unknown>; first: string; heartbeat: string }>((resolve, reject) => {
        const request = httpRequest(`http://127.0.0.1:${address.port}/api/stream`, { headers: { host: '127.0.0.1:4318', authorization: 'Bearer fixture-token' } }, response => {
          let first = '';
          response.on('data', chunk => {
            if (!first) first = String(chunk);
            else if (String(chunk).includes('live-heartbeat/v1')) resolve({ headers: response.headers, first, heartbeat: String(chunk) });
          });
        });
        request.on('error', reject); request.end();
      });
      expect(headers['content-type']).toBe('text/event-stream');
      expect(first).toContain('event: snapshot'); expect(first).toContain('live-graph/v1'); expect(first).toContain('"version":'); expect(first).toContain('"health":');
      expect(heartbeat).not.toContain('"nodes":'); expect(heartbeat).toContain('"health":');
    } finally { await app.close(); }
  });
  it('reserves stream slots before awaiting initialization, enforces 16 clients and releases them on close', async () => {
    let initialize!: (value: ReturnType<typeof liveFixture>) => void;
    const ready = new Promise<ReturnType<typeof liveFixture>>(resolve => { initialize = resolve; });
    const collector: Collector = { snapshot: () => ready, subscribe: () => () => {}, close: async () => {} };
    const app = Fastify(); secure(app, 'http://127.0.0.1:4318', 'fixture-token'); streamRoute(app, collector);
    const headers = { host: '127.0.0.1:4318', authorization: 'Bearer fixture-token' };
    await app.ready();
    const requests = Array.from({ length: 16 }, () => app.inject({ url: '/api/stream', headers }));
    // Start all injections, not just construct their lazy thenables.
    const results = Promise.all(requests.map(request => Promise.resolve(request)));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await app.inject({ url: '/api/stream', headers })).statusCode).toBe(503);
    initialize(liveFixture()); await new Promise(resolve => setTimeout(resolve, 10));
    await app.close(); await results;
  });
  it('ends raw replies on failed initialization or thrown writes instead of leaving zombie SSE connections', async () => {
    for (const mode of ['initialize', 'write']) {
      const collector: Collector = { snapshot: async () => { if (mode === 'initialize') throw new Error('failed'); return liveFixture(); }, subscribe: () => () => {}, close: async () => {} };
      const app = Fastify(); secure(app, 'http://127.0.0.1:4318', 'fixture-token');
      if (mode === 'write') app.addHook('onRequest', async (_request, reply) => { reply.raw.write = () => { throw new Error('closed transport'); }; });
      streamRoute(app, collector);
      const response = await app.inject({ url: '/api/stream', headers: { host: '127.0.0.1:4318', authorization: 'Bearer fixture-token' } });
      expect(response.statusCode).toBe(mode === 'initialize' ? 503 : 200); await app.close();
    }
  });
  it('uses the existing read-only CLI lanes, caching contexts and retaining Aven graph during outages', async () => {
    const data = fixture('aven'); const calls: string[] = []; let unavailable = false;
    const readGraph = createGraphReader({ ...config, scope: { ...config.scope, herdr: false } }, async command => {
      calls.push(command.kind);
      if (unavailable) throw new Error('fixture outage');
      if (command.kind === 'list') return command.upcoming ? [] : data.tasks;
      if (command.kind === 'context') return data.contexts.find((context: { task: { display_ref: string } }) => context.task.display_ref === command.ref);
      throw new Error('Unexpected CLI read');
    });
    const initial = await readGraph('slow');
    const hydration = calls.filter(call => call === 'context').length;
    const latest = await readGraph('slow'); expect(calls.filter(call => call === 'context')).toHaveLength(hydration);
    unavailable = true;
    const outage = await readGraph('slow');
    expect(outage.nodes.filter(node => node.kind === 'task' || node.kind === 'epic')).toEqual(latest.nodes.filter(node => node.kind === 'task' || node.kind === 'epic'));
    expect(initial.nodes.length).toBeGreaterThan(0);
    expect(outage.health.find(item => item.source === 'aven')?.status).toBe('stale');
    expect(calls.every(call => ['list', 'context'].includes(call))).toBe(true);
  });
});
