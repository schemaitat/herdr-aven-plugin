import { z } from 'zod';
import { identifier, PROJECT_LIMIT, type Runner, type Scope } from './commands.js';
import type { ProjectChoice, ProjectListing } from '../shared/projects.js';
import type { Collector } from './refresh.js';
import type { createLogs } from './logs.js';

export class ProjectError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

export interface ProjectSource { collector: Collector; logs: ReturnType<typeof createLogs>; close(): Promise<void> }
export interface ProjectLease extends ProjectSource { success(): void; release(): void }
export type ProjectManager = ReturnType<typeof projectManager>;

// One manager per server. A lease protects initialization, in-flight reads and the entire SSE lifetime.
// Creation/eviction/shutdown are serialized, not a mutable global selection.
export function projectManager(registry: ReturnType<typeof projectRegistry>, create: (project: string) => Promise<ProjectSource> | ProjectSource, options = { limit: 4, idleMs: 60000 }) {
  const sources = new Map<string, { source: ProjectSource; refs: number; used: number }>();
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const result = tail.then(job);
    tail = result.catch(() => {});
    return result;
  }
  async function expire() {
    for (const [key, entry] of sources) if (entry.refs === 0 && Date.now() - entry.used >= options.idleMs) {
      // Do not admit a replacement until all subscriptions/readers/timers have closed.
      await entry.source.close(); sources.delete(key);
    }
  }
  const timer = setInterval(() => { void serial(expire).catch(() => {}); }, Math.min(1000, options.idleMs));
  timer.unref();
  return {
    list: registry.list,
    async acquire(project: string): Promise<ProjectLease> {
      await registry.resolve(project);
      return serial(async () => {
        if (closed) throw new ProjectError('Project sources shutting down; retry shortly', 503);
        await expire();
        let entry = sources.get(project);
        if (!entry) {
          if (sources.size >= options.limit) throw new ProjectError('All four project collectors are busy; close a stream and retry after idle expiry', 503);
          entry = { source: await create(project), refs: 0, used: Date.now() };
          sources.set(project, entry);
        }
        entry.refs++;
        let released = false;
        const held = entry;
        return { ...held.source,
          success() { if (!released) held.used = Date.now(); },
          release() { if (!released) { released = true; held.refs--; } },
        };
      });
    },
    async close() {
      closed = true; clearInterval(timer);
      await serial(async () => { await Promise.allSettled([...sources.values()].map(entry => entry.source.close())); sources.clear(); });
    },
  };
}

// Discovery has no repository/path fields and no browser-supplied command arguments.
export function projectRegistry(scope: Scope, run: Runner) {
  if (!identifier.test(scope.project) || !identifier.test(scope.workspace)) throw new Error('Invalid startup scope');
  const startup = { key: scope.project, name: scope.project };
  let cache: ProjectListing | undefined;
  let time = 0;
  let pending: Promise<ProjectListing> | undefined;
  const schema = z.array(z.object({ key: z.string().max(16384), name: z.string().max(16384) })).max(PROJECT_LIMIT);
  async function list(): Promise<ProjectListing> {
    if (cache && Date.now() - time < 30000) return cache;
    if (pending) return pending;
    pending = (async () => {
      let projects: ProjectChoice[] = [startup];
      let status: ProjectListing['status'] = 'ok';
      let message = 'Projects in the configured workspace only';
      try {
        const rows = schema.parse(await run({ kind: 'projects' }));
        const valid = rows.filter(row => identifier.test(row.key));
        projects = [...new Map([startup, ...valid].map(row => [row.key, { key: row.key, name: row.name }])).values()];
        if (rows.length >= PROJECT_LIMIT || valid.length !== rows.length) {
          status = 'incomplete'; message = 'Discovery incomplete: limit 100; invalid project keys omitted. Startup project remains available.';
        }
      } catch {
        status = 'unavailable'; message = 'Project discovery unavailable. Startup project remains available; retry discovery shortly.';
      }
      return { workspace: scope.workspace, startup: scope.project, projects, status, message };
    })();
    try { cache = await pending; time = Date.now(); return cache; }
    finally { pending = undefined; }
  }
  return {
    list,
    async resolve(key: string) {
      if (!identifier.test(key)) throw new ProjectError('Invalid project key');
      if (key === startup.key) return startup;
      const listing = await list();
      const choice = listing.projects.find(project => project.key === key);
      if (!choice) throw new ProjectError(listing.status === 'unavailable' ? 'Project discovery unavailable; retry shortly' : 'Unknown project', listing.status === 'unavailable' ? 503 : 404);
      return choice;
    },
  };
}
