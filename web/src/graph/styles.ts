import type { StylesheetJson } from 'cytoscape';

// Geometry, patterns and text carry meaning independently of the space palette.
// Motion cues are DOM/CSS markers in GraphView; Cytoscape remains one bounded core.
export const styles: StylesheetJson = [
  { selector: 'node', style: { 'background-color': '#24365c', 'background-fill': 'radial-gradient', 'background-gradient-stop-colors': ['#3d5683', '#182441'], 'border-color': '#9abfff', 'border-width': 2, width: 46, height: 46, label: 'data(label)', color: '#e5eaf7', 'font-size': 12, 'text-wrap': 'wrap', 'text-max-width': '150px', 'text-valign': 'bottom', 'text-margin-y': 9, 'text-outline-width': 2, 'text-outline-color': '#080d1b', 'min-zoomed-font-size': 8 } },
  { selector: 'node[kind = "epic"]', style: { width: 100, height: 100, 'background-gradient-stop-colors': ['#715aaa', '#30254f'], 'border-color': '#c7b3ff', 'border-width': 4 } },
  { selector: 'node[kind = "agent"]', style: { shape: 'diamond', 'background-gradient-stop-colors': ['#347b80', '#16383f'] } },
  { selector: 'node[kind = "attempt"]', style: { shape: 'hexagon' } },
  { selector: 'node[kind = "session"]', style: { shape: 'round-rectangle' } },
  { selector: 'node[kind = "workspace"]', style: { shape: 'barrel' } },
  { selector: 'node[kind = "pane"]', style: { shape: 'rectangle' } },
  { selector: 'node[kind = "worktree"]', style: { shape: 'triangle' } },
  { selector: 'node[kind = "boundary"]', style: { shape: 'octagon', 'border-style': 'dashed' } },
  { selector: 'node[working = "yes"]', style: { 'border-color': '#73f4cf', 'border-width': 5 } },
  { selector: 'edge', style: { width: 1.5, 'curve-style': 'bezier', 'line-color': '#8699bc', 'target-arrow-color': '#8699bc', 'target-arrow-shape': 'triangle', label: 'data(label)', color: '#d2dcf0', 'font-size': 9, 'text-rotation': 'autorotate', 'text-background-color': '#080d1b', 'text-background-opacity': 0.95, 'text-background-padding': '2px', 'min-zoomed-font-size': 7 } },
  { selector: 'edge[kind = "contains"]', style: { 'line-color': '#a48bd4', 'target-arrow-shape': 'circle' } },
  { selector: 'edge[kind = "blocks"]', style: { width: 2.5, 'line-color': '#f0b676', 'target-arrow-color': '#f0b676' } },
  { selector: 'edge[kind = "agent-dependency"]', style: { 'line-style': 'dashed', 'line-color': '#f0b676', 'target-arrow-color': '#f0b676' } },
  { selector: 'edge[kind = "assigned"]', style: { 'line-style': 'dashed', 'line-color': '#73d5cd' } },
  { selector: 'edge[kind = "placed-in"]', style: { 'line-style': 'dotted', 'target-arrow-shape': 'square' } },
  { selector: 'edge[kind = "worktree"]', style: { 'target-arrow-shape': 'diamond' } },
  { selector: 'edge[kind = "related"]', style: { 'target-arrow-shape': 'none', 'line-style': 'dotted' } },
  { selector: '.muted', style: { opacity: 0.65 } },
  { selector: 'node.selected', style: { 'border-width': 5, 'border-color': '#fff0a8', 'underlay-color': '#a48bff', 'underlay-opacity': 0.12, 'underlay-padding': 10, 'underlay-shape': 'ellipse' } },
  { selector: 'edge.selected', style: { width: 5, 'line-color': '#fff0a8', 'target-arrow-color': '#fff0a8' } },
  { selector: 'edge.direct-edge', style: { width: 3.5, opacity: 1 } },
];
