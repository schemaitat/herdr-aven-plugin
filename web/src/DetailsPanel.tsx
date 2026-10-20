import type { Entity, GraphSnapshot } from '../shared/graph.js';
import type { GraphEdge } from './graph/elements.js';
import { stateDescription } from './graph/state.js';

export function DetailsPanel({ entity, edge, relationships, snapshot, onSelect, missing }: {
  entity?: Entity; edge?: GraphEdge; relationships: GraphEdge[]; snapshot?: GraphSnapshot; onSelect: (id: string) => void; missing: boolean;
}) {
  const relations = relationships.filter(relation => relation.source === entity?.id || relation.target === entity?.id);
  const name = (id: string) => snapshot?.nodes.find(node => node.id === id)?.label ?? id;
  const provenance = entity?.provenance ?? edge?.provenance ?? [];
  const evidence = (relation: GraphEdge) => <>
    <span>{relation.kind === 'agent-dependency' ? 'Derived from recorded task blocker and assignments' : relation.summary ? 'Collapsed boundary summary; not a new source relationship' : 'Recorded source relationship'}</span>
    {relation.evidence?.map(id => <code key={id}>{id}</code>)}
    <ul className="provenance">{relation.provenance.map((p, index) => <li key={index}>{p.source} · {p.record} · {p.observedAt}</li>)}</ul>
  </>;
  return <aside className="details" aria-label="Entity details"><p className="eyebrow">INSPECT / DETAILS</p>{entity ? <>
    <h2>{entity.label}</h2><p className="badge">{entity.kind} · {stateDescription(entity)}</p>
    <dl><dt>Stable identity</dt><dd>{entity.id}</dd>{Object.entries(entity.details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value) || '—'}</dd></div>)}</dl>
    <h3>Relationships <span className="muted">({relations.length})</span></h3>
    <p className="muted">Source relationships include filtered or collapsed neighbors.</p>
    <ul className="relations">{relations.map(relation => {
      const outgoing = relation.source === entity.id;
      const otherId = outgoing ? relation.target : relation.source;
      return <li key={relation.id}><span>{relation.kind === 'related' ? '↔ undirected' : outgoing ? '→ outgoing' : '← incoming'} {relation.kind}{relation.kind === 'blocks' ? (outgoing ? ' (blocks this target)' : ' (blocked by this source)') : ''}</span><button onClick={() => onSelect(otherId)}>{name(otherId)}</button>{evidence(relation)}</li>;
    })}</ul>
  </> : edge ? <>
    <h2>{edge.kind === 'agent-dependency' ? 'Derived agent dependency' : edge.kind}</h2>
    <p>{edge.summary ? 'Collapsed boundary connection' : 'Relationship'} · {edge.kind === 'related' ? 'undirected' : 'source → target'}</p>
    <div className="relations"><button onClick={() => onSelect(edge.source)}>{name(edge.source)}</button><span> → </span><button onClick={() => onSelect(edge.target)}>{name(edge.target)}</button>{evidence(edge)}</div>
  </> : <div className="empty"><h2>{missing ? 'Entity no longer in snapshot' : 'Follow a connection'}</h2><p>{missing ? 'The selection is retained. Its source may have disappeared or moved outside coverage.' : 'Select any entity to inspect its state, directed relationships and source provenance.'}</p><p>Task acceptance, dispatcher persistence, and terminal observations remain separate facts.</p></div>}
    {(entity || edge) && <><h3>Provenance</h3><ul className="provenance">{provenance.map((source, index) => <li key={index}><strong>{source.source}</strong><span>{source.record}</span><time>{source.observedAt}</time></li>)}</ul></>}
  </aside>;
}
