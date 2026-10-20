import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphSnapshot } from '../shared/graph.js';
import { EntityList } from './EntityList.js';
import { DetailsPanel } from './DetailsPanel.js';
import { GraphView } from './graph/GraphView.js';
import { canonicalSelection, projectGraph, toggleEpic, type Filters } from './graph/state.js';
import type { GraphMemory } from './graph/interactions.js';
import { Toolbar } from './Toolbar.js';
import { Legend } from './Legend.js';

export function App() {
  const [snapshot, setSnapshot] = useState<GraphSnapshot>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<Filters>({ query: '', kind: 'all', state: 'all' });
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [mounted, setMounted] = useState(true);
  const graphMemory = useRef<GraphMemory>({ positions: new Map() });
  const [command, setCommand] = useState<{ kind: 'fit' | 'reset' | 'in' | 'out'; serial: number }>({ kind: 'fit', serial: 0 });
  const toggle = (id: string) => setCollapsed(previous => toggleEpic(previous, id));
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
  const graph = useMemo(() => snapshot ? projectGraph(snapshot, filters, collapsed) : { nodes: [], edges: [], allEdges: [], hiddenTasks: 0, hiddenRelationships: 0 }, [snapshot, filters, collapsed]);
  const selectedEdge = graph.edges.find(edge => edge.id === selected || (edge.summary && edge.evidence?.[0] === selected)) ?? graph.allEdges.find(edge => edge.id === selected);
  const select = (id: string) => setSelected(canonicalSelection(graph.edges, id));
  return <>
    <header className="masthead"><div className="orb" aria-hidden="true" /><div><p className="eyebrow">AVEN / LOCAL OBSERVATORY</p><h1>Project explorer</h1><p className="muted">One project. Connected tasks and execution resources. Always read-only.</p></div><span className="readonly">READ ONLY</span></header>
    <main>
      <section className="overview" aria-label="Snapshot overview">
        <div><p className="eyebrow">CURRENT SCOPE</p><h2>{snapshot ? `${snapshot.scope.workspace} / ${snapshot.scope.project}` : 'Connecting to local sources…'}</h2><p className="muted">{snapshot ? `${snapshot.nodes.length} entities · ${snapshot.edges.length} relationships · snapshot ${new Date(snapshot.observedAt).toLocaleTimeString()}` : 'Loading a bounded, normalized snapshot'}</p></div>
        <div className="source-health" aria-label="Source health">{snapshot?.health.map(source => <div key={source.source} className={`health ${source.status}`}><strong>{source.source} · {source.status}</strong><span>{source.message}</span><small>Observed {new Date(source.observedAt).toLocaleTimeString()}</small></div>)}</div>
      </section>
      {error && <p role="alert" className="warning">{error} {snapshot && 'Displayed data is stale.'}</p>}
      <Toolbar nodes={snapshot?.nodes ?? []} filters={filters} onChange={setFilters} onCommand={kind => setCommand(previous => ({ kind, serial: previous.serial + 1 }))} mounted={mounted} onMount={() => setMounted(value => !value)} />
      <Legend />
      {graph.hiddenTasks > 0 && <p className="warning" role="status">{graph.hiddenTasks} collapsed tasks · {graph.hiddenRelationships} relationships touch hidden tasks. External connections are summarized at visible epic hubs; internal blockers remain recorded. Expand epics to inspect all tasks.</p>}
      {mounted && <GraphView nodes={graph.nodes} edges={graph.edges} selected={selectedEdge?.id ?? selected} onSelect={select} onToggle={toggle} command={command} memory={graphMemory.current} />}
      <div className="explorer">
        <EntityList nodes={graph.nodes} selected={selected} onSelect={setSelected} loading={!snapshot && !error} collapsed={collapsed} onToggle={toggle} />
        <DetailsPanel entity={entity} edge={selectedEdge} relationships={graph.allEdges} snapshot={snapshot} onSelect={setSelected} missing={Boolean(selected && !entity && !selectedEdge)} />
      </div>
      <footer>Local sources only · No prompts, approvals, focus changes, reconciliation, or task writes · Terminal observations do not imply acceptance.</footer>
    </main>
  </>;
}
