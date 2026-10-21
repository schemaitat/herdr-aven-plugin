import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { request as httpRequest } from 'node:http';
import { projectManager, projectRegistry, type ProjectManager, type ProjectSource } from '../server/projects.js';
import { routes } from '../server/routes.js';
import { streamRoute } from '../server/stream.js';
import { secure } from '../server/security.js';
import { createGraphReader } from '../server/graph.js';
import { projectConfig } from '../server/config.js';
import { readDispatcher } from '../server/sources/dispatcher.js';
import { createLogs, scopeKey, pageCursor } from '../server/logs.js';
import { createOpenCodeSource } from '../server/sources/opencode.js';
import { config, scope, fixture, avenFixture, scratchRoot } from './fixtures.js';
import { apiEvent, liveFixture } from './fixtures/opencode-api.js';
import type { GraphSnapshot } from '../shared/graph.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const managers: ProjectManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); vi.useRealTimers(); });
const rows = ['demo', 'other', 'three', 'four', 'five'].map(key => ({ key, name: `${key} name`, path: '/never/exposed' }));
const graph = (project: string): GraphSnapshot => ({ ...liveFixture(), scope: { project, workspace: 'default' }, version: 1 });
function factory(project: string): ProjectSource {
  const snapshot = graph(project);
  const api = createOpenCodeSource({});
  api.logs = async function* () { yield { ...apiEvent(1), type: `project.${project}` }; };
  const logs = createLogs(api, async () => ({}), 'default');
  const listeners = new Set<Function>();
  const collector = { snapshot: vi.fn(async () => snapshot), subscribe: vi.fn((listener: Function) => { listeners.add(listener); return () => listeners.delete(listener); }), close: vi.fn(async () => { listeners.clear(); api.close(); }) };
  return { collector, logs, close: vi.fn(async () => { logs.close(); await collector.close(); }) };
}
function manager(create = vi.fn(factory)) {
  const value = projectManager(projectRegistry(scope, async () => rows), create); managers.push(value); return value;
}

describe('bounded project registry', () => {
  it('uses single-flight cached discovery, exposes only key/name and expires after 30 seconds', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => rows); const registry = projectRegistry(scope, run);
    const [a, b] = await Promise.all([registry.list(), registry.list()]);
    expect(a).toBe(b); expect(a.projects).toEqual(rows.map(({ key, name }) => ({ key, name })));
    expect(run).toHaveBeenCalledExactlyOnceWith({ kind: 'projects' });
    expect((await registry.resolve('other')).key).toBe('other');
    await vi.advanceTimersByTimeAsync(30000); await registry.list(); expect(run).toHaveBeenCalledTimes(2);
  });
  it('discloses a 100-row cap, omits malformed identifiers and rejects unsupported schema/oversized lists', async () => {
    const capped = await projectRegistry(scope, async () => Array.from({ length: 100 }, (_, i) => ({ key: `p${i}`, name: `Project ${i}` }))).list();
    expect(capped.status).toBe('incomplete'); expect(capped.message).toContain('limit 100');
    const registry = projectRegistry(scope, async () => [...rows, ...['../x', '--all', 'x/y', 'https://evil', 'x; rm', 'x%2fy', 'x\nother'].map(key => ({ key, name: 'Invalid' }))]);
    expect((await registry.list()).projects).toHaveLength(5);
    expect((await registry.list()).status).toBe('incomplete');
    for (const payload of [{ projects: rows }, [{ key: 'x', name: 4 }], Array(101).fill(rows[0])]) {
      const result = await projectRegistry(scope, async () => payload).list();
      expect(result.status).toBe('unavailable'); expect(result.projects).toEqual([{ key: 'demo', name: 'demo' }]);
    }
  });
  it('keeps trusted startup available during discovery outages without retaining stale authorization for others', async () => {
    vi.useFakeTimers(); let outage = false;
    const registry = projectRegistry(scope, async () => { if (outage) throw new Error('offline'); return rows; });
    await registry.resolve('other'); outage = true; await vi.advanceTimersByTimeAsync(30000);
    expect((await registry.resolve('demo')).key).toBe('demo');
    await expect(registry.resolve('other')).rejects.toMatchObject({ statusCode: 503 });
    await expect(registry.resolve('../x')).rejects.toMatchObject({ statusCode: 400 });
    expect((await registry.list()).projects.map(row => row.key)).toEqual(['demo']);
  });
});

