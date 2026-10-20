import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createLogs, pageCursor, retainEvents, safeText, scopeKey, summarizeEvent } from '../server/logs.js';
import { createOpenCodeSource, type OpenCodeSource } from '../server/sources/opencode.js';
import { routes } from '../server/routes.js';
import { secure } from '../server/security.js';
import { apiEvent, controlledApi, liveFixture } from './fixtures/opencode-api.js';

function logApi(entries: unknown[]) {
  const control = controlledApi(); let cancelled = 0;
  const cursors: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init); const url = new URL(request.url);
    if (url.pathname.endsWith('/log')) {
      cursors.push(url.search);
      const after = Number(url.searchParams.get('after') ?? -1);
      let stopped = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const entry of entries) {
            const seq = (entry as { durable?: { seq: number } }).durable?.seq;
            if (seq !== undefined && seq > after) controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(entry)}\n\n`));
          }
          controller.close(); stopped = true;
        }, cancel() { if (!stopped) cancelled++; },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return control.transport(request);
  };
  const api = createOpenCodeSource({ UI_OPENCODE_URL: 'http://fixture.test', UI_OPENCODE_AUTHORIZATION: 'Bearer fixture-secret' }, transport);
  return { api, cursors, cancelled: () => cancelled };
}
describe('bounded scoped log reads', () => {
  it('lazily pages generated-client durable log streams with source cursors, omissions and deterministic dedupe', async () => {
    const { api, cursors } = logApi(Array.from({ length: 205 }, (_, i) => apiEvent(i + 1)));
    const logs = createLogs(api, async () => { throw new Error('No Aven read expected'); }, 'default');
    expect(cursors).toHaveLength(0);
    const key = scopeKey('session:opencode:ses_one');
    const first = await logs.page(liveFixture(), key);
    expect(first.entries).toHaveLength(100); expect(first.next).toBeDefined(); expect(first.entries[0]).toMatchObject({ cursor: '1', durable: true, source: 'opencode', sessionId: 'ses_one', text: 'session.execution.started' });
    const repeated = await logs.page(liveFixture(), key); expect(repeated).toBe(first); expect(cursors).toHaveLength(1);
    const second = await logs.page(liveFixture(), key, first.next);
    expect(second.entries[0].cursor).toBe('101'); expect(second.entries).toHaveLength(100);
    expect(cursors[1]).toContain('after=100'); expect(cursors[1]).toContain('follow=false');
    const last = await logs.page(liveFixture(), key, second.next); expect(last.entries).toHaveLength(5); expect(last.next).toBeUndefined();
    expect(JSON.stringify([first, second, last])).not.toMatch(/private prompt|fixture-secret/);
    logs.close(); api.close();
  });
  it('reports out-of-order/sequence gaps instead of inventing complete history and exposes unsupported history', async () => {
    const { api } = logApi([apiEvent(1), apiEvent(1), apiEvent(4), apiEvent(2), apiEvent(5)]);
    const logs = createLogs(api, async () => ({}), 'default');
    const page = await logs.page(liveFixture(), scopeKey('session:opencode:ses_one'));
    expect(page.entries.map(item => item.cursor)).toEqual(['1', '4', '5']); expect(page.gap).toBe(true);
    logs.close(); api.close();
    const unavailable = { ...api, async *logs() { throw new Error('secret service failure'); } } satisfies OpenCodeSource;
    const missing = createLogs(unavailable, async () => ({}), 'default');
    const result = await missing.page(liveFixture(), scopeKey('session:opencode:ses_one'));
    expect(result.message).toContain('History unavailable'); expect(result.gap).toBe(true); expect(JSON.stringify(result)).not.toContain('secret service failure'); missing.close();
  });
  it('resumes after an inspection cap even when omitted/unsupported events fill the window, and accepts encoded sequence strings', async () => {
    const { api } = logApi([]);
    api.logs = async function* (_id, after) {
      for (let seq = (after ?? 0) + 1; seq <= 2005; seq++) yield { ...apiEvent(seq), type: 'unsupported payload', durable: { aggregateID: 'ses_one', seq: String(seq) } };
    };
    const logs = createLogs(api, async () => ({}), 'default'); const key = scopeKey('session:opencode:ses_one');
    const first = await logs.page(liveFixture(), key); expect(first.entries).toHaveLength(0); expect(first.next).toBeDefined(); expect(first.gap).toBe(true);
    const last = await logs.page(liveFixture(), key, first.next); expect(last.entries).toHaveLength(0); expect(last.next).toBeUndefined();
    expect(summarizeEvent({ ...apiEvent(1), durable: { aggregateID: 'ses_one', seq: '1' } }, 'ses_one', [])?.cursor).toBe('1');
    logs.close(); api.close();
    const unsupported = createLogs({ ...api, async *logs() { for (let i = 0; i < 2001; i++) yield { type: 'no-sequence' }; } }, async () => ({}), 'default');
    const noSequence = await unsupported.page(liveFixture(), key); expect(noSequence.next).toBeUndefined(); expect(noSequence.gap).toBe(true); expect(noSequence.message).toContain('without a durable sequence'); unsupported.close();
  });
  it('pages linked dispatcher notes only after verifying attempt/workspace/related task; rejects unlinked scopes/cursor injection', async () => {
    const { api } = logApi([]); let reads = 0;
    const notes = Array.from({ length: 105 }, (_, i) => ({ id: `N${String(i).padStart(4, '0')}`, created_at: new Date(1000 + i).toISOString(), body: JSON.stringify({ schema: 'aven-dispatch-event/v1', attempt_id: 'attempt-a', event: 'phase-completed', state: 'needs-review', detail: 'private prompt and secret body' }) }));
    const logs = createLogs(api, async command => {
      reads++; expect(command).toEqual({ kind: 'context', ref: 'DL-ONE' });
      return { workspace: { key: 'default' }, metadata: { 'dispatch.attempt-id': 'attempt-a' }, related: [{ task_id: 'TASK1' }], notes: [{ id: 'OTHER', created_at: '', body: 'untrusted non-event note' }, ...notes] };
    }, 'default');
    const key = scopeKey('attempt:one');
    const first = await logs.page(liveFixture(), key); expect(first.entries).toHaveLength(100); expect(first.gap).toBe(true); expect(first.message).toContain('older history may be unavailable');
    const second = await logs.page(liveFixture(), key, first.next); expect(second.entries).toHaveLength(5); expect(second.entries[0].cursor).toContain('N0100');
    expect(reads).toBe(2); expect(JSON.stringify(first)).not.toContain('private prompt');
    await expect(logs.page(liveFixture(), scopeKey('not-in-project'))).rejects.toThrow('Unknown scope');
    await expect(logs.page(liveFixture(), scopeKey('session:opencode:ses_one'), first.next)).rejects.toThrow('mismatch');
    await expect(logs.page(liveFixture(), key, pageCursor('attempt:one', 'opencode', '0'))).rejects.toThrow('mismatch');
    expect((await logs.page(liveFixture(), scopeKey('session:opencode:ses_terminal'))).message).toContain('History unavailable');
    logs.close(); api.close();
  });
  it('bounds shared lazy-reader concurrency, shares requests and cancels log streams at shutdown', async () => {
    const { api } = logApi([]); let requests = 0; let aborted = 0;
    api.logs = async function* (_id, _after, signal) {
      requests++;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted++; resolve(); }, { once: true }));
    };
    const logs = createLogs(api, async () => ({}), 'default');
    const first = logs.page(liveFixture(), scopeKey('session:opencode:ses_one'));
    const shared = logs.page(liveFixture(), scopeKey('session:opencode:ses_one'));
    const other = logs.page(liveFixture(), scopeKey('session:opencode:ses_two'));
    const busy = await logs.page(liveFixture(), scopeKey('session:opencode:ses_one'), pageCursor('session:opencode:ses_one', 'opencode', '1'));
    expect(requests).toBe(2); expect(busy.message).toContain('busy');
    logs.close(); await Promise.all([first, shared, other]); expect(aborted).toBe(2); api.close();
  });
  it('redacts known credentials/authorization, strips terminal control, caps text, and bounds ordered live retention', () => {
    const text = safeText('\x1b[31msecret\x1b[0m\x1b]0;hostile title\x07\x00 Bearer abc.def <script>alert(1)</script> sk-abcdefghijkl ghp_abcdef', ['secret']);
    expect(text).not.toMatch(/secret|abc.def|sk-abcdefghijkl|ghp_abcdef|\x1b|\x00|hostile title/);
    expect(text).toContain('<script>alert(1)</script>'); // React renders literal text, never HTML.
    expect(safeText('a'.repeat(10000))).toHaveLength(2048);
    const items = Array.from({ length: 1100 }, (_, i) => summarizeEvent(apiEvent(i), 'ses_one', [])!);
    const retained = retainEvents([], [...items.slice().reverse(), ...items]);
    expect(retained).toHaveLength(1000); expect(retained[0].id).toBe('opencode:ses_one:event-100');
    expect(retainEvents(retained, retained)).toEqual(retained);
    expect(summarizeEvent(apiEvent(1, 'ses_other'), 'ses_one', [])).toBeUndefined();
    expect(summarizeEvent({ ...apiEvent(1), type: '<img>' }, 'ses_one', [])).toBeUndefined();
  });
  it('authenticates/validates all local history routes and never accepts request-controlled paths or credentials', async () => {
    const { api } = logApi([]); const logs = createLogs(api, async () => ({}), 'default');
    const app = Fastify({ routerOptions: { maxParamLength: 2048 } }); secure(app, 'http://127.0.0.1:4318', 'fixture-token'); routes(app, async () => liveFixture(), logs);
    const url = `/api/logs/${scopeKey('session:opencode:ses_one')}/start`;
    const headers = { host: '127.0.0.1:4318', authorization: 'Bearer fixture-token' };
    expect((await app.inject({ url, headers: { host: headers.host } })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { ...headers, origin: 'https://evil.test' } })).statusCode).toBe(403);
    expect((await app.inject({ url, method: 'POST', headers })).statusCode).toBe(405);
    expect((await app.inject({ url: `${url}?token=fixture-token`, headers })).statusCode).toBe(400);
    const allowed = await app.inject({ url, headers }); expect(allowed.statusCode).toBe(200); expect(allowed.body).not.toContain('fixture-secret');
    expect((await app.inject({ url: `/api/logs/${scopeKey('/etc/passwd')}/start`, headers })).statusCode).toBe(400);
    logs.close(); api.close(); await app.close();
  });
});
