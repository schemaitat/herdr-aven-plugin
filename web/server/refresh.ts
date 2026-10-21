import type { Activity, GraphSnapshot, TimelineEvent } from '../shared/graph.js';
import { applyActivity, linkedSessions } from './activity.js';
import type { OpenCodeSource } from './sources/opencode.js';
import { EventIdleRenewal } from './sources/opencode.js';
import { retainEvents, summarizeEvent } from './logs.js';
import { randomUUID } from 'node:crypto';

export interface Collector {
  snapshot(): Promise<GraphSnapshot>;
  subscribe(listener: (snapshot: GraphSnapshot, kind?: 'snapshot' | 'heartbeat') => void): () => void;
  close(): Promise<void>;
}
export function createCollector(readGraph: (lane: 'fast' | 'slow') => Promise<GraphSnapshot>, api: OpenCodeSource, expectedScope = { project: 'unknown', workspace: 'unknown' }): Collector {
  const controller = new AbortController();
  const listeners = new Set<(snapshot: GraphSnapshot, kind?: 'snapshot' | 'heartbeat') => void>();
  const readings = new Map<string, Activity>();
  const children = new Map<string, string>();
  let graph: GraphSnapshot = { schema: 'local-explorer/v1', observedAt: new Date().toISOString(), scope: expectedScope, nodes: [], edges: [], health: [{ source: 'aven', status: 'unavailable', observedAt: '', message: 'Initial collection unavailable; retrying automatically' }] };
  let scope = new Set<string>();
  let version = 0;
  const instance = randomUUID();
  let events: TimelineEvent[] = [];
  const pendingEvents = new Map<string, TimelineEvent>();
  let gaps = 0;
  let status = 'connecting';
  let health: GraphSnapshot['health'][number] = { source: 'opencode', status: 'unavailable', observedAt: '', message: 'Connecting' };
  let apiPending: Promise<void> | undefined;
  let lastApi = 0;
  let invalidationPending = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const jobs = new Set<Promise<unknown>>();
  function later(callback: () => void, ms: number) {
    if (controller.signal.aborted) return;
    const timer = setTimeout(() => { timers.delete(timer); if (!controller.signal.aborted) callback(); }, ms);
    timers.add(timer);
  }
  function current() {
    const next = applyActivity(graph, readings);
    const expired = [...readings.values()].some(item => Date.parse(item.expiresAt) <= Date.now());
    return { ...next, version, health: [...next.health, expired ? { ...health, status: 'stale' as const, message: 'Activity expired; current state unknown. Reconnecting automatically.' } : health], events, stream: { status, gaps, instance } };
  }
  function flushEvents() {
    if (!pendingEvents.size) return;
    events = retainEvents(events, [...pendingEvents.values()]); pendingEvents.clear();
  }
  function publish(heartbeat = false) {
    if (!graph || controller.signal.aborted) return;
    if (pendingEvents.size) heartbeat = false;
    flushEvents();
    if (!heartbeat) version++;
    const snapshot = current();
    for (const listener of listeners) { try { listener(snapshot, heartbeat ? 'heartbeat' : 'snapshot'); } catch { listeners.delete(listener); } }
  }
  async function refreshApi() {
    if (!graph || controller.signal.aborted) return;
    if (apiPending) return apiPending;
    lastApi = Date.now();
    apiPending = (async () => {
      const ids = new Set(scope);
      for (const [child, parent] of children) if (ids.has(parent)) ids.add(child); else children.delete(child);
      for (const id of readings.keys()) if (!ids.has(id)) readings.delete(id);
      const result = await api.read(ids, controller.signal);
      health = result.health;
      for (const [id, value] of result.readings) if (!ids.has(id) && value.parentId && ids.has(value.parentId) && children.size < 64) {
        children.set(id, value.parentId); ids.add(id);
      }
      for (const id of ids) {
        const value = result.readings.get(id);
        // Outage retains last observation only until its hard expiry; never invent idle.
        if (value) readings.set(id, { ...value, parentId: children.get(id) ?? value.parentId });
        else if (!readings.has(id)) readings.set(id, { sessionId: id, state: 'unknown', freshness: 'unknown', observedAt: result.health.observedAt, expiresAt: result.health.observedAt, approval: 'unknown', input: 'unknown' });
      }
      publish();
    })().catch(() => { health = { ...health, status: 'unavailable', message: 'API read failed; activity expires to unknown.' }; publish(); }).finally(() => { apiPending = undefined; });
    return apiPending;
  }
  function track(job: Promise<unknown>) { jobs.add(job); void job.finally(() => jobs.delete(job)); }
  function lane(kind: 'fast' | 'slow', ms: number) {
    const run = async () => {
      const start = Date.now();
      try { graph = await readGraph(kind); scope = linkedSessions(graph); publish(); if (kind === 'slow') void refreshApi(); }
      catch { /* Source adapters expose last good health; retry without breaking other lanes. */ }
      later(() => track(run()), Math.max(0, ms - (Date.now() - start)));
    };
    later(() => track(run()), ms);
  }
  const ready = (async () => {
    await Promise.allSettled([readGraph('fast').then(value => { graph = value; scope = linkedSessions(graph); }), readGraph('slow').then(value => { graph = value; scope = linkedSessions(graph); })]);
    await refreshApi();
    lane('fast', 2000); lane('slow', 5000);
    const apiTick = async () => {
      const start = Date.now();
      await refreshApi();
      later(() => track(apiTick()), Math.max(0, 2000 - (Date.now() - start)));
    };
    later(() => track(apiTick()), Math.max(0, 2000 - (Date.now() - lastApi)));
    const heartbeat = () => { publish(true); later(heartbeat, 1000); };
    later(heartbeat, 1000);
    if (!controller.signal.aborted) track(listen());
  })();
  async function listen() {
    let backoff = 500;
    while (!controller.signal.aborted) {
      let idleRenewal = false;
      try {
        status = 'connected (live-only; no replay)'; publish();
        for await (const event of api.events(controller.signal)) {
          if (controller.signal.aborted) break;
          const id = event.data?.sessionID;
          const parent = event.data?.parentID;
          const ids = scope;
          if (typeof id !== 'string') continue;
          if (typeof parent === 'string' && ids.has(parent) && /^ses_[A-Za-z0-9_-]{1,128}$/.test(id) && children.size < 64) children.set(id, parent);
          if (!ids.has(id) && !ids.has(children.get(id) ?? '')) continue;
          const summary = summarizeEvent(event, id, api.secrets);
          if (summary) { pendingEvents.set(summary.id, summary); if (pendingEvents.size >= 1000) flushEvents(); }
          backoff = 500;
          // Event storms never run snapshots in parallel or exceed the polling rate cap.
          if (!invalidationPending && Date.now() - lastApi >= 500) {
            invalidationPending = true;
            later(() => { invalidationPending = false; void refreshApi(); }, 150);
          }
        }
      } catch (error) { idleRenewal = error instanceof EventIdleRenewal; /* Every termination needs a new subscription and snapshot. */ }
      if (controller.signal.aborted) break;
      gaps++; status = idleRenewal ? 'event stream idle renewal; continuity unverified, resubscribing' : 'reconnecting; live event gap'; publish();
      await refreshApi();
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, backoff); controller.signal.addEventListener('abort', done, { once: true });
      });
      backoff = Math.min(backoff * 2, 10000);
    }
  }
  return {
    async snapshot() { await ready; return current(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {
      controller.abort(); api.close();
      for (const timer of timers) clearTimeout(timer);
      timers.clear(); listeners.clear();
      await Promise.allSettled([ready, ...jobs, ...(apiPending ? [apiPending] : [])]);
    },
  };
}
