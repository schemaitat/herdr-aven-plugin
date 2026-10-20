import { useEffect, useRef } from 'react';
import type { Entity } from '../shared/graph.js';

export function SearchDialog({ query, results, active, onQuery, onPreview, onClose }: {
  query: string; results: Entity[]; active?: string; onQuery: (query: string) => void;
  onPreview: (id: string) => void; onClose: (commit: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current!.showModal(); }, []);
  const index = results.findIndex(node => node.id === active);
  const start = Math.max(0, index - 20);
  const shown = results.slice(start, start + 40);
  useEffect(() => { dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  return <dialog ref={dialog} className="search-dialog" aria-labelledby="search-title" onCancel={event => { event.preventDefault(); onClose(false); }} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(false); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : results.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      if (results[next]) onPreview(results[next].id);
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); onClose(true); }
  }}>
    <h2 id="search-title">Search entities</h2>
    <label>Preview query<input autoFocus maxLength={256} type="search" role="combobox" aria-autocomplete="list" aria-controls="search-results" aria-expanded="true" aria-activedescendant={index >= 0 ? `search-result-${index}` : undefined} value={query} onChange={event => onQuery(event.target.value)} /></label>
    <p className="muted">↑ / ↓ preview · Enter commits · Escape restores scope, selection and camera</p>
    <p role="status">{results.length} matches{results.length > 40 ? ' · 40 shown around the active result; all matches available in Entities' : ''}</p>
    <ul id="search-results" role="listbox" aria-label="Search results">{shown.map((node, offset) => <li id={`search-result-${start + offset}`} key={node.id} role="option" aria-selected={active === node.id} onClick={() => onPreview(node.id)}>{node.label}<small>{node.id}</small></li>)}</ul>
    {!results.length && <p>No matches. Clear the query or broaden the filters.</p>}
    <div className="graph-controls"><button onClick={() => onClose(true)}>Apply search</button><button onClick={() => onClose(false)}>Cancel search</button></div>
  </dialog>;
}
