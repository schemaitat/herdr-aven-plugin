import type { Entity } from '../shared/graph.js';
import type { Filters } from './graph/state.js';

export function Toolbar({ nodes, filters, onChange, onCommand, mounted, onMount, onSearch }: {
  nodes: Entity[]; filters: Filters; onChange: (filters: Filters) => void;
  onCommand: (kind: 'fit' | 'reset' | 'in' | 'out') => void; mounted: boolean; onMount: () => void;
  onSearch: () => void;
}) {
  return <section aria-label="Graph and entity controls">
    <div className="toolbar" aria-label="Entity filters">
      <button onClick={onSearch}>Search /</button>
      <label>Search entities<input type="search" maxLength={256} value={filters.query} onChange={event => onChange({ ...filters, query: event.target.value })} placeholder="Task, session, pane, branch…" /></label>
      <label>Entity type<select value={filters.kind} onChange={event => onChange({ ...filters, kind: event.target.value })}><option value="all">All types</option>{[...new Set(nodes.map(node => node.kind))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Source state<select value={filters.state} onChange={event => onChange({ ...filters, state: event.target.value })}><option value="all">All states</option>{[...new Set(nodes.map(node => node.state))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
    </div>
    <div className="graph-controls"><button disabled={!mounted} onClick={() => onCommand('in')}>Zoom in</button><button disabled={!mounted} onClick={() => onCommand('out')}>Zoom out</button><button disabled={!mounted} onClick={() => onCommand('fit')}>Fit graph</button><button disabled={!mounted} onClick={() => onCommand('reset')}>Reset positions</button><button onClick={onMount}>{mounted ? 'Hide graph' : 'Show graph'}</button></div>
  </section>;
}
