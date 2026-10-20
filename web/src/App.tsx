import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { useLiveGraph } from './useLiveGraph.js';
import { ActivityPanel } from './ActivityPanel.js';
import { LogPanel } from './LogPanel.js';
import { EntityList } from './EntityList.js';
import { DetailsPanel } from './DetailsPanel.js';
import { canonicalSelection, projectGraph, toggleEpic, type Filters } from './graph/state.js';
import type { GraphMemory } from './graph/interactions.js';
import { Toolbar } from './Toolbar.js';
import { Legend } from './Legend.js';

// Keep the equivalent list/detail path usable while the optional canvas loads.
const GraphView = lazy(() => import('./graph/GraphView.js').then(module => ({ default: module.GraphView })));

export function App() {
  const { snapshot, error, connection, read } = useLiveGraph();
  const [selected, setSelected] = useState<string>();
  const [filters, setFilters] = useState<Filters>({ query: '', kind: 'all', state: 'all' });
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [mounted, setMounted] = useState(true);
  const graphMemory = useRef<GraphMemory>({ positions: new Map() });
  const [command, setCommand] = useState<{ kind: 'fit' | 'reset' | 'in' | 'out'; serial: number }>({ kind: 'fit', serial: 0 });
  const toggle = (id: string) => setCollapsed(previous => toggleEpic(previous, id));
  const entity = snapshot?.nodes.find(node => node.id === selected);
  const graph = useMemo(() => snapshot ? projectGraph(snapshot, filters, collapsed) : { nodes: [], discoveryNodes: [], edges: [], allEdges: [], cappedNodes: 0, omittedRelationships: 0, hiddenTasks: 0, hiddenRelationships: 0 }, [snapshot, filters, collapsed]);
  const selectedEdge = graph.edges.find(edge => edge.id === selected || (edge.summary && edge.evidence?.[0] === selected)) ?? graph.allEdges.find(edge => edge.id === selected);
  const select = (id: string) => setSelected(canonicalSelection(graph.edges, id));
  return <>
    <a className="skip-link" href="#entities">Skip graph to entities</a>
    <header className="masthead"><div className="orb" aria-hidden="true" /><div><p className="eyebrow">AVEN / LOCAL OBSERVATORY</p><h1>Project explorer</h1><p className="muted">One project. Connected tasks and execution resources. Always read-only.</p></div><span className="readonly">READ ONLY</span></header>
    <main>
      <section className="overview" aria-label="Snapshot overview">
        <div><p className="eyebrow">CURRENT SCOPE</p><h2>{snapshot ? `${snapshot.scope.workspace} / ${snapshot.scope.project}` : 'Connecting to local sources…'}</h2><p className="muted">{snapshot ? `${snapshot.nodes.length} entities · ${snapshot.edges.length} relationships · snapshot ${new Date(snapshot.observedAt).toLocaleTimeString()}` : 'Loading a bounded, normalized snapshot'}</p></div>
        <div className="source-health" aria-label="Source health">{snapshot?.health.map(source => <div key={source.source} className={`health ${source.status}`}><strong>{source.source} · {source.status}</strong><span>{source.message}</span><small>Observed {new Date(source.observedAt).toLocaleTimeString()}</small></div>)}</div>
      </section>
      {error && <p role="alert" className="warning">{error} {snapshot && 'Displayed data is stale.'}</p>}
      <p role="status" className="live-connection">{connection}</p>
      <Toolbar nodes={snapshot?.nodes ?? []} filters={filters} onChange={setFilters} onCommand={kind => setCommand(previous => ({ kind, serial: previous.serial + 1 }))} mounted={mounted} onMount={() => setMounted(value => !value)} />
      <Legend />
      {graph.cappedNodes > 0 && <p className="warning" role="status">Graph limited to 500 visible nodes · {graph.cappedNodes} additional matches · {graph.omittedRelationships} source relationships touch cap-hidden matches. Narrow search/type/status filters to reveal them. All {graph.discoveryNodes.length} matches remain in Entities and details; totals above are unchanged.</p>}
      {entity && !graph.nodes.some(node => node.id === entity.id) && <p className="muted">Selected entity is off-canvas (filtered, collapsed or beyond the visible-node cap). Its details and source relationships remain available. Narrow search or expand its epic to reveal it.</p>}
      {graph.hiddenTasks > 0 && <p className="warning" role="status">{graph.hiddenTasks} collapsed tasks · {graph.hiddenRelationships} relationships touch hidden tasks. External connections are summarized at visible epic hubs; internal blockers remain recorded. Expand epics to inspect all tasks.</p>}
      {mounted && <Suspense fallback={<p className="empty" role="status">Loading relationship canvas… Entities remain available below.</p>}><GraphView nodes={graph.nodes} edges={graph.edges} selected={selectedEdge?.id ?? selected} onSelect={select} onToggle={toggle} command={command} memory={graphMemory.current} /></Suspense>}
      <div className="explorer">
        <EntityList nodes={graph.discoveryNodes} selected={selected} onSelect={setSelected} loading={!snapshot && !error} collapsed={collapsed} onToggle={toggle} />
        <DetailsPanel entity={entity} edge={selectedEdge} relationships={graph.allEdges} snapshot={snapshot} onSelect={setSelected} missing={Boolean(selected && !entity && !selectedEdge)} />
      </div>
      <div className="telemetry"><ActivityPanel entity={entity} snapshot={snapshot} />
      <LogPanel entity={entity} read={read} /></div>
      <footer>Local sources only · No prompts, approvals, focus changes, reconciliation, or task writes · Terminal observations do not imply acceptance.</footer>
    </main>
  </>;
}
