import type { Entity, GraphSnapshot, Relationship } from '../../shared/graph.js';
import type { ApiEvent } from '../../server/sources/opencode.js';

export const provenance = [{ source: 'dispatcher' as const, record: 'demo/implementation/2/attempt-a', observedAt: '2026-10-20T00:00:00Z' }];
const entity = (id: string, kind: Entity['kind'], details: Entity['details'] = {}): Entity => ({ id, kind, label: id, state: kind === 'task' ? 'todo' : 'unknown', details, provenance });
const edge = (kind: Relationship['kind'], source: string, target: string): Relationship => ({ id: JSON.stringify([kind, source, target]), kind, source, target, provenance });
export function liveFixture(): GraphSnapshot {
  return { schema: 'local-explorer/v1', observedAt: new Date().toISOString(), scope: { project: 'demo', workspace: 'default' }, nodes: [
    entity('task:one', 'task', { avenStatus: 'todo' }), entity('agent:worker', 'agent', { role: 'worker', workflow: 'implementation', generation: 2 }),
    entity('agent:coordinator', 'agent', { role: 'coordinator', workflow: 'review', generation: 3 }),
    entity('session:opencode:ses_one', 'session', { sessionId: 'ses_one', service: 'opencode', terminalObservedState: 'idle' }),
    entity('session:opencode:ses_two', 'session', { sessionId: 'ses_two', service: 'opencode' }),
    entity('session:opencode:ses_terminal', 'session', { sessionId: 'ses_terminal', service: 'opencode', terminalObservedState: 'working' }),
    entity('attempt:one', 'attempt', { taskId: 'TASK1', attemptId: 'attempt-a', workflow: 'implementation', generation: 2, logRef: 'DL-ONE' }),
  ], edges: [edge('assigned', 'task:one', 'agent:worker'), edge('assigned', 'task:one', 'agent:coordinator'),
    edge('session', 'agent:worker', 'session:opencode:ses_one'), edge('session', 'agent:coordinator', 'session:opencode:ses_two')],
  health: [{ source: 'aven', status: 'ok', observedAt: new Date().toISOString(), message: 'Fixture: task status never changes' }] };
}
export function apiEvent(seq: number, sessionID = 'ses_one'): ApiEvent {
  return { id: `event-${seq}`, type: 'session.execution.started', created: Date.parse('2026-10-20T00:00:00Z') + seq, data: { sessionID, text: 'private prompt must never leave the server' }, durable: { aggregateID: sessionID, seq } };
}
export function controlledApi() {
  let active: Record<string, { type: 'running' }> = { ses_one: { type: 'running' } };
  let missing = new Set<string>();
  let outage = false;
  let supportsEvents = true;
  const audit: { method: string; path: string; auth: string | null }[] = [];
  const paths = ['/api/session/active', '/api/session/{sessionID}', '/api/session/{sessionID}/permission', '/api/session/{sessionID}/form', '/api/event', '/api/experimental/session/{sessionID}/log'];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    audit.push({ method: request.method, path, auth: request.headers.get('authorization') });
    if (outage) throw new Error('fixture disconnect (secret must not leak)');
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/openapi.json') return json({ paths: Object.fromEntries(paths.filter(path => path !== '/api/event' || supportsEvents).map(path => [path, { get: {} }])) });
    if (path === '/api/session/active') return json({ data: active });
    const id = path.split('/')[3];
    if (missing.has(id)) return json({ _tag: 'SessionNotFoundError', sessionID: id }, 404);
    if (path.endsWith('/permission')) return json({ data: id === 'ses_one' ? [{ sessionID: id, id: 'permission-1', action: 'private', resources: ['secret'] }] : [] });
    if (path.endsWith('/form')) return json({ data: id === 'ses_one' ? [{ sessionID: id, id: 'form-1', title: 'private question', fields: [] }] : [] });
    return json({ data: { id } });
  };
  return { transport, audit, setActive(ids: string[]) { active = Object.fromEntries(ids.map(id => [id, { type: 'running' }])); }, setMissing(ids: string[]) { missing = new Set(ids); }, setOutage(value: boolean) { outage = value; }, noEvents() { supportsEvents = false; } };
}
