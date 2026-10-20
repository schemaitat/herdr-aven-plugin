import { useEffect, useState } from 'react';
import type { GraphSnapshot } from '../shared/graph.js';
import { EntityList } from './EntityList.js';
import { DetailsPanel } from './DetailsPanel.js';

const entityOrder = ['epic', 'task', 'attempt', 'agent', 'session', 'workspace', 'pane', 'worktree', 'boundary'];

export function App() {
  const [snapshot, setSnapshot] = useState<GraphSnapshot>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [state, setState] = useState('all');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let token = '';
    const refresh = async () => {
      try {
        if (!token) {
          const response = await fetch('/bootstrap', { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) throw new Error('Cannot authenticate local explorer');
          token = (await response.json()).token;
        }
        const response = await fetch('/api/snapshot', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store' });
        if (response.status === 401) token = '';
        if (!response.ok) throw new Error('Snapshot unavailable. Retrying automatically.');
        const next: GraphSnapshot = await response.json();
        setSnapshot(next);
        setError('');
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Connection unavailable');
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 4000); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const entity = snapshot?.nodes.find(node => node.id === selected);
  const filtered = snapshot?.nodes.filter(node =>
    (kind === 'all' || node.kind === kind) && (state === 'all' || node.state === state) &&
    `${node.label} ${node.id}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => entityOrder.indexOf(a.kind) - entityOrder.indexOf(b.kind) || a.label.localeCompare(b.label)) ?? [];
  return <>
    <header className="masthead"><div className="orb" aria-hidden="true" /><div><p className="eyebrow">AVEN / LOCAL OBSERVATORY</p><h1>Project explorer</h1><p className="muted">One project. Connected tasks and execution resources. Always read-only.</p></div><span className="readonly">READ ONLY</span></header>
    <main>
      <section className="overview" aria-label="Snapshot overview">
        <div><p className="eyebrow">CURRENT SCOPE</p><h2>{snapshot ? `${snapshot.scope.workspace} / ${snapshot.scope.project}` : 'Connecting to local sources…'}</h2><p className="muted">{snapshot ? `${snapshot.nodes.length} entities · ${snapshot.edges.length} relationships · snapshot ${new Date(snapshot.observedAt).toLocaleTimeString()}` : 'Loading a bounded, normalized snapshot'}</p></div>
        <div className="source-health" aria-label="Source health">{snapshot?.health.map(source => <div key={source.source} className={`health ${source.status}`}><strong>{source.source} · {source.status}</strong><span>{source.message}</span><small>Observed {new Date(source.observedAt).toLocaleTimeString()}</small></div>)}</div>
      </section>
      {error && <p role="alert" className="warning">{error} {snapshot && 'Displayed data is stale.'}</p>}
      <section className="toolbar" aria-label="Entity filters">
        <label>Search entities<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Task, session, pane, branch…" /></label>
        <label>Entity type<select value={kind} onChange={event => setKind(event.target.value)}><option value="all">All types</option>{[...new Set(snapshot?.nodes.map(node => node.kind))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Source state<select value={state} onChange={event => setState(event.target.value)}><option value="all">All states</option>{[...new Set(snapshot?.nodes.map(node => node.state))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
      </section>
      <div className="explorer">
        <EntityList nodes={filtered} selected={selected} onSelect={setSelected} loading={!snapshot && !error} />
        <DetailsPanel entity={entity} snapshot={snapshot} onSelect={setSelected} missing={Boolean(selected && !entity)} />
      </div>
      <footer>Local sources only · No prompts, approvals, focus changes, reconciliation, or task writes · Terminal observations do not imply acceptance.</footer>
    </main>
  </>;
}
