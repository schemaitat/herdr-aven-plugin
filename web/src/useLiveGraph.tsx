import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphSnapshot } from '../shared/graph.js';
import { expireSnapshot, parseFrame } from '../shared/live.js';

export function useLiveGraph() {
  const [snapshot, setSnapshot] = useState<GraphSnapshot>();
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('Connecting');
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
  useEffect(() => {
    const controller = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let version: number | undefined;
    let instance: string | undefined;
    let resnapshotPending: Promise<void> | undefined;
    let connected = false;
    let stopped = false;
    const later = (callback: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.delete(timer); if (!stopped) callback(); }, ms); timers.add(timer);
    };
    const accept = (next: GraphSnapshot) => {
      if (next.schema !== 'local-explorer/v1') throw new Error('Unsupported snapshot');
      if (instance === next.stream?.instance && version !== undefined && next.version !== undefined && next.version < version) return;
      instance = next.stream?.instance;
      version = next.version;
      setSnapshot(expireSnapshot(next)); setError('');
    };
    const resnapshot = (): Promise<void> => {
      if (resnapshotPending) return resnapshotPending;
      resnapshotPending = (async () => {
        const response = await read('/api/snapshot', AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
        accept(await response.json());
      })().finally(() => { resnapshotPending = undefined; });
      return resnapshotPending;
    };
    const poll = async () => {
      try { if (!connected) await resnapshot(); }
      catch { if (!stopped) setError('Snapshot unavailable. Retrying automatically; API badges expire to unknown.'); }
      finally { if (!stopped) later(() => { void poll(); }, 2000); }
    };
    const stream = async (backoff = 500) => {
      try {
        // Always resnapshot after a connection gap: subscriptions have no replay.
        await resnapshot();
        const response = await read('/api/stream', controller.signal);
        if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Streaming unavailable');
        connected = true; setConnection('Live · versioned snapshots / heartbeat');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastFrame = Date.now();
        const watchdog = setInterval(() => { if (Date.now() - lastFrame > 6000) void reader.cancel(); }, 1000);
        try {
          while (!stopped) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
            if (buffer.length > 4 * 1024 * 1024) throw new Error('Stream bounds');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = parseFrame(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
              if (!frame) continue;
              lastFrame = Date.now(); backoff = 500;
              if (frame.schema === 'live-heartbeat/v1') {
                if (frame.instance !== instance || (version !== undefined && frame.version > version)) await resnapshot();
                else setSnapshot(previous => previous ? expireSnapshot({ ...previous, health: frame.health, stream: frame.stream }) : previous);
                continue;
              }
              if (frame.snapshot.stream?.instance === instance && version !== undefined && frame.version <= version) continue;
              if (frame.snapshot.stream?.instance === instance && version !== undefined && frame.version > version + 1) {
                setConnection('Sequence gap · resynchronizing'); await resnapshot();
              }
              // Frames are complete snapshots, never partially applied deltas.
              if (frame.snapshot.stream?.instance !== instance || version === undefined || frame.version > version) accept(frame.snapshot);
            }
          }
        } finally { clearInterval(watchdog); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch { /* Polling fallback is independent of streaming capability. */ }
      finally {
        connected = false;
        if (!stopped) { setConnection('Reconnecting · live event gap; polling fallback'); later(() => { void stream(Math.min(backoff * 2, 10000)); }, backoff); }
      }
    };
    void stream();
    later(() => { void poll(); }, 2000);
    const expiry = setInterval(() => { setSnapshot(previous => previous ? expireSnapshot(previous) : previous); }, 500);
    return () => { stopped = true; controller.abort(); clearInterval(expiry); for (const timer of timers) clearTimeout(timer); };
  }, [read]);
  return { snapshot, error, connection, read };
}
