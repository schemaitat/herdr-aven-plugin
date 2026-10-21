import { useEffect, useRef, useState } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import type { Entity } from '../../shared/graph.js';
import { elements, type GraphEdge } from './elements.js';
import { orbitalLayout, type Position } from './layout.js';
import { highlight, syncElements, type GraphMemory } from './interactions.js';
import { clearOverlaps, GraphPhysics, MotionScheduler, selectionTargets, topologyKey } from './physics.js';
import { styles } from './styles.js';

function readableLabels(cy: Core) {
  if (cy.nodes().length > 100) { cy.nodes().removeStyle('font-size text-max-width'); cy.edges().removeStyle('font-size'); return; }
  cy.batch(() => {
    cy.nodes().style({ 'font-size': Math.max(12, 10 / cy.zoom()), 'text-max-width': `${Math.max(150, 130 / cy.zoom())}px` });
    cy.edges().style('font-size', Math.max(9, 8 / cy.zoom()));
  });
}
type Command = { kind: 'fit' | 'reset' | 'in' | 'out' | 'restore' | 'rollback'; serial: number; camera?: GraphMemory['camera']; positions?: Map<string, Position> };
interface Props {
  nodes: Entity[]; edges: GraphEdge[]; selected?: string; component?: string; paused?: boolean;
  onSelect: (id: string) => void; onToggle: (id: string) => void; command: Command; memory: GraphMemory;
}

