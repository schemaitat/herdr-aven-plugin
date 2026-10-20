import type { Entity } from '../shared/graph.js';

export function EntityList({ nodes, selected, onSelect, loading }: { nodes: Entity[]; selected?: string; onSelect: (id: string) => void; loading: boolean }) {
  return <section className="entities" aria-label="Entities"><div className="section-heading"><h2>Entities</h2><span>{nodes.length} shown</span></div>
    {loading ? <p role="status">Reading local sources…</p> : nodes.length === 0 ? <p className="empty">No entities match. Broaden the filters or check source health.</p> :
      <ul>{nodes.map(node => <li key={node.id}><button type="button" onClick={() => onSelect(node.id)} aria-pressed={node.id === selected} className={node.id === selected ? 'selected entity' : 'entity'}>
        <span className={`entity-mark ${node.kind}`} aria-hidden="true" /><span className="entity-text"><small>{node.kind}{node.boundary && ' · boundary / unresolved'}</small><strong>{node.label}</strong><span className="state">{node.state}</span></span><span aria-hidden="true">↗</span>
      </button></li>)}</ul>}
  </section>;
}
