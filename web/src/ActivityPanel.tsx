import type { Entity, GraphSnapshot } from '../shared/graph.js';

export function ActivityPanel({ entity, snapshot }: { entity?: Entity; snapshot?: GraphSnapshot }) {
  const ids = new Set(entity?.activity?.map(item => item.sessionId));
  const events = (snapshot?.events ?? []).filter(event => ids.has(event.sessionId ?? '')).slice(-1000);
  return <section className="activity-panel" aria-label="Live activity"><h2>Live activity</h2>
    <p className="muted">API activity is authoritative for linked execution, not task acceptance. Terminal observations remain separate. Live events have no replay.</p>
    {snapshot?.stream && <p role="status">Upstream: {snapshot.stream.status} · {snapshot.stream.gaps} reconnect gaps</p>}
    {entity?.activity?.map(item => <div key={item.sessionId} className="activity-reading"><strong>{item.state === 'working' ? 'Working' : item.state} · {item.freshness}</strong><code>{item.sessionId}</code>
      <p>Approval: {String(item.approval)} · Input: {String(item.input)}{item.parentId && ` · explicit API parent ${item.parentId}`}</p><small>API observed {item.observedAt} · expires {item.expiresAt}</small></div>)}
    {entity?.details.terminalObservedState !== undefined && <p>Herdr terminal observation: {String(entity.details.terminalObservedState)} (may disagree with API)</p>}
    {!entity?.activity?.length && <p>Select a linked task, agent or session to inspect activity. Missing coverage is unknown, never idle/done.</p>}
    <p>{events.length} selected live summaries retained (maximum 1,000; not durable history). Payload content omitted.</p>
    <ol className="event-log">{events.map(event => <li key={event.id}><time>{event.observedAt}</time> <code>{event.sessionId}</code> {event.text}</li>)}</ol>
  </section>;
}
