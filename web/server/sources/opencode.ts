import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { z } from 'zod';
import type { Activity, SourceHealth } from '../../shared/graph.js';
import { ACTIVITY_TTL } from '../activity.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { boundedJsonFile } from './dispatcher.js';

const sessionID = /^ses_[A-Za-z0-9_-]{1,128}$/;
const activeSchema = z.record(z.string(), z.object({ type: z.literal('running') }));
const infoSchema = z.object({ id: z.string().regex(sessionID), parentID: z.string().regex(sessionID).optional() });
export interface ApiRead { readings: Map<string, Activity>; health: SourceHealth }
export class EventIdleRenewal extends Error {}
export type ApiEvent = { id?: string; type: string; created?: number; data?: Record<string, unknown>; durable?: { aggregateID: string; seq: number } };
export interface OpenCodeSource {
  read(ids: Set<string>, signal: AbortSignal): Promise<ApiRead>;
  events(signal: AbortSignal): AsyncIterable<ApiEvent>;
  logs(id: string, after: number | undefined, signal: AbortSignal): AsyncIterable<unknown>;
  secrets: string[];
  close(): void;
}

// Enforce the read boundary even if a future generated client changes behavior.
export function allowedApiRead(method: string, path: string, search = '') {
  if (method === 'GET' && path === '/api/session') {
    const params = new URLSearchParams(search);
    return sessionID.test(params.get('parentID') ?? '') && params.get('limit') === '32' && [...params.keys()].length === 2;
  }
  return method === 'GET' && (['/openapi.json', '/api/session/active', '/api/event'].includes(path) ||
    /^\/api\/session\/ses_[A-Za-z0-9_-]{1,128}(\/(permission|form))?$/.test(path) ||
    /^\/api\/experimental\/session\/ses_[A-Za-z0-9_-]{1,128}\/log$/.test(path));
}

function localOrigin(value: string) {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
}
export async function discoverLocal(env = process.env) {
  // Service.discover authenticates its health probe. Validate the documented, trusted
  // registration BEFORE that probe, not only the endpoint returned afterwards.
  const file = env.UI_OPENCODE_SERVICE_FILE ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'opencode', 'service.json');
  const info = z.object({ url: z.string().max(2048) }).parse(await boundedJsonFile(file, 65536));
  if (!localOrigin(info.url)) throw new Error('Invalid local service registration');
  return Service.discover({ file });
}

