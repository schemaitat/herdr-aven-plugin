import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveGraph } from './useLiveGraph.js';
import { ActivityPanel } from './ActivityPanel.js';
import { LogPanel } from './LogPanel.js';
import { EntityList } from './EntityList.js';
import { DetailsPanel } from './DetailsPanel.js';
import { canonicalSelection, componentResolver, copyFilters, defaultFilters, projectGraph, toggleEpic, type Filters } from './graph/state.js';
import type { GraphMemory } from './graph/interactions.js';
import { Toolbar } from './Toolbar.js';
import { Legend } from './Legend.js';
import { SearchDialog } from './SearchDialog.js';
import { infoShortcut, slashShortcut } from './graph/search.js';

// Keep the equivalent list/detail path usable while the optional canvas loads.
const GraphView = lazy(() => import('./graph/GraphView.js').then(module => ({ default: module.GraphView })));

class CanvasBoundary extends Component<{ children: ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? <p role="alert">Canvas unavailable. Use Entities and details to inspect the complete scope.</p> : this.props.children; }
}

type Panel = 'entities' | 'activity' | 'history' | 'help';

export function App() {
  const live = useLiveGraph();
  const [preferences, setPreferences] = useState<Filters>(defaultFilters);
  return <Explorer key={live.selectionEpoch} live={live} preferences={preferences} onPreferences={setPreferences} />;
}

