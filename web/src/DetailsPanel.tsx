import type { Entity, GraphSnapshot } from '../shared/graph.js';

export function DetailsPanel({ entity, snapshot, onSelect, missing }: { entity?: Entity; snapshot?: GraphSnapshot; onSelect: (id: string) => void; missing: boolean }) {
  const relations = snapshot?.edges.filter(edge => edge.source === entity?.id || edge.target === entity?.id) ?? [];
  return <aside className="details" aria-label="Entity details"><p className="eyebrow">INSPECT / DETAILS</p>{entity ? <>
    <h2>{entity.label}</h2><p className="badge">{entity.kind} · {entity.state}</p>
    <dl><dt>Stable identity</dt><dd>{entity.id}</dd>{Object.entries(entity.details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value) || '—'}</dd></div>)}</dl>
    <h3>Relationships <span className="muted">({relations.length})</span></h3>
    <ul className="relations">{relations.map(edge => {
      const outgoing = edge.source === entity.id;
      const otherId = outgoing ? edge.target : edge.source;
      const other = snapshot?.nodes.find(node => node.id === otherId);
      return <li key={edge.id}><span>{outgoing ? '→' : '←'} {edge.kind}{edge.kind === 'blocks' ? (outgoing ? ' (blocks this target)' : ' (blocked by this source)') : ''}</span><button onClick={() => onSelect(otherId)}>{other?.label ?? otherId}</button></li>;
    })}</ul>
    <h3>Provenance</h3><ul className="provenance">{entity.provenance.map((source, index) => <li key={index}><strong>{source.source}</strong><span>{source.record}</span><time>{source.observedAt}</time></li>)}</ul>
  </> : <div className="empty"><h2>{missing ? 'Entity no longer in snapshot' : 'Follow a connection'}</h2><p>{missing ? 'The selection is retained. Its source may have disappeared or moved outside coverage.' : 'Select any entity to inspect its state, directed relationships and source provenance.'}</p><p>Task acceptance, dispatcher persistence, and terminal observations remain separate facts.</p></div>}</aside>;
}
