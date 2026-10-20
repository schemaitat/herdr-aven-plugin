import type { Entity } from '../shared/graph.js';
import { stateDescription } from './graph/state.js';

export function EntityList({ nodes, selected, onSelect, loading, collapsed, onToggle }: { nodes: Entity[]; selected?: string; onSelect: (id: string) => void; loading: boolean; collapsed: Set<string>; onToggle: (id: string) => void }) {
  return <section className="entities" aria-label="Entities"><div className="section-heading"><h2>Entities</h2><span>{nodes.length} shown</span></div>
    {loading ? <p role="status">Reading local sources…</p> : nodes.length === 0 ? <p className="empty">No entities match. Broaden the filters or check source health.</p> :
      <ul>{nodes.map(node => <li key={node.id}><button type="button" onClick={() => onSelect(node.id)} aria-pressed={node.id === selected} className={node.id === selected ? 'selected entity' : 'entity'}>
        <span className={`entity-mark ${node.kind}`} aria-hidden="true" /><span className="entity-text"><small>{node.kind}{node.boundary && ' · boundary / unresolved'}</small><strong>{node.label}</strong><span className="state">{stateDescription(node)}</span></span><span aria-hidden="true">↗</span>
      </button>{node.kind === 'epic' && <button className="collapse" aria-label={`${collapsed.has(node.id) ? 'Expand' : 'Collapse'} ${node.label}`} aria-expanded={!collapsed.has(node.id)} onClick={() => onToggle(node.id)}>{collapsed.has(node.id) ? 'Expand tasks' : 'Collapse tasks'}</button>}</li>)}</ul>}
  </section>;
}