export function GraphView(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const control = useRef<{ sync: () => void; selection: () => void; pause: () => void; command: () => void }>(undefined);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const host = container.current!;
    const cy = cytoscape({ container: host, elements: [], style: styles, layout: { name: 'preset' }, minZoom: 0.04, maxZoom: 3, pixelRatio: 1, textureOnViewport: true, zoom: latest.current.memory.camera?.zoom ?? 1, pan: latest.current.memory.camera?.pan ?? { x: 0, y: 0 } });
    let memory = latest.current.memory;
    let fitted = Boolean(memory.camera), key = '', previousComponent = latest.current.component;
    let solver: GraphPhysics | undefined, geometry = new Map<string, Position>(), dragging: string | undefined;
    let pendingReturn: Map<string, Position> | undefined;
    let activationPins = new Map<string, Position>();
    let ticks = 0, activations = 0, zoomTimer: ReturnType<typeof setTimeout>;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const positions = () => new Map(cy.nodes().map(node => [node.id(), { ...node.position() }]));
    const paint = () => {
      // Fixed/unrelated nodes must not invalidate all 1,000 edge paths on every
      // frame. Cytoscape position setters dirty renderer caches even at rest.
      cy.batch(() => cy.nodes().forEach(node => {
        const point = geometry.get(node.id()), current = node.position();
        if (point && !node.grabbed() && (point.x !== current.x || point.y !== current.y)) node.position(point);
      }));
      host.dataset.motion = scheduler.active ? 'active' : 'sleeping';
      host.dataset.physicsTicks = String(ticks);
      memory.visual = positions();
    };
    const scheduler = new MotionScheduler({ now: () => performance.now(), request: callback => requestAnimationFrame(callback), cancel: frame => cancelAnimationFrame(frame) }, paint);
    scheduler.visibility(document.hidden);
    const cancel = () => { scheduler.cancel(); solver?.stop(); solver = undefined; host.dataset.motion = 'sleeping'; };
    const pins = () => memory.pins ??= new Map();
    const fixed = (selected?: string) => {
      const result = new Map(pins());
      if (selected) {
        const neighbors = new Set(latest.current.edges.flatMap(edge => edge.source === selected ? [edge.target] : edge.target === selected ? [edge.source] : []));
        for (const node of latest.current.nodes) if (node.id === selected || !neighbors.has(node.id)) {
          const point = memory.positions.get(node.id); if (point && !result.has(node.id)) result.set(node.id, point);
        }
      }
      if (dragging) result.set(dragging, { ...cy.getElementById(dragging).position() });
      return result;
    };
    const saveOverview = () => {
      if (latest.current.selected || latest.current.component) return;
      for (const [id, point] of geometry) memory.positions.set(id, { ...point });
    };
    const restore = (saved = memory.positions) => {
      cancel();
      const start = positions(), targets = new Map(latest.current.nodes.map(node => [node.id, pins().get(node.id) ?? saved.get(node.id) ?? memory.positions.get(node.id)!]));
      pendingReturn = targets;
      if (media.matches) { geometry = targets; pendingReturn = undefined; paint(); return; }
      if (latest.current.paused) return;
      let step = 0;
      scheduler.start(() => {
        const t = Math.min(1, ++step / 24), eased = 1 - (1 - t) ** 3;
        geometry = new Map([...targets].map(([id, target]) => { const from = start.get(id) ?? target; return [id, { x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased }]; }));
        return t === 1;
      }, () => { geometry = targets; pendingReturn = undefined; });
      host.dataset.motion = 'active';
    };
    const activate = (dragAnchor?: string) => {
      cancel();
      pendingReturn = undefined;
      const { nodes, edges, selected, paused } = latest.current;
      const anchor = dragAnchor ?? (nodes.some(node => node.id === selected) ? selected : undefined);
      const targets = selectionTargets(nodes, edges, memory.positions, anchor);
      const fixedPositions = fixed(anchor);
      activationPins = fixedPositions;
      if (media.matches) {
        geometry = clearOverlaps(nodes, targets, fixedPositions); saveOverview(); paint(); return;
      }
      if (paused || !nodes.length) return;
      solver = new GraphPhysics(nodes, edges, positions(), targets, fixedPositions, anchor, dragging);
      activations++; host.dataset.activations = String(activations); host.dataset.motion = 'active';
      scheduler.start(() => { const settled = solver!.tick(); ticks++; geometry = solver!.positions(); return settled; }, () => {
        solver?.stop();
        geometry = clearOverlaps(latest.current.nodes, geometry, fixedPositions);
        saveOverview();
      }, nodes.length > 100 ? 1 : 2);
    };
    const rememberCamera = () => { if (fitted) memory.camera = { zoom: cy.zoom(), pan: { ...cy.pan() } }; };
    const viewport = () => { rememberCamera(); clearTimeout(zoomTimer); zoomTimer = setTimeout(() => { readableLabels(cy); setZoom(cy.zoom()); }, 100); };
    const select = (event: cytoscape.EventObject) => latest.current.onSelect(event.target.id());
    const toggle = (event: cytoscape.EventObject) => latest.current.onToggle(event.target.id());
    const grab = (event: cytoscape.EventObject) => { cancel(); dragging = event.target.id(); };
    const drag = () => {
      if (!dragging) return;
      if (!solver || !scheduler.active) { activate(dragging); return; }
      const point = { ...cy.getElementById(dragging).position() };
      activationPins.set(dragging, point);
      solver.drag(dragging, point); scheduler.interact();
    };
    const release = (event: cytoscape.EventObject) => {
      const id = event.target.id(), point = { ...event.target.position() };
      pins().set(id, point); memory.positions.set(id, point); dragging = undefined; activate(id);
    };
    const visibility = () => scheduler.visibility(document.hidden);
    const preference = () => { if (media.matches) { cancel(); activate(); } else activate(); };
    control.current = {
      sync() {
        const { nodes, edges, component } = latest.current;
        const nextKey = topologyKey(nodes, edges), changedMemory = memory !== latest.current.memory;
        const changed = nextKey !== key, componentExit = Boolean(previousComponent && !component);
        const initial = !fitted && nodes.length > 0;
        const layoutStart = performance.now();
        if (changed || changedMemory) cancel();
        memory = latest.current.memory;
        const baseline = changed || changedMemory ? clearOverlaps(nodes, orbitalLayout(nodes, edges), pins()) : new Map<string, Position>();
        for (const node of nodes) if (!memory.positions.has(node.id)) memory.positions.set(node.id, { ...baseline.get(node.id)! });
        const syncStart = performance.now();
        const entering = new Map(memory.positions);
        if (!cy.nodes().length && memory.visual) for (const [id, point] of memory.visual) entering.set(id, point);
        for (const [id, point] of pins()) entering.set(id, point);
        syncElements(cy, elements(nodes, edges), entering, baseline, false);
        highlight(cy, latest.current.selected);
        if (changedMemory) restore(memory.visual ?? memory.positions);
        else if (componentExit) restore();
        else if (changed) activate();
        key = nextKey; previousComponent = component;
        if (!fitted && nodes.length) { cy.resize(); cy.fit(undefined, 50); fitted = true; }
        rememberCamera(); readableLabels(cy); setZoom(cy.zoom());
        performance.clearMeasures('graph.layout'); performance.clearMeasures('graph.sync');
        performance.measure('graph.layout', { start: layoutStart, end: syncStart, detail: { computed: changed } });
        performance.measure('graph.sync', { start: syncStart, end: performance.now() });
        if (initial) {
          performance.clearMeasures('graph.initial-layout'); performance.clearMeasures('graph.initial-sync');
          performance.measure('graph.initial-layout', { start: layoutStart, end: syncStart });
          performance.measure('graph.initial-sync', { start: syncStart, end: performance.now() });
        }
      },
      selection() { highlight(cy, latest.current.selected); if (latest.current.selected) activate(); else restore(); },
      pause() { if (latest.current.paused) cancel(); else if (pendingReturn) restore(pendingReturn); else activate(); },
      command() {
        const { command, nodes, edges } = latest.current;
        if (!command.serial || command.serial === memory.commandSerial) return;
        memory.commandSerial = command.serial;
        if (command.kind === 'reset') {
          cancel(); pendingReturn = undefined; memory.positions.clear(); pins().clear();
          geometry = clearOverlaps(nodes, orbitalLayout(nodes, edges));
          for (const [id, point] of geometry) memory.positions.set(id, { ...point });
          paint(); cy.fit(undefined, 50);
        } else if (command.kind === 'restore' || command.kind === 'rollback') { restore(command.kind === 'rollback' ? command.positions ?? memory.visual ?? memory.positions : memory.positions); if (command.camera) cy.viewport(command.camera); }
        else if (command.kind === 'fit') cy.fit(undefined, 50);
        else cy.zoom({ level: cy.zoom() * (command.kind === 'in' ? 1.25 : 0.8), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
      },
    };
    cy.on('tap', 'node, edge', select); cy.on('dbltap', 'node', toggle);
    cy.on('zoom', viewport); cy.on('pan', rememberCamera);
    cy.on('grab', 'node', grab); cy.on('drag', 'node', drag); cy.on('dragfree', 'node', release);
    document.addEventListener('visibilitychange', visibility); media.addEventListener('change', preference);
    const resize = new ResizeObserver(() => cy.resize()); resize.observe(host);
    return () => {
      rememberCamera(); cancel(); resize.disconnect(); clearTimeout(zoomTimer);
      document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', preference);
      cy.off('tap', 'node, edge', select); cy.off('dbltap', 'node', toggle);
      cy.off('zoom', viewport); cy.off('pan', rememberCamera);
      cy.off('grab', 'node', grab); cy.off('drag', 'node', drag); cy.off('dragfree', 'node', release);
      cy.destroy(); control.current = undefined;
    };
  }, []);
  useEffect(() => control.current?.sync(), [props.nodes, props.edges, props.memory, props.component]);
  const firstSelection = useRef(true), firstPause = useRef(true);
  useEffect(() => { if (firstSelection.current) { firstSelection.current = false; return; } control.current?.selection(); }, [props.selected]);
  useEffect(() => { if (firstPause.current) { firstPause.current = false; return; } control.current?.pause(); }, [props.paused]);
  useEffect(() => control.current?.command(), [props.command]);
  return <section className="graph-panel" aria-label="Relationship graph">
    <div ref={container} className="graph-canvas" aria-hidden="true" />
    <p className="graph-status" role="status">{props.nodes.length} entities · {props.edges.length} connections · Zoom {Math.round(zoom * 100)}%</p>
  </section>;
}