function Explorer({ live, preferences, onPreferences }: { live: ReturnType<typeof useLiveGraph>; preferences: Filters; onPreferences: (filters: Filters) => void }) {
  const { snapshot, error, connection, read, listing, project, selectProject, discoveryError, retryDiscovery } = live;
  const [selected, setSelected] = useState<string>();
  const [filters, setFilters] = useState<Filters>(() => ({ ...copyFilters(preferences), query: '', epic: undefined }));
  useEffect(() => { onPreferences({ ...defaultFilters(), kinds: new Set(filters.kinds), relationKinds: new Set(filters.relationKinds), state: filters.state, time: filters.time }); }, [filters.kinds, filters.relationKinds, filters.state, filters.time, onPreferences]);
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (filters.time === 'all') return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [filters.time]);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [component, setComponent] = useState<string>();
  const componentCamera = useRef<GraphMemory['camera']>(undefined);
  const [announcement, setAnnouncement] = useState('');
  const [mounted, setMounted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const [panel, setPanel] = useState<Panel>();
  const panelMenu = useRef<HTMLDetailsElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoOpener = useRef<HTMLElement | null>(null);
  useEffect(() => { if (!selected) setInfoOpen(false); }, [selected]);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const searchBaseline = useRef<{ filters: Filters; selected?: string; component?: string; geometry?: GraphMemory['positions']; camera?: GraphMemory['camera']; focus: HTMLElement | null; memory: GraphMemory }>(undefined);
  const [searching, setSearching] = useState(false);
  const graphMemory = useRef<GraphMemory>({ positions: new Map() });
  const resolveComponent = useRef(componentResolver());
  const [command, setCommand] = useState<{ kind: 'fit' | 'reset' | 'in' | 'out' | 'restore' | 'rollback'; serial: number; camera?: GraphMemory['camera']; positions?: GraphMemory['positions'] }>({ kind: 'fit', serial: 0 });
  const toggle = (id: string) => setCollapsed(previous => toggleEpic(previous, id));
  const entity = snapshot?.nodes.find(node => node.id === selected);
  const graph = useMemo(() => snapshot ? projectGraph(snapshot, filters, collapsed, Date.now(), component, resolveComponent.current) : { nodes: [], discoveryNodes: [], edges: [], allEdges: [], distances: new Map<string, number>(), cappedNodes: 0, omittedRelationships: 0, hiddenTasks: 0, hiddenRelationships: 0, unknownTimeExclusions: 0, componentAvailable: true }, [snapshot, filters, collapsed, clock, component]);
  const focusComponent = (id?: string, toggle = false) => {
    if (!id || toggle && component === id) {
      setComponent(undefined);
      setCommand(previous => ({ kind: 'restore', serial: previous.serial + 1, camera: componentCamera.current }));
    } else {
      if (!component) componentCamera.current = graphMemory.current.camera;
      setComponent(id);
      setCommand(previous => ({ kind: 'fit', serial: previous.serial + 1 }));
    }
  };
  useEffect(() => {
    if (component && !graph.componentAvailable) { focusComponent(); setAnnouncement('Component anchor is unavailable in this scope. Showing all matching entities.'); }
  }, [component, graph.componentAvailable]);
  const selectedEdge = graph.edges.find(edge => edge.id === selected || (edge.summary && edge.evidence?.[0] === selected)) ?? graph.allEdges.find(edge => edge.id === selected);
  const oneHop = useMemo(() => new Set(graph.edges.flatMap(edge => edge.source === selected ? [edge.target] : edge.target === selected ? [edge.source] : [])), [graph.edges, selected]);
  const openPanel = (next: Panel, focus = false) => {
    const narrow = window.matchMedia('(max-width: 650px)').matches;
    panelTrigger.current = (narrow ? panelMenu.current?.querySelector('summary') : null) ?? document.activeElement as HTMLElement;
    if (narrow && panelMenu.current) panelMenu.current.open = false;
    setPanel(next);
    if (focus) requestAnimationFrame(() => document.getElementById(next === 'entities' ? 'entities' : 'inspector')?.focus());
  };
  const closePanel = () => { setPanel(undefined); panelTrigger.current?.focus(); };
  const select = (id: string) => {
    const canonical = canonicalSelection(graph.edges, id);
    setSelected(canonical);
  };
  const openSearch = () => {
    if (searchBaseline.current) return;
    const memory = graphMemory.current;
    searchBaseline.current = { filters: copyFilters(filters), selected, component, geometry: memory.visual && new Map(memory.visual), camera: memory.camera && { zoom: memory.camera.zoom, pan: { ...memory.camera.pan } }, focus: document.activeElement as HTMLElement, memory: { positions: new Map([...memory.positions].map(([id, position]) => [id, { ...position }])), pins: new Map(memory.pins), visual: memory.visual && new Map(memory.visual), camera: memory.camera } };
    setSearching(true);
  };
  const closeSearch = (commit: boolean) => {
    const baseline = searchBaseline.current;
    if (!baseline) return;
    if (!commit) {
      setFilters(baseline.filters);
      setComponent(baseline.component);
      setSelected(snapshot?.nodes.some(node => node.id === baseline.selected) || graph.allEdges.some(edge => edge.id === baseline.selected) ? baseline.selected : undefined);
      setCommand(previous => ({ kind: 'rollback', serial: previous.serial + 1, camera: baseline.camera, positions: baseline.geometry }));
    } else if (!graph.discoveryNodes.some(node => node.id === selected)) setSelected(graph.discoveryNodes[0]?.id);
    searchBaseline.current = undefined;
    setSearching(false);
    requestAnimationFrame(() => baseline.focus?.isConnected && baseline.focus.focus());
  };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (slashShortcut(event) && !searching) { event.preventDefault(); openSearch(); }
      else if (infoShortcut(event) && !searching && selected) {
        event.preventDefault();
        if (!infoOpen) {
          infoOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setInfoOpen(true);
          requestAnimationFrame(() => document.getElementById('entity-details')?.focus());
        } else {
          setInfoOpen(false);
          requestAnimationFrame(() => {
            const opener = infoOpener.current?.isConnected ? infoOpener.current : document.querySelector<HTMLElement>('#entities [aria-pressed="true"]');
            opener?.focus();
          });
        }
      }
      else if (event.key === 'Escape' && panel && !searching && !event.defaultPrevented) { event.preventDefault(); closePanel(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  });
  return <>
    <a className="skip-link" href="#entities" onClick={event => { event.preventDefault(); openPanel('entities', true); }}>Skip graph to entities</a>
      <main className="graph-shell">
      <header className="graph-header" aria-label="Explorer controls">
       <p role="status" className="live-connection">{connection}</p>
       <Toolbar paused={paused} onPause={() => setPaused(value => !value)} projects={listing?.projects ?? []} project={project} onProject={selectProject} nodes={snapshot?.nodes ?? []} filters={filters} onChange={setFilters} onSearch={openSearch} matches={graph.discoveryNodes.length} visible={mounted ? graph.nodes.length : 0} unknownTimeExclusions={graph.unknownTimeExclusions} health={snapshot?.health} onCommand={kind => setCommand(previous => ({ kind, serial: previous.serial + 1 }))} mounted={mounted} onMount={() => { setMounted(value => !value); if (mounted) openPanel('entities'); }} />
       <div className="header-secondary"><nav className="panel-controls desktop-panels" aria-label="Inspection panels">{(['entities', 'activity', 'history', 'help'] as const).map(value => <button key={value} aria-expanded={panel === value} aria-controls="inspector" onClick={() => panel === value ? closePanel() : openPanel(value, true)}>{value === 'entities' ? 'Entities & details' : value === 'history' ? 'Event history' : value === 'help' ? 'Help & legend' : 'Live activity'}</button>)}</nav><details ref={panelMenu} className="panel-disclosure mobile-panels" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary>Panels</summary><nav className="panel-controls" aria-label="Inspection panels">{(['entities', 'activity', 'history', 'help'] as const).map(value => <button key={value} aria-expanded={panel === value} aria-controls="inspector" onClick={() => panel === value ? closePanel() : openPanel(value, true)}>{value === 'entities' ? 'Entities & details' : value === 'history' ? 'Event history' : value === 'help' ? 'Help & legend' : 'Live activity'}</button>)}</nav></details><span className="info-hint">i · Entity info</span></div>
      </header>
      {error && <p role="alert" className="warning">{error} {snapshot && 'Displayed data is stale.'}</p>}
      {discoveryError && <p role="status" className="warning">{discoveryError} <button onClick={retryDiscovery}>Retry project discovery</button></p>}
      {canvasFailed && <p role="alert" className="warning">Canvas unavailable. Entities and details remain available.</p>}
      {announcement && <p role="status">{announcement}</p>}
       {component && <p role="status" className="focus-status">Connected component · ranked layout <button onClick={() => focusComponent()}>Show all</button></p>}
      {graph.cappedNodes > 0 && <p className="warning" role="status">Graph limited to 500 visible nodes · {graph.cappedNodes} additional matches · {graph.omittedRelationships} source relationships touch cap-hidden matches. Narrow search/type/status filters to reveal them. All {graph.discoveryNodes.length} matches remain in Entities and details; totals above are unchanged.</p>}
      {graph.hiddenTasks > 0 && <p className="warning" role="status">{graph.hiddenTasks} collapsed tasks · {graph.hiddenRelationships} relationships touch hidden tasks. External connections are summarized at visible epic hubs; internal blockers remain recorded. Expand epics to inspect all tasks.</p>}
      {snapshot && graph.discoveryNodes.length === 0 && <p className="warning" role="status">No matching entities in this scope. <button onClick={() => setFilters(defaultFilters())}>Reset empty scope</button>{filters.epic && !snapshot.nodes.some(node => node.id === filters.epic && node.kind === 'epic') && ' The selected epic is no longer in the loaded snapshot; clear epic or reset filters.'}</p>}
       <div className={`workspace ${panel ? 'inspecting' : ''} ${!mounted ? 'list-only' : ''} ${infoOpen && selected ? 'info-open' : ''}`}>
          {mounted && <CanvasBoundary onFailure={() => { setCanvasFailed(true); setMounted(false); setPanel('entities'); }}><Suspense fallback={<p className="empty" role="status">Loading relationship canvas… Open Entities for inspection.</p>}><GraphView nodes={graph.nodes} edges={graph.edges} selected={selectedEdge?.id ?? selected} component={component} paused={paused} onSelect={select} onToggle={id => focusComponent(id, true)} command={command} memory={searchBaseline.current?.memory ?? graphMemory.current} /></Suspense></CanvasBoundary>}
          {infoOpen && selected && <section className="entity-info" aria-label="Entity information"><DetailsPanel entity={entity} edge={selectedEdge} relationships={graph.allEdges} snapshot={snapshot} onSelect={select} onFocus={id => focusComponent(id, true)} onClear={() => setSelected(undefined)} focused={Boolean(component && component === entity?.id)} missing={Boolean(selected && !entity && !selectedEdge)} /></section>}
        {panel && <section id="inspector" tabIndex={-1} className="inspector" aria-label="Inspector" onPointerDown={event => event.stopPropagation()}>
          <div className="inspector-heading"><h2>{panel === 'entities' ? 'Entities & details' : panel === 'history' ? 'Event history' : panel === 'activity' ? 'Live activity' : 'Help & legend'}</h2><button onClick={closePanel}>Close panel</button></div>
          {panel === 'entities' && <div className="explorer">
             <EntityList nodes={graph.discoveryNodes} selected={selected} oneHop={oneHop} onSelect={select} loading={!snapshot && !error} collapsed={collapsed} onToggle={toggle} />
             <div>{entity && !graph.nodes.some(node => node.id === entity.id) && <p className="muted">Selected entity is off-canvas (filtered, collapsed or beyond the visible-node cap). Its pinned details and source relationships remain available.</p>}</div>
          </div>}
          {panel === 'activity' && <ActivityPanel entity={entity} snapshot={snapshot} />}
          {panel === 'history' && <LogPanel entity={entity} read={read} project={project} />}
           {panel === 'help' && <><p>Click selects without moving the camera · Press i for entity/edge evidence · Double-click a node or use Focus component in the i-opened info surface to focus explicitly · Drag bubbles to arrange · Drag space to pan · Scroll to zoom · Collapse epics explicitly in Entities.</p><Legend /><p>Local sources only · No prompts, approvals, reconciliation or task writes · Terminal observations do not imply acceptance.</p><div className="source-health">{snapshot?.health.map(source => <p key={source.source}>{source.source} · {source.status}: {source.message} · Observed {source.observedAt}</p>)}</div></>}
        </section>}
      </div>
      {searching && <SearchDialog query={filters.query} results={graph.discoveryNodes} active={selected} onQuery={query => setFilters(previous => ({ ...previous, query }))} onPreview={setSelected} onClose={closeSearch} />}
    </main>
  </>;
}
