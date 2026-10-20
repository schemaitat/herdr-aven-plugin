import { useEffect, useRef, useState } from 'react';
import cytoscape, { type Core, type StylesheetJson } from 'cytoscape';
import type { Entity } from '../../shared/graph.js';
import { elements, type GraphEdge } from './elements.js';
import { orbitalLayout } from './layout.js';
import { highlight, syncElements, type GraphMemory } from './interactions.js';

const styles: StylesheetJson = [
  { selector: 'node', style: { 'background-color': '#243d64', 'border-color': '#9abfff', 'border-width': 2, width: 46, height: 46, label: 'data(label)', color: '#e5eaf7', 'font-size': 12, 'text-wrap': 'wrap', 'text-max-width': '150px', 'text-valign': 'bottom', 'text-margin-y': 9, 'text-outline-width': 2, 'text-outline-color': '#080d1b' } },
  { selector: 'node[kind = "epic"]', style: { width: 100, height: 100, 'background-color': '#493b7b', 'border-color': '#bea6ff', 'border-width': 4 } },
  { selector: 'node[kind = "agent"]', style: { shape: 'diamond', 'background-color': '#225c60' } },
  { selector: 'node[kind = "attempt"]', style: { shape: 'hexagon' } },
  { selector: 'node[kind = "session"]', style: { shape: 'round-rectangle' } },
  { selector: 'node[kind = "workspace"]', style: { shape: 'barrel' } },
  { selector: 'node[kind = "pane"]', style: { shape: 'rectangle' } },
  { selector: 'node[kind = "worktree"]', style: { shape: 'triangle' } },
  { selector: 'node[kind = "boundary"]', style: { shape: 'octagon', 'border-style': 'dashed' } },
  { selector: 'edge', style: { width: 1.5, 'curve-style': 'bezier', 'line-color': '#7787ab', 'target-arrow-color': '#7787ab', 'target-arrow-shape': 'triangle', label: 'data(label)', color: '#bcc9e3', 'font-size': 9, 'text-rotation': 'autorotate', 'text-background-color': '#080d1b', 'text-background-opacity': 0.9, 'text-background-padding': '2px' } },
  { selector: 'edge[kind = "contains"]', style: { 'line-color': '#a48bd4', 'target-arrow-shape': 'circle' } },
  { selector: 'edge[kind = "blocks"]', style: { width: 2.5, 'line-color': '#f0b676', 'target-arrow-color': '#f0b676' } },
  { selector: 'edge[kind = "agent-dependency"]', style: { 'line-style': 'dashed', 'line-color': '#f0b676', 'target-arrow-color': '#f0b676' } },
  { selector: 'edge[kind = "assigned"]', style: { 'line-style': 'dashed', 'line-color': '#73d5cd' } },
  { selector: 'edge[kind = "placed-in"]', style: { 'line-style': 'dotted', 'target-arrow-shape': 'square' } },
  { selector: 'edge[kind = "worktree"]', style: { 'target-arrow-shape': 'diamond' } },
  { selector: 'edge[kind = "related"]', style: { 'target-arrow-shape': 'none', 'line-style': 'dotted' } },
  { selector: '.muted', style: { opacity: 0.4 } },
  { selector: 'node.selected', style: { 'border-width': 5, 'border-color': '#fff0a8' } },
  { selector: 'edge.selected', style: { width: 5, 'line-color': '#fff0a8' } },
];

// Keep text readable at fit scale, without scaling the circular geometry itself.
function readableLabels(cy: Core) {
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
  const callbacks = useRef({ onSelect, onToggle });
  callbacks.current = { onSelect, onToggle };
  const [zoom, setZoom] = useState(1);
  const fitted = useRef(false);
  useEffect(() => {
    const cy = cytoscape({ container: container.current!, elements: [], style: styles, layout: { name: 'preset' }, minZoom: 0.08, maxZoom: 3, zoom: memory.camera?.zoom ?? 1, pan: memory.camera?.pan ?? { x: 0, y: 0 } });
    fitted.current = Boolean(memory.camera);
    core.current = cy;
    const select = (event: cytoscape.EventObject) => callbacks.current.onSelect(event.target.id());
    const toggle = (event: cytoscape.EventObject) => { if (event.target.data('kind') === 'epic') callbacks.current.onToggle(event.target.id()); };
    const viewport = () => { readableLabels(cy); setZoom(cy.zoom()); };
    cy.on('tap', 'node, edge', select);
    cy.on('dbltap', 'node', toggle);
    cy.on('zoom', viewport);
    const resize = new ResizeObserver(() => cy.resize());
    resize.observe(container.current!);
    return () => {
      cy.nodes().forEach(node => { memory.positions.set(node.id(), { ...node.position() }); });
      if (fitted.current) memory.camera = { zoom: cy.zoom(), pan: { ...cy.pan() } };
      resize.disconnect();
      cy.off('tap', 'node, edge', select); cy.off('dbltap', 'node', toggle); cy.off('zoom', viewport);
      cy.destroy(); core.current = undefined; fitted.current = false;
    };
  }, []);
  useEffect(() => {
    const cy = core.current!;
    const needsLayout = nodes.some(node => !cy.getElementById(node.id).length && !memory.positions.has(node.id));
    syncElements(cy, elements(nodes, edges), memory.positions, needsLayout ? orbitalLayout(nodes, edges) : new Map());
    highlight(cy, selected);
    if (!fitted.current && nodes.length) { cy.fit(undefined, 50); fitted.current = true; }
    readableLabels(cy);
    setZoom(cy.zoom());
  }, [nodes, edges, selected]);
  useEffect(() => {
    const cy = core.current!;
    if (!command.serial || command.serial === memory.commandSerial) return;
    memory.commandSerial = command.serial;
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