export function createOpenCodeSource(env = process.env, transport: typeof fetch = fetch, discover = () => discoverLocal(env)): OpenCodeSource {
  const lifetime = new AbortController();
  const secrets = [env.UI_OPENCODE_AUTHORIZATION, env.OPENCODE_SERVER_PASSWORD, env.OPENCODE_TOKEN].filter((value): value is string => Boolean(value));
  const remember = (secret: string) => { if (secret && !secrets.includes(secret)) { secrets.push(secret); if (secrets.length > 32) secrets.shift(); } };
  let endpoint: { url: string; headers: Record<string, string> } | undefined;
  let client: ReturnType<typeof OpenCode.make> | undefined;
  let capabilities: Set<string> | undefined;
  let capTime = 0;
  let idleRenewals = 0;
  const boundedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!endpoint || url.origin !== new URL(endpoint.url).origin || !allowedApiRead(request.method, url.pathname, url.search)) throw new Error('Non-allowlisted API read');
    const event = url.pathname === '/api/event';
    const cancellation = new AbortController();
    const signal = AbortSignal.any([request.signal, lifetime.signal, cancellation.signal, ...(!event ? [AbortSignal.timeout(1800)] : [])]);
    const headersDeadline = setTimeout(() => cancellation.abort(), 1800);
    let response: Response;
    try { response = await transport(request, { redirect: 'error', signal }); }
    finally { clearTimeout(headersDeadline); }
    if (!response.body) return response;
    // Bound total response bytes. Event idle watchdog resets on every chunk, including SSE comments.
    const reader = response.body.getReader();
    let idle: ReturnType<typeof setTimeout> | undefined;
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (event) idle = setTimeout(() => {
          idleRenewals++; cancellation.abort(); controller.error(new EventIdleRenewal()); void reader.cancel().catch(() => {});
        }, 30000);
        try {
          const next = await reader.read();
          clearTimeout(idle);
          if (next.done) { controller.close(); return; }
          bytes += next.value.byteLength;
          if (bytes > 4 * 1024 * 1024) throw new Error('API output limit');
          controller.enqueue(next.value);
        } catch (error) { clearTimeout(idle); controller.error(error); cancellation.abort(); await reader.cancel().catch(() => {}); }
      },
      async cancel() { clearTimeout(idle); cancellation.abort(); await reader.cancel().catch(() => {}); },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  async function connectOnce(signal: AbortSignal) {
    if (!endpoint) {
      const explicit = env.UI_OPENCODE_URL ?? env.OPENCODE_SERVER_URL;
      if (explicit) {
        const url = new URL(explicit);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid configured server');
        const authorization = env.UI_OPENCODE_AUTHORIZATION ?? (env.OPENCODE_TOKEN ? `Bearer ${env.OPENCODE_TOKEN}` : env.OPENCODE_SERVER_PASSWORD ? `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME ?? 'opencode'}:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` : undefined);
        endpoint = { url: url.origin, headers: authorization ? { authorization } : {} };
      } else {
        const found = await discover(); // Never ensure/start/stop; no fallback from explicit server.
        if (!found) throw new Error('No existing healthy service');
        if (!localOrigin(found.url)) throw new Error('Invalid discovered local endpoint');
        endpoint = { url: found.url, headers: Service.headers(found) ?? {} };
        if (found.auth) remember(found.auth.password);
      }
      for (const header of Object.values(endpoint.headers)) remember(header);
      client = OpenCode.make({ baseUrl: endpoint.url, headers: endpoint.headers, fetch: boundedFetch });
    }
    if (!capabilities || Date.now() - capTime > 60000) {
      const response = await boundedFetch(`${endpoint.url}/openapi.json`, { headers: endpoint.headers, signal });
      if (!response.ok) throw new Error('API capability discovery unavailable');
      const schema = z.object({ paths: z.record(z.string(), z.object({ get: z.unknown().optional() })) }).parse(await response.json());
      capabilities = new Set(Object.entries(schema.paths).filter(([, value]) => value.get !== undefined).map(([path]) => path));
      const list = z.object({ parameters: z.array(z.object({ name: z.string(), in: z.string() })).default([]) }).safeParse(schema.paths['/api/session']?.get);
      if (list.success && ['parentID', 'limit'].every(name => list.data.parameters.some(parameter => parameter.name === name && parameter.in === 'query'))) capabilities.add('parent-filtered-children');
      capTime = Date.now();
    }
    return client!;
  }
  let connecting: Promise<ReturnType<typeof OpenCode.make>> | undefined;
  function connect(_signal: AbortSignal) {
    // Shared discovery belongs to the source lifetime, not the first browser/log caller.
    if (!connecting) connecting = connectOnce(AbortSignal.any([lifetime.signal, AbortSignal.timeout(1800)])).finally(() => { connecting = undefined; });
    return connecting;
  }
  const support = (path: string) => capabilities?.has(path);
  return {
    secrets,
    async read(ids, signal) {
      signal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(1900)]);
      const observedAt = new Date().toISOString();
      const health: SourceHealth = { source: 'opencode', status: 'ok', observedAt, message: 'API activity authority; polling fallback. Waiting facets are separate.' };
      const readings = new Map<string, Activity>();
      try {
        const api = await connect(signal);
        if (!support('/api/session/active') || !support('/api/session/{sessionID}')) throw new Error('Activity API unsupported');
        const active = activeSchema.parse(await api.session.active({ signal }));
        const list = [...ids].filter(id => sessionID.test(id)).slice(0, 64);
        const parents = new Map<string, string>();
        if (list.length < ids.size) { health.status = 'incomplete'; health.message += ' Session cap 64; remaining activity unknown.'; }
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
          while (next < list.length && !signal.aborted) {
            const id = list[next++];
            const reading: Activity = { sessionId: id, state: 'unknown', freshness: 'unknown', observedAt, expiresAt: new Date(Date.parse(observedAt) + ACTIVITY_TTL).toISOString(), approval: 'unknown', input: 'unknown' };
            try {
              const info = infoSchema.parse(await api.session.get({ sessionID: id }, { signal }));
              if (info.id !== id) throw new Error('Session mismatch');
              reading.state = active[id]?.type === 'running' ? 'working' : 'idle';
              reading.freshness = 'current';
              reading.parentId = info.parentID;
              // A parent-filtered read recovers pre-existing children after a live-event gap.
              // Never list all sessions or infer parenthood from pane/name proximity.
              if (ids.has(id) && support('parent-filtered-children')) {
                try {
                  const children = z.object({ data: z.array(infoSchema).max(32), cursor: z.object({ next: z.string().nullish() }).optional() }).parse(await api.session.list({ parentID: id, limit: 32 }, { signal }));
                  for (const child of children.data) if (child.parentID === id && !list.includes(child.id)) {
                    if (list.length < 64) { parents.set(child.id, id); list.push(child.id); }
                    else { health.status = 'incomplete'; health.message += ' Session cap 64 reached including children.'; }
                  }
                  if (children.data.length === 32 || children.cursor?.next) { health.status = 'incomplete'; if (!health.message.includes('Child-session coverage capped')) health.message += ' Child-session coverage capped; only the observed window is shown.'; }
                } catch { health.status = 'incomplete'; health.message += ' Child-session coverage unavailable.'; }
              }
              // Sequential per worker bounds all API request concurrency at four.
              if (support('/api/session/{sessionID}/permission')) {
                try { reading.approval = z.array(z.object({ sessionID: z.literal(id) })).max(1000).parse(await api.permission.list({ sessionID: id }, { signal })).length > 0; } catch { /* unknown waiting facet */ }
              }
              if (support('/api/session/{sessionID}/form')) {
                try { reading.input = z.array(z.object({ sessionID: z.literal(id) })).max(1000).parse(await api.session.form.list({ sessionID: id }, { signal })).length > 0; } catch { /* unknown waiting facet */ }
              }
            } catch (error) {
              if (error && typeof error === 'object' && '_tag' in error && error._tag === 'SessionNotFoundError') { reading.state = 'missing'; reading.freshness = 'current'; }
              else { health.status = 'incomplete'; health.message = 'Some session snapshots unavailable; activity unknown, never inferred idle.'; }
            }
            if (parents.has(id)) reading.parentId = parents.get(id);
            readings.set(id, reading);
          }
        }));
        if (next < list.length) { health.status = 'incomplete'; health.message += ' Collection time budget reached; remaining sessions unknown.'; }
      } catch {
        health.status = 'unavailable'; health.message = 'OpenCode unavailable or activity API unsupported; no service started. API activity unknown.';
        // Local service may have restarted with a different endpoint/auth. Explicit config remains authoritative.
        endpoint = undefined; capabilities = undefined;
      }
      return { readings, health };
    },
    async *events(signal) {
      const api = await connect(signal);
      if (!support('/api/event')) throw new Error('Live events unsupported');
      const before = idleRenewals;
      try { yield* api.event.subscribe({ signal }); }
      catch (error) { if (idleRenewals > before) throw new EventIdleRenewal(); throw error; }
    },
    async *logs(id, after, signal) {
      if (!sessionID.test(id)) throw new Error('Invalid session');
      const api = await connect(signal);
      if (!support('/api/experimental/session/{sessionID}/log')) throw new Error('Durable logs unsupported');
      yield* api.session.log({ sessionID: id, after, follow: false }, { signal });
    },
    close() { lifetime.abort(); },
  };
}
