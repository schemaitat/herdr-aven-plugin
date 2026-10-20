import { useEffect, useRef, useState } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import type { Entity } from '../../shared/graph.js';
import { elements, type GraphEdge } from './elements.js';
import { orbitalLayout } from './layout.js';
import { highlight, syncElements, type GraphMemory } from './interactions.js';

import { styles } from './styles.js';

// Keep text readable at fit scale, without scaling the circular geometry itself.
function readableLabels(cy: Core) {
  // At dense overview scale, labels appear when zoomed in. The equivalent list
  // remains readable at every scale; inflating 1,500 labels on every wheel tick
  // obscures the graph and invalidates the entire renderer's style cache.
  if (cy.nodes().length > 100) {
    cy.nodes().removeStyle('font-size text-max-width');
    cy.edges().removeStyle('font-size');
    return;
  }
  const size = Math.max(12, 10 / cy.zoom());
  cy.batch(() => {
    cy.nodes().style({ 'font-size': size, 'text-max-width': `${Math.max(150, 130 / cy.zoom())}px` });
    cy.edges().style('font-size', Math.max(9, 8 / cy.zoom()));
  });
}

export function GraphView({ nodes, edges, selected, onSelect, onToggle, command, memory }: {
  nodes: Entity[]; edges: GraphEdge[]; selected?: string; onSelect: (id: string) => void; onToggle: (id: string) => void;
  command: { kind: 'fit' | 'reset' | 'in' | 'out'; serial: number };
  memory: GraphMemory;
}) {
  const container = useRef<HTMLDivElement>(null);
  const core = useRef<Core>(undefined);
  const pending = useRef<{ frame: number; apply: () => void }>(undefined);
  const callbacks = useRef({ onSelect, onToggle });
  callbacks.current = { onSelect, onToggle };
  const selection = useRef(selected);
  selection.current = selected;
  const [zoom, setZoom] = useState(1);
  const fitted = useRef(false);
  useEffect(() => {
    const cy = cytoscape({ container: container.current!, elements: [], style: styles, layout: { name: 'preset' }, minZoom: 0.04, maxZoom: 3, pixelRatio: 1, textureOnViewport: true, zoom: memory.camera?.zoom ?? 1, pan: memory.camera?.pan ?? { x: 0, y: 0 } });
    fitted.current = Boolean(memory.camera);
    performance.clearMeasures('graph.initial-layout'); performance.clearMeasures('graph.initial-sync');
    core.current = cy;
    const select = (event: cytoscape.EventObject) => callbacks.current.onSelect(event.target.id());
    const toggle = (event: cytoscape.EventObject) => { if (event.target.data('kind') === 'epic') callbacks.current.onToggle(event.target.id()); };
    let zoomTimer: ReturnType<typeof setTimeout>;
    const viewport = () => { clearTimeout(zoomTimer); zoomTimer = setTimeout(() => { readableLabels(cy); setZoom(cy.zoom()); }, 100); };
    cy.on('tap', 'node, edge', select);
    cy.on('dbltap', 'node', toggle);
    cy.on('zoom', viewport);
    const resize = new ResizeObserver(() => cy.resize());
    resize.observe(container.current!);
    return () => {
      cy.nodes().forEach(node => { memory.positions.set(node.id(), { ...node.position() }); });
      if (fitted.current) memory.camera = { zoom: cy.zoom(), pan: { ...cy.pan() } };
      resize.disconnect();
      clearTimeout(zoomTimer);
      cy.off('tap', 'node, edge', select); cy.off('dbltap', 'node', toggle); cy.off('zoom', viewport);
      cy.destroy(); core.current = undefined; fitted.current = false;
    };
  }, []);
  useEffect(() => {
    const cy = core.current!;
    // Coalesce same-frame deltas. Layout runs only when new identities need
    // positions; status/selection changes cannot trigger a full relayout.
    const update = () => {
      const initial = !fitted.current && nodes.length > 0;
      const needsLayout = nodes.some(node => !cy.getElementById(node.id).length && !memory.positions.has(node.id));
      const layoutStart = performance.now();
      const positions = needsLayout ? orbitalLayout(nodes, edges) : new Map();
      const syncStart = performance.now();
      syncElements(cy, elements(nodes, edges), memory.positions, positions);
      highlight(cy, selection.current);
      if (!fitted.current && nodes.length) { cy.fit(undefined, 50); fitted.current = true; }
      readableLabels(cy);
      setZoom(cy.zoom());
      // One latest sample per operation, not an unbounded telemetry history.
      performance.clearMeasures('graph.layout'); performance.clearMeasures('graph.sync');
      performance.measure('graph.layout', { start: layoutStart, end: syncStart, detail: { computed: needsLayout } });
      performance.measure('graph.sync', { start: syncStart, end: performance.now() });
      if (initial) {
        performance.measure('graph.initial-layout', { start: layoutStart, end: syncStart });
        performance.measure('graph.initial-sync', { start: syncStart, end: performance.now() });
      }
    };
    // Small projections are cheap and remain synchronous for direct manipulation.
    if (nodes.length <= 100) { update(); return; }
    const frame = requestAnimationFrame(() => { pending.current = undefined; update(); });
    pending.current = { frame, apply: update };
    return () => { cancelAnimationFrame(frame); if (pending.current?.frame === frame) pending.current = undefined; };
  }, [nodes, edges]);
  useEffect(() => { highlight(core.current!, selected); }, [selected]);
  useEffect(() => {
    const cy = core.current!;
    if (!command.serial || command.serial === memory.commandSerial) return;
    memory.commandSerial = command.serial;
    // Explicit controls must operate on the latest projection, even when a
    // dense update was coalesced into a not-yet-painted animation frame.
    if (pending.current) {
      const latest = pending.current; pending.current = undefined;
      cancelAnimationFrame(latest.frame); latest.apply();
    }
    if (command.kind === 'reset') {
      const layout = orbitalLayout(nodes, edges);
      memory.positions.clear();
      cy.nodes().positions(node => layout.get(node.id())!);
      cy.fit(undefined, 50);
    } else if (command.kind === 'fit') cy.fit(undefined, 50);
    else cy.zoom({ level: cy.zoom() * (command.kind === 'in' ? 1.25 : 0.8), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    // Commands, not data refreshes, change camera/layout.
  }, [command]);
  return <section className="graph-panel" aria-label="Relationship graph">
    <p className="graph-help">Drag bubbles to arrange · Drag space to pan · Scroll to zoom · Double-click an epic to collapse · Select an edge for its evidence. Keyboard alternative: Entities below.</p>
    <div ref={container} className="graph-canvas" aria-hidden="true" />
    <p className="graph-status" role="status">{nodes.length} entities · {edges.length} connections · Zoom {Math.round(zoom * 100)}%</p>
  </section>;
}
