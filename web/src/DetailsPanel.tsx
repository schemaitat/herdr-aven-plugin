import type { Entity, GraphSnapshot } from '../shared/graph.js';
import type { GraphEdge } from './graph/elements.js';
import { stateDescription } from './graph/state.js';
import { WindowedList } from './WindowedList.js';

export function DetailsPanel({ entity, edge, relationships, snapshot, onSelect, missing, onFocus, focused, onClear, compact }: {
  onFocus?: (id: string) => void; focused?: boolean; onClear?: () => void;
  entity?: Entity; edge?: GraphEdge; relationships: GraphEdge[]; snapshot?: GraphSnapshot; onSelect: (id: string) => void; missing: boolean; compact?: boolean;
}) {
  const relations = relationships.filter(relation => relation.source === entity?.id || relation.target === entity?.id);
  const name = (id: string) => snapshot?.nodes.find(node => node.id === id)?.label ?? id;
  const provenance = entity?.provenance ?? edge?.provenance ?? [];
  const evidence = (relation: GraphEdge) => <>
    <span>{relation.kind === 'agent-dependency' ? 'Derived from recorded task blocker and assignments' : relation.summary ? 'Collapsed boundary summary; not a new source relationship' : 'Recorded source relationship'}</span>
    {relation.evidence?.map(id => <code key={id}>{id}</code>)}
    <ul className="provenance">{relation.provenance.map((p, index) => <li key={index}>{p.source} · {p.record} · {p.observedAt}</li>)}</ul>
  </>;
  const copy = (id: string) => { void navigator.clipboard?.writeText(id); };
  return <aside id="entity-details" tabIndex={-1} className={`details${compact ? ' compact-details' : ''}`} aria-label="Entity details"><p className="eyebrow">Selected {entity?.kind ?? (edge ? 'relationship' : 'entity')}</p>{entity ? <>
    <div className="details-title"><h2 title={entity.label}>{entity.label}</h2><p className="badge">{entity.kind} · {stateDescription(entity)}</p><div><button onClick={() => onFocus?.(entity.id)}>{focused ? 'Show all' : 'Focus component'}</button>{onClear && <button onClick={onClear}>Clear selection</button>}</div></div>
    <details open={!compact}><summary>Inspect details · {relations.length} relationships</summary><dl><dt>Stable identity</dt><dd><code title={entity.id}>{entity.id}</code> <button onClick={() => copy(entity.id)}>Copy full ID</button></dd>{Object.entries(entity.details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value) || '—'}</dd></div>)}</dl>
    <h3>Relationships <span className="muted">({relations.length})</span></h3>
    <p className="muted">Source relationships include filtered or collapsed neighbors.</p>
    <WindowedList key={entity.id} items={relations} label="relationships" className="relations" identity={relation => relation.id} render={relation => {
      const outgoing = relation.source === entity.id;
      const otherId = outgoing ? relation.target : relation.source;
      return <><span>{relation.kind === 'related' ? '↔ undirected' : outgoing ? '→ outgoing' : '← incoming'} {relation.kind}{relation.kind === 'blocks' ? (outgoing ? ' (blocks this target)' : ' (blocked by this source)') : ''}</span><button onClick={() => onSelect(otherId)}>{name(otherId)}</button>{evidence(relation)}</>;
    }} />{compact && <><h3>Provenance</h3><ul className="provenance">{provenance.map((source, index) => <li key={index}><strong>{source.source}</strong><span>{source.record}</span><time>{source.observedAt}</time></li>)}</ul></>}</details>
  </> : edge ? <>
    <h2>{edge.kind === 'agent-dependency' ? 'Derived agent dependency' : edge.kind}</h2>
    <p>{edge.summary ? 'Collapsed boundary connection' : 'Relationship'} · {edge.kind === 'related' ? 'undirected' : 'source → target'}</p>
    <div className="relations"><button onClick={() => onSelect(edge.source)}>{name(edge.source)}</button><span> → </span><button onClick={() => onSelect(edge.target)}>{name(edge.target)}</button>{evidence(edge)}</div>
  </> : <div className="empty"><h2>{missing ? 'Entity no longer in snapshot' : 'Follow a connection'}</h2><p>{missing ? 'The selection is retained. Its source may have disappeared or moved outside coverage.' : 'Select any entity to inspect its state, directed relationships and source provenance.'}</p><p>Task acceptance, dispatcher persistence, and terminal observations remain separate facts.</p></div>}
    {(entity || edge) && !compact && <><h3>Provenance</h3><ul className="provenance">{provenance.map((source, index) => <li key={index}><strong>{source.source}</strong><span>{source.record}</span><time>{source.observedAt}</time></li>)}</ul></>}
  </aside>;
}
