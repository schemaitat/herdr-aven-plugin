import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphSnapshot } from '../shared/graph.js';
import { expireSnapshot, parseFrame } from '../shared/live.js';
import type { ProjectListing } from '../shared/projects.js';

export function useLiveGraph() {
  const [snapshot, setSnapshot] = useState<GraphSnapshot>();
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('Connecting');
  const [listing, setListing] = useState<ProjectListing>();
  const [project, setProject] = useState<string>();
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const [discoveryError, setDiscoveryError] = useState('');
  const generation = useRef(0);
  const discoveryScope = useRef<{ workspace: string; startup: string }>(undefined);
  const token = useRef('');
  const read = useCallback(async (path: string, signal: AbortSignal) => {
    if (!token.current) {
      const response = await fetch('/bootstrap', { signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Cannot authenticate local explorer');
      token.current = (await response.json()).token;
    }
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token.current}` }, signal, cache: 'no-store' });
    if (response.status === 401) token.current = '';
    if (!response.ok) throw new Error('Local read unavailable. Retrying automatically.');
    return response;
  }, []);
  const discover = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await read('/api/projects', AbortSignal.any([signal, AbortSignal.timeout(10000)]));
      const next: ProjectListing = await response.json();
      if (signal.aborted) return;
      if (!next.workspace || !next.startup || !Array.isArray(next.projects)) throw new Error('Unsupported discovery');
      if (discoveryScope.current && (discoveryScope.current.workspace !== next.workspace || discoveryScope.current.startup !== next.startup)) throw new Error('Discovery scope changed');
      discoveryScope.current = { workspace: next.workspace, startup: next.startup };
      setListing(next);
      setProject(previous => previous ?? next.startup);
      setDiscoveryError(next.status === 'ok' ? '' : next.message);
    } catch {
      if (signal.aborted) return;
      setDiscoveryError('Project discovery unavailable. Current project retained; retry discovery.');
      // If discovery itself cannot be reached on first load, the authenticated startup alias
      // still establishes the server-owned default. Never infer workspace/project from a URL.
      if (!discoveryScope.current) try {
        const response = await read('/api/snapshot', AbortSignal.any([signal, AbortSignal.timeout(10000)]));
        const initial: GraphSnapshot = await response.json();
        if (signal.aborted || discoveryScope.current || initial.schema !== 'local-explorer/v1' || !initial.scope?.project || !initial.scope.workspace) return;
        const fallback = { workspace: initial.scope.workspace, startup: initial.scope.project };
        discoveryScope.current = fallback;
        setListing({ ...fallback, projects: [{ key: fallback.startup, name: fallback.startup }], status: 'unavailable', message: 'Discovery unavailable; startup project only' });
        setProject(fallback.startup);
      } catch { /* Retry discovery stays available even when startup is temporarily offline. */ }
    }
  }, [read]);
  useEffect(() => {
    const controller = new AbortController();
    void discover(controller.signal);
    return () => controller.abort();
  }, [discover]);
  const workspace = listing?.workspace;
  const startup = listing?.startup;
  useEffect(() => {
    if (!project || !workspace) return;
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let version: number | undefined;
    let instance: string | undefined;
    let resnapshotPending: Promise<void> | undefined;
    let connected = false;
    let stopped = false;
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let streamWatchdog: ReturnType<typeof setInterval> | undefined;
    const current = () => !stopped && generation.current === requestGeneration;
    const scoped = (scope: GraphSnapshot['scope'] | undefined) => scope?.workspace === workspace && scope.project === project;
    const base = project === startup ? '/api' : `/api/projects/${encodeURIComponent(project)}`;
    setConnection(`Loading ${workspace} / ${project}`);
    const later = (callback: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.delete(timer); if (!stopped) callback(); }, ms); timers.add(timer);
    };
    const accept = (next: GraphSnapshot) => {
      if (!current()) return;
      if (next.schema !== 'local-explorer/v1' || !scoped(next.scope)) throw new Error('Unsupported snapshot scope');
      if (instance === next.stream?.instance && version !== undefined && next.version !== undefined && next.version < version) return;
      instance = next.stream?.instance;
      version = next.version;
      setSnapshot(expireSnapshot(next)); setError('');
    };
    const resnapshot = (): Promise<void> => {
      if (resnapshotPending) return resnapshotPending;
      resnapshotPending = (async () => {
        const response = await read(`${base}/snapshot`, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
        accept(await response.json());
      })().finally(() => { resnapshotPending = undefined; });
      return resnapshotPending;
    };
    const poll = async () => {
      try { if (!connected) await resnapshot(); }
      catch { if (current()) setError(`Snapshot unavailable for ${workspace} / ${project}. Retrying automatically; API badges expire to unknown.`); }
      finally { if (!stopped) later(() => { void poll(); }, 2000); }
    };
    const stream = async (backoff = 500) => {
      try {
        // Always resnapshot after a connection gap: subscriptions have no replay.
        await resnapshot();
        if (!current()) return;
        const response = await read(`${base}/stream`, controller.signal);
        if (!current()) { await response.body?.cancel(); return; }
        if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Streaming unavailable');
        connected = true; setConnection('Live · versioned snapshots / heartbeat');
        const reader = response.body.getReader();
        streamReader = reader;
        const decoder = new TextDecoder();
        let buffer = '';
        let lastFrame = Date.now();
        const watchdog = setInterval(() => { if (Date.now() - lastFrame > 6000) void reader.cancel(); }, 1000);
        streamWatchdog = watchdog;
        try {
          while (current()) {
            const chunk = await reader.read();
            if (!current()) break;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
            if (buffer.length > 4 * 1024 * 1024) throw new Error('Stream bounds');
            let end: number;
            while (current() && (end = buffer.indexOf('\n\n')) >= 0) {
              const frame = parseFrame(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
              if (!frame) continue;
              lastFrame = Date.now(); backoff = 500;
              if (frame.schema === 'live-heartbeat/v1') {
                if (!scoped(frame.scope)) throw new Error('Heartbeat scope mismatch');
                if (frame.instance !== instance || (version !== undefined && frame.version > version)) await resnapshot();
                else if (current()) setSnapshot(previous => previous && scoped(previous.scope) ? expireSnapshot({ ...previous, health: frame.health, stream: frame.stream }) : previous);
                continue;
              }
              if (!scoped(frame.snapshot.scope)) throw new Error('Stream scope mismatch');
              if (frame.snapshot.stream?.instance === instance && version !== undefined && frame.version <= version) continue;
              if (frame.snapshot.stream?.instance === instance && version !== undefined && frame.version > version + 1) {
                setConnection('Sequence gap · resynchronizing'); await resnapshot();
                if (!current()) return;
              }
              // Frames are complete snapshots, never partially applied deltas.
              if (frame.snapshot.stream?.instance !== instance || version === undefined || frame.version > version) accept(frame.snapshot);
            }
          }
        } finally { clearInterval(watchdog); await reader.cancel().catch(() => {}); reader.releaseLock(); streamReader = undefined; streamWatchdog = undefined; }
      } catch { /* Polling fallback is independent of streaming capability. */ }
      finally {
        connected = false;
        if (current()) { setConnection('Reconnecting · live event gap; polling fallback'); later(() => { void stream(Math.min(backoff * 2, 10000)); }, backoff); }
      }
    };
    void stream();
    later(() => { void poll(); }, 2000);
    const expiry = setInterval(() => { if (current()) setSnapshot(previous => previous && scoped(previous.scope) ? expireSnapshot(previous) : previous); }, 500);
    return () => { stopped = true; controller.abort(); clearInterval(expiry); clearInterval(streamWatchdog); void streamReader?.cancel().catch(() => {}); for (const timer of timers) clearTimeout(timer); };
  }, [read, project, workspace, startup]);
  const selectProject = (key: string) => {
    if (key === project || !listing?.projects.some(choice => choice.key === key)) return;
    generation.current++;
    setSelectionEpoch(previous => previous + 1);
    setSnapshot(undefined); setError(''); setConnection(`Loading ${listing.workspace} / ${key}`); setProject(key);
  };
  const discoveryRequest = useRef<AbortController>(undefined);
  useEffect(() => () => discoveryRequest.current?.abort(), []);
  const retryDiscovery = () => { discoveryRequest.current?.abort(); discoveryRequest.current = new AbortController(); void discover(discoveryRequest.current.signal); };
  return { snapshot: snapshot && snapshot.scope.project === project && snapshot.scope.workspace === workspace ? snapshot : undefined, error, connection, read, listing, project, selectProject, discoveryError, retryDiscovery, selectionEpoch };
}
