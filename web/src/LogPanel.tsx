import { useEffect, useRef, useState } from 'react';
import type { Entity, LogPage, TimelineEvent } from '../shared/graph.js';

export function LogPanel({ entity, read }: { entity?: Entity; read: (path: string, signal: AbortSignal) => Promise<Response> }) {
  const [entries, setEntries] = useState<TimelineEvent[]>([]);
  const [message, setMessage] = useState('History is loaded only on request. Select a linked session or attempt.');
  const [cursor, setCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController>(undefined);
  useEffect(() => {
    controller.current?.abort(); setEntries([]); setCursor(undefined); setBusy(false); setMessage('History is loaded only on request. Select a linked session or attempt.');
    return () => controller.current?.abort();
  }, [entity?.id]);
  async function load() {
    if (!entity || busy) return;
    const request = new AbortController(); controller.current = request; setBusy(true);
    try {
      const bytes = new TextEncoder().encode(entity.id);
      const scope = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const response = await read(`/api/logs/${scope}/${cursor ?? 'start'}`, request.signal);
      const page: LogPage = await response.json();
      if (request.signal.aborted) return;
      setEntries(previous => [...new Map([...previous, ...page.entries].map(item => [item.id, item])).values()].slice(-1000));
      setCursor(page.next); setMessage(`${page.gap ? 'History gap / incomplete coverage. ' : ''}${page.message}`);
    } catch { if (!request.signal.aborted) setMessage('History unavailable. Retry; live events are not durable history.'); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }
  return <section className="log-panel" aria-label="Event history"><h2>Event history</h2><p role="status">{message}</p>
    <button disabled={!entity || busy} onClick={() => { void load(); }}>{busy ? 'Reading history…' : cursor ? 'Load next page' : 'Load / refresh history'}</button>
    <p className="muted">Plain-text summaries · 100 per page · at most 1,000 retained for this selection. Select an attempt for linked dispatcher-note fallback.</p>
    <ol className="event-log">{entries.map(item => <li key={item.id}><time>{item.observedAt}</time> · {item.source} · <code>{item.sessionId ?? item.attemptId}</code> · cursor {item.cursor ?? 'unavailable'} · {item.text}</li>)}</ol>
  </section>;
}
