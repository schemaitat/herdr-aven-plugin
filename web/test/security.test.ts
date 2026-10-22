import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { devAssetPath, localAddress, secure } from '../server/security.js';
import { routes } from '../server/routes.js';
import { commandVector, createRunner, type ReadCommand } from '../server/commands.js';
import { scope, scratchRoot } from './fixtures.js';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { readDispatcher } from '../server/sources/dispatcher.js';
import { avenFixture } from './fixtures.js';
import { seedDispatcherStore } from './fixtures/dispatcher.js';

const origin = 'http://127.0.0.1:4318';
const token = 'a'.repeat(64);
const headers = { host: '127.0.0.1:4318', authorization: `Bearer ${token}` };
const applications: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });
function server() {
  const app = Fastify();
  applications.push(app);
  secure(app, origin, token);
  routes(app, async () => ({ schema: 'local-explorer/v1', observedAt: '', scope: { project: 'demo', workspace: 'default' }, nodes: [], edges: [], health: [] }));
  return app;
}

describe('loopback same-origin authenticated read API', () => {
  it('limits development serving to browser assets rather than server files or arbitrary filesystem paths', () => {
    for (const url of ['/server/index.ts', '/.env', '/package.json', '/@fs/etc/passwd', '/src/../server/config.ts', '/src/%2e%2e/server/config.ts', '/src/..\\server/config.ts']) expect(devAssetPath(url)).toBe(false);
    for (const url of ['/', '/src/main.tsx', '/@react-refresh', '/@vite/client', '/node_modules/vite/dist/client/env.mjs', '/node_modules/.vite/deps/react.js?v=1']) expect(devAssetPath(url)).toBe(true);
  });
  it.each(['0.0.0.0', 'localhost', '::', '::1', '127.0.0.2', 'evil.test'])('rejects binding %s', host => {
    expect(() => localAddress(host, 4318)).toThrow('127.0.0.1');
  });
  it.each([0, 80, 65536, NaN, 4318.5])('rejects port %s', port => {
    expect(() => localAddress('127.0.0.1', port)).toThrow('port');
  });
  it('allows a same-origin read with the per-run token and disables caching/CORS', async () => {
    const response = await server().inject({ url: '/api/snapshot', headers: { ...headers, origin } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
  it.each(['evil.test', '127.0.0.1.evil.test:4318', '127.0.0.1:9999', 'localhost:4318'])('rejects hostile Host %s', host => {
    return expect(server().inject({ url: '/api/snapshot', headers: { ...headers, host } }).then(response => response.statusCode)).resolves.toBe(403);
  });
  it.each(['https://evil.test', 'null', 'http://127.0.0.1:4319'])('rejects Origin %s on API and bootstrap', async hostile => {
    const app = server();
    for (const url of ['/api/snapshot', '/bootstrap']) expect((await app.inject({ url, headers: { ...headers, origin: hostile } })).statusCode).toBe(403);
  });
  it('rejects cross-site/no-cors bootstrap requests', async () => {
    expect((await server().inject({ url: '/bootstrap', headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
  });
  it.each(['', 'Bearer wrong', `Bearer ${'é'.repeat(64)}`])('rejects missing/invalid API credentials %s', async authorization => {
    expect((await server().inject({ url: '/api/snapshot', headers: { ...headers, authorization } })).statusCode).toBe(401);
  });
  it.each(['/api/snapshot?token=anything', '/api/snapshot?command=rm', '/api/snapshot?path=/etc/passwd', '/api/snapshot?url=http://evil.test', '/bootstrap?token=anything'])('rejects request-controlled parameters %s', async url => {
    expect((await server().inject({ url, headers })).statusCode).toBe(400);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)('rejects %s writes/preflight', async method => {
    expect((await server().inject({ method, url: '/api/snapshot', headers })).statusCode).toBe(405);
  });
  it.each(['/api/reconcile', '/api/command', '/api/files/etc/passwd', '/api/proxy/http://evil.test'])('has no arbitrary command/path/URL surface %s', async url => {
    expect((await server().inject({ url, headers })).statusCode).toBe(404);
  });
  it.each(['/api%2fsnapshot', '/api/%73napshot', '/api//snapshot', '/%61pi/snapshot'])('cannot bypass authentication using encoding %s', async url => {
    expect([401, 404]).toContain((await server().inject({ url, headers: { host: headers.host } })).statusCode);
  });
  it('issues a different API token for each server run', async () => {
    const app = Fastify();
    applications.push(app);
    secure(app, origin);
    const a = (await app.inject({ url: '/bootstrap', headers })).json().token;
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(token);
  });
});

describe('fixed source command vectors', () => {
  it('only admits fixed read shapes with explicit server-owned scope', () => {
    expect(commandVector(scope, { kind: 'projects' })).toEqual(['aven', ['project', 'list', '--workspace', 'default', '--limit', '100', '--json']]);
    expect(commandVector(scope, { kind: 'list', upcoming: true })).toEqual(['aven', ['list', '--project', 'demo', '--workspace', 'default', '--limit', '500', '--json', '--upcoming']]);
    expect(commandVector(scope, { kind: 'context', ref: 'DEMO-ONE' })).toEqual(['aven', ['context', 'DEMO-ONE', '--workspace', 'default', '--json']]);
    expect(commandVector(scope, { kind: 'snapshot' })).toEqual(['herdr', ['api', 'snapshot']]);
    expect(commandVector(scope, { kind: 'worktrees' })).toEqual(['herdr', ['worktree', 'list', '--cwd', '/repo']]);
    expect(() => commandVector(scope, { kind: 'reconcile' } as unknown as ReadCommand)).toThrow('Unsupported');
    expect(() => commandVector({ ...scope, project: '--all' }, { kind: 'list' })).toThrow('startup scope');
    expect(() => commandVector({ ...scope, workspace: 'x; curl evil' }, { kind: 'list' })).toThrow('startup scope');
  });
  it.each(['--help', 'ONE;touch /tmp/pwned', '../secret', 'https://evil.test', 'DEMO-ONE\n--all'])('rejects task injection %s', ref => {
    expect(() => commandVector(scope, { kind: 'context', ref })).toThrow('reference');
  });
  it('audits actual stub executable calls, output/time limits, concurrency and no source writes', async () => {
    const temp = await mkdtemp(join(scratchRoot, 'explorer-commands-'));
    const previousPath = process.env.PATH;
    const previousMode = process.env.EXPLORER_STUB_MODE;
    const previousAudit = process.env.EXPLORER_STUB_AUDIT;
    try {
      const audit = join(temp, 'audit.jsonl');
      const stub = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.EXPLORER_STUB_AUDIT, JSON.stringify({args:process.argv.slice(2),time:Date.now()})+'\\n');
const mode = process.env.EXPLORER_STUB_MODE;
if (mode === 'timeout') setTimeout(()=>console.log('{}'), 10000);
else if (mode === 'large') console.log('x'.repeat(8192));
else if (mode === 'stderr') { process.stderr.write('x'.repeat(8192)); console.log('{}'); }
else if (mode === 'malformed') console.log('not JSON');
else setTimeout(()=>console.log('{}'), 30);
`;
      for (const name of ['aven', 'herdr']) await writeFile(join(temp, name), stub, { mode: 0o755 });
      process.env.PATH = temp;
      process.env.EXPLORER_STUB_AUDIT = audit;
      process.env.EXPLORER_STUB_MODE = 'ok';
      const run = createRunner({ ...scope, cwd: temp }, { bytes: 1024, timeout: 1000, concurrency: 1 });
      await Promise.all([run({ kind: 'list' }), run({ kind: 'context', ref: 'DEMO-ONE' }), run({ kind: 'snapshot' }), run({ kind: 'worktrees' })]);
      const calls = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(calls.map(call => call.args.slice(0, 2))).toEqual([['list', '--project'], ['context', 'DEMO-ONE'], ['api', 'snapshot'], ['worktree', 'list']]);
      for (let i = 1; i < calls.length; i++) expect(calls[i].time - calls[i - 1].time).toBeGreaterThanOrEqual(25);
      expect(JSON.stringify(calls)).not.toMatch(/reconcile|--running|edit|prompt|create|focus/);
      // Separate project runners must not multiply the process-wide four-command budget.
      const runners = Array.from({ length: 4 }, (_, i) => createRunner({ ...scope, cwd: temp, project: `p${i}` }));
      await Promise.all(Array.from({ length: 12 }, (_, i) => runners[i % 4]({ kind: 'list' })));
      const sharedCalls = (await readFile(audit, 'utf8')).trim().split('\n').slice(4).map(line => JSON.parse(line));
      expect(sharedCalls).toHaveLength(12);
      for (let i = 4; i < sharedCalls.length; i++) expect(sharedCalls[i].time - sharedCalls[i - 4].time).toBeGreaterThanOrEqual(25);
      await runners[0]({ kind: 'projects' });
      const discovery = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1);
      expect(discovery.args).toEqual(['project', 'list', '--workspace', 'default', '--limit', '100', '--json']);
      process.env.EXPLORER_STUB_MODE = 'large';
      await expect(run({ kind: 'list' })).rejects.toThrow('output limit');
      process.env.EXPLORER_STUB_MODE = 'stderr';
      await expect(run({ kind: 'list' })).rejects.toThrow('output limit');
      process.env.EXPLORER_STUB_MODE = 'malformed';
      await expect(run({ kind: 'list' })).rejects.toThrow('Malformed');
      process.env.EXPLORER_STUB_MODE = 'timeout';
      await expect(createRunner({ ...scope, cwd: temp }, { bytes: 1024, timeout: 80, concurrency: 1 })({ kind: 'list' })).rejects.toThrow('timeout');
      const controller = new AbortController();
      const cancellable = createRunner({ ...scope, cwd: temp }, { bytes: 1024, timeout: 4000, concurrency: 1 }, controller.signal);
      const running = cancellable({ kind: 'list' });
      const queued = cancellable({ kind: 'list' });
      const settled = Promise.allSettled([running, queued]);
      setTimeout(() => controller.abort(), 30);
      expect((await settled).every(result => result.status === 'rejected')).toBe(true);
      const store = join(temp, 'dispatch.sqlite');
      seedDispatcherStore(store);
      const original = await readFile(store);
      const read = await readDispatcher(store, avenFixture());
      expect(read.attempts).toHaveLength(2);
      expect(await readFile(store)).toEqual(original);
      await expect(access(join(temp, 'state.lock'))).rejects.toThrow();
    } finally {
      process.env.PATH = previousPath;
      if (previousMode === undefined) delete process.env.EXPLORER_STUB_MODE; else process.env.EXPLORER_STUB_MODE = previousMode;
      if (previousAudit === undefined) delete process.env.EXPLORER_STUB_AUDIT; else process.env.EXPLORER_STUB_AUDIT = previousAudit;
      await rm(temp, { recursive: true, force: true });
    }
  });
});