describe('leased project collection', () => {
  it('serializes concurrent creation and holds active leases beyond expiry; failed reads cannot extend idle lifetime', async () => {
    vi.useFakeTimers(); const create = vi.fn(factory); const sources = manager(create);
    const [a, b] = await Promise.all([sources.acquire('demo'), sources.acquire('demo')]);
    expect(a.collector).toBe(b.collector); expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61000); expect(create.mock.results[0].value.close).not.toHaveBeenCalled();
    a.success(); a.release(); b.release();
    await vi.advanceTimersByTimeAsync(59000); expect(create.mock.results[0].value.close).not.toHaveBeenCalled();
    const failed = await sources.acquire('demo'); failed.release();
    await vi.advanceTimersByTimeAsync(1000); expect(create.mock.results[0].value.close).toHaveBeenCalledTimes(1);
    const next = await sources.acquire('demo'); next.release(); expect(create).toHaveBeenCalledTimes(2);
  });
  it('caps all clients at four collectors, returns retryable admission, evicts only idle sources and cleans every resource on shutdown', async () => {
    vi.useFakeTimers(); const create = vi.fn(factory); const sources = manager(create);
    const leases = await Promise.all(['demo', 'other', 'three', 'four'].map(key => sources.acquire(key)));
    await expect(sources.acquire('five')).rejects.toMatchObject({ statusCode: 503 });
    leases[0].release(); await vi.advanceTimersByTimeAsync(60000);
    expect(create.mock.results[0].value.close).toHaveBeenCalledTimes(1);
    const fifth = await sources.acquire('five'); fifth.release();
    await sources.close();
    for (const result of create.mock.results) expect(result.value.close).toHaveBeenCalledTimes(1);
    await expect(sources.acquire('other')).rejects.toMatchObject({ statusCode: 503 });
    leases.slice(1).forEach(lease => lease.release());
  });
  it('waits for in-flight creation on shutdown and closes it exactly once', async () => {
    let release!: (source: ProjectSource) => void;
    const create = vi.fn(() => new Promise<ProjectSource>(resolve => { release = resolve; }));
    const sources = projectManager(projectRegistry(scope, async () => rows), create); managers.push(sources);
    const reading = sources.acquire('demo');
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const closing = sources.close(); const source = factory('demo'); release(source);
    const lease = await reading; lease.release(); await closing;
    expect(source.close).toHaveBeenCalledTimes(1);
  });
  it('non-startup projects never read startup store or topology; recovery requires scoped context ownership', async () => {
    const readStore = vi.fn(async () => { throw new Error('must not read'); });
    const aven = avenFixture();
    aven.contexts.get('ROOT01')!.metadata['dispatch.attempt.implementation'] = JSON.stringify(fixture('dispatcher').attempts['ROOT01:implementation']);
    const recovered = await readDispatcher(undefined, aven, readStore);
    expect(readStore).not.toHaveBeenCalled(); expect(recovered.attempts.length).toBeGreaterThan(0);
    expect(recovered.health.message).toContain('non-startup project');
    const data = fixture('aven'); const calls: string[] = [];
    const read = createGraphReader(await projectConfig(config, 'other'), async command => {
      calls.push(command.kind);
      if (command.kind === 'list') return command.upcoming ? [] : data.tasks.map((task: object) => ({ ...task, project: 'other' }));
      if (command.kind === 'context') return data.contexts.find((context: { task: { display_ref: string } }) => context.task.display_ref === command.ref); // deliberately wrong project
      throw new Error('Unexpected topology read');
    });
    await read('fast'); const snapshot = await read('slow');
    expect(calls.every(kind => ['list', 'context'].includes(kind))).toBe(true);
    expect(snapshot.scope.project).toBe('other'); expect(snapshot.nodes.some(node => node.kind === 'attempt')).toBe(false);
    expect(snapshot.health.find(item => item.source === 'herdr')?.message).toContain('not reused');
  });
  it('reads only the configured selected-project store and links its accepted attempt, agent and session', async () => {
    const root = await mkdtemp(join(scratchRoot, 'explorer-project-store-'));
    try {
      const startup = join(root, 'startup'); const selected = join(root, 'selected');
      await mkdir(startup); await mkdir(join(selected, '.aven-dispatch'), { recursive: true });
      await writeFile(join(selected, '.aven-dispatch/state.json'), JSON.stringify(fixture('dispatcher')));
      const selectedData = fixture('aven');
      selectedData.tasks = selectedData.tasks.map((task: object) => ({ ...task, project: 'other' }));
      selectedData.contexts = selectedData.contexts.map((context: { project: object }) => ({ ...context, project: { key: 'other' } }));
      const runner = async (command: { kind: string; upcoming?: boolean; ref?: string }) => {
        if (command.kind === 'list') return command.upcoming ? [] : selectedData.tasks;
        if (command.kind === 'context') return selectedData.contexts.find((context: { task: { display_ref: string } }) => context.task.display_ref === command.ref);
        throw new Error('Unexpected command');
      };
      const base = { scope: { ...scope, cwd: startup }, primary: startup, storePath: join(startup, '.aven-dispatch/state.json'), projectCheckouts: new Map([['other', selected]]) };
      const read = createGraphReader(await projectConfig(base, 'other'), runner);
      await read('fast'); const selectedGraph = await read('slow');
      const attempt = selectedGraph.nodes.find(node => node.kind === 'attempt');
      expect(attempt?.details.taskId).toBe('ROOT01');
      expect(selectedGraph.nodes.some(node => node.kind === 'agent')).toBe(true);
      expect(selectedGraph.nodes.some(node => node.kind === 'session')).toBe(true);
      expect(selectedGraph.edges.some(edge => edge.kind === 'session')).toBe(true);
      expect(selectedGraph.edges.some(edge => edge.kind === 'assigned' && edge.source.startsWith('task:default:ROOT01'))).toBe(true);

      const isolated = createGraphReader(await projectConfig(base, 'three'), runner);
      await isolated('fast'); expect((await isolated('slow')).nodes.some(node => node.kind === 'attempt')).toBe(false);

      selectedData.contexts[0].metadata['dispatch.reset-generation'] = '1';
      const stale = createGraphReader(await projectConfig(base, 'other'), runner);
      await stale('fast'); expect((await stale('slow')).nodes.some(node => node.kind === 'attempt')).toBe(false);

      await writeFile(join(selected, '.aven-dispatch/state.json'), '{ malformed');
      delete selectedData.contexts[0].metadata['dispatch.reset-generation'];
      const failed = createGraphReader(await projectConfig(base, 'other'), runner);
      await failed('fast'); const failedGraph = await failed('slow');
      expect(failedGraph.health.find(item => item.source === 'dispatcher')).toMatchObject({ status: 'unavailable' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('authenticated project read routes', () => {
  const headers = { host: '127.0.0.1:4318', authorization: 'Bearer token' };
  function server(sources: ProjectManager) {
    const app = Fastify({ routerOptions: { maxParamLength: 2048 } }); secure(app, 'http://127.0.0.1:4318', 'token');
    const projects = { manager: sources, startup: 'demo', workspace: 'default' };
    routes(app, async () => graph('demo'), undefined, projects); streamRoute(app, undefined, projects); return app;
  }
  it('isolates two clients and alias/scoped history with identical entity IDs, authorizing before cached pages', async () => {
    const create = vi.fn(factory); const app = server(manager(create));
    try {
      const key = scopeKey('session:opencode:ses_one');
      const [a, b] = await Promise.all(['demo', 'other'].map(project => app.inject({ url: `/api/projects/${project}/snapshot`, headers })));
      expect(a.json().scope.project).toBe('demo'); expect(b.json().scope.project).toBe('other');
      expect((await app.inject({ url: '/api/snapshot', headers })).json().scope.project).toBe('demo');
      for (const project of ['demo', 'other']) {
        const result = await app.inject({ url: `/api/projects/${project}/logs/${key}/start`, headers });
        expect(result.json().entries[0].text).toBe(`project.${project}`);
      }
      expect((await app.inject({ url: `/api/logs/${key}/start`, headers })).json().entries[0].text).toBe('project.demo');
      const oldCursor = pageCursor('session:opencode:ses_one', 'opencode', '1', graph('demo').scope);
      expect((await app.inject({ url: `/api/projects/other/logs/${key}/${oldCursor}`, headers })).statusCode).toBe(400);
      const other = create.mock.results.find((_, i) => create.mock.calls[i][0] === 'other')!.value;
      vi.mocked(other.collector.snapshot).mockResolvedValue({ ...graph('other'), nodes: [] });
      expect((await app.inject({ url: `/api/projects/other/logs/${key}/start`, headers })).statusCode).toBe(400);
      vi.mocked(other.collector.snapshot).mockResolvedValue({ ...graph('other'), scope: { workspace: 'elsewhere', project: 'other' } });
      expect((await app.inject({ url: '/api/projects/other/snapshot', headers })).statusCode).toBe(503);
      expect((await app.inject({ url: `/api/projects/other/logs/${key}/start`, headers })).statusCode).toBe(503);
      const rejectedStream = await app.inject({ url: '/api/projects/other/stream', headers });
      expect(rejectedStream.statusCode).toBe(503); expect(rejectedStream.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
  it('fails closed for unknown keys, traversal, encoding, arguments, URLs, workspace/query overrides, auth and writes', async () => {
    const create = vi.fn(factory); const app = server(manager(create));
    try {
      for (const url of ['/api/projects', '/api/projects/demo/snapshot', '/api/projects/demo/stream', '/api/projects/demo/logs/a/start']) {
        expect((await app.inject({ url, headers: { host: headers.host } })).statusCode).toBe(401);
        expect((await app.inject({ url, headers: { ...headers, origin: 'https://evil' } })).statusCode).toBe(403);
        expect((await app.inject({ url: `${url}?workspace=other`, headers })).statusCode).toBe(400);
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) expect((await app.inject({ url, headers, method })).statusCode).toBe(405);
      }
      for (const key of ['unknown', '--help', 'a%2fb', 'a%5cb', 'a%3brm', 'http%3a%2f%2fevil', 'a%00', 'a%0aother']) {
        for (const suffix of ['snapshot', 'stream', 'logs/a/start']) expect([400, 404], `${key}/${suffix}`).toContain((await app.inject({ url: `/api/projects/${key}/${suffix}`, headers })).statusCode);
      }
      // URL-based injection clients normalize encoded dot segments before sending. Send a raw
      // HTTP path to assert the actual traversal boundary, not the client's startup-alias rewrite.
      await app.listen({ host: '127.0.0.1', port: 0 });
      for (const key of ['%2e%2e', '..', '%252e%252e']) {
        const status = await new Promise<number>(resolve => {
          const request = httpRequest({ hostname: '127.0.0.1', port: app.addresses()[0].port, path: `/api/projects/${key}/snapshot`, headers }, response => { response.resume(); resolve(response.statusCode!); }); request.end();
        });
        expect([400, 404]).toContain(status);
      }
      expect(create).not.toHaveBeenCalled();
      expect((await app.inject({ url: '/api/projects', headers })).json().projects[0]).toEqual({ key: 'demo', name: 'demo name' });
    } finally { await app.close(); }
  });
  it('shares the 16-stream limit across aliases/projects, holds leases and cleans up on close', async () => {
    const create = vi.fn(factory); const sources = manager(create); const app = server(sources);
    await app.ready();
    const pending = Promise.all(Array.from({ length: 16 }, (_, i) => Promise.resolve(app.inject({ url: i % 2 ? '/api/stream' : '/api/projects/other/stream', headers }))));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect((await app.inject({ url: '/api/projects/three/stream', headers })).statusCode).toBe(503);
    await app.close(); const responses = await pending;
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect(responses[0].body).toContain('"project":"other"'); expect(responses[1].body).toContain('"project":"demo"');
    await sources.close(); for (const result of create.mock.results) expect(result.value.close).toHaveBeenCalledTimes(1);
  });
});
