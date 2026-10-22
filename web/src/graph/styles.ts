import type { StylesheetJson } from 'cytoscape';

// Geometry, patterns and text carry meaning independently of the space palette.
// Surfaces stay translucent so dense clusters do not become opaque slabs; labels,
// arrowheads and focus rings keep high contrast. Motion cues are DOM/CSS markers
// in GraphView; directional edge flow is a lightweight overlay canvas.
export const styles: StylesheetJson = [
  { selector: 'node', style: { 'background-color': '#24365c', 'background-fill': 'radial-gradient', 'background-gradient-stop-colors': ['#3d5683', '#182441'], 'background-opacity': 0.74, 'border-color': '#9abfff', 'border-width': 2, 'border-opacity': 0.86, width: 46, height: 46, label: 'data(label)', color: '#e5eaf7', 'font-size': 12, 'text-wrap': 'wrap', 'text-max-width': '160px', 'text-valign': 'bottom', 'text-margin-y': 9, 'text-outline-width': 3, 'text-outline-color': '#080d1b', 'min-zoomed-font-size': 8 } },
  { selector: 'node[kind = "epic"]', style: { width: 100, height: 100, 'background-opacity': 0.68, 'background-gradient-stop-colors': ['#715aaa', '#30254f'], 'border-color': '#c7b3ff', 'border-width': 4 } },
  { selector: 'node[kind = "agent"]', style: { shape: 'diamond', 'background-gradient-stop-colors': ['#347b80', '#16383f'] } },
  { selector: 'node[kind = "attempt"]', style: { shape: 'hexagon' } },
  { selector: 'node[kind = "session"]', style: { shape: 'round-rectangle' } },
  { selector: 'node[kind = "workspace"]', style: { shape: 'barrel' } },
  { selector: 'node[kind = "pane"]', style: { shape: 'rectangle' } },
  { selector: 'node[kind = "worktree"]', style: { shape: 'triangle' } },
  { selector: 'node[kind = "boundary"]', style: { shape: 'octagon', 'border-style': 'dashed' } },
  { selector: 'node[working = "yes"]', style: { 'border-color': '#73f4cf', 'border-width': 5, 'border-opacity': 1 } },
  { selector: 'edge', style: { width: 1.5, 'curve-style': 'bezier', opacity: 0.55, 'line-color': '#8699bc', 'target-arrow-color': '#8699bc', 'target-arrow-shape': 'triangle', label: 'data(label)', color: '#d2dcf0', 'font-size': 9, 'text-rotation': 'autorotate', 'text-background-color': '#080d1b', 'text-background-opacity': 0.95, 'text-background-padding': '2px', 'min-zoomed-font-size': 7 } },
  { selector: 'edge[kind = "contains"]', style: { 'line-color': '#a48bd4', 'target-arrow-shape': 'circle', opacity: 0.6 } },
  { selector: 'edge[kind = "blocks"]', style: { width: 2.5, 'line-color': '#f0b676', 'target-arrow-color': '#f0b676', opacity: 0.7 } },
  { selector: 'edge[kind = "agent-dependency"]', style: { 'line-style': 'dashed', 'line-color': '#f0b676', 'target-arrow-color': '#f0b676', opacity: 0.62 } },
  { selector: 'edge[kind = "assigned"]', style: { 'line-style': 'dashed', 'line-color': '#73d5cd', opacity: 0.62 } },
  { selector: 'edge[kind = "placed-in"]', style: { 'line-style': 'dotted', 'target-arrow-shape': 'square', opacity: 0.58 } },
  { selector: 'edge[kind = "worktree"]', style: { 'target-arrow-shape': 'diamond' } },
  { selector: 'edge[kind = "related"]', style: { 'target-arrow-shape': 'none', 'line-style': 'dotted', opacity: 0.45 } },
  { selector: '.muted', style: { opacity: 0.32 } },
  { selector: 'node.selected', style: { 'border-width': 5, 'border-color': '#fff0a8', 'border-opacity': 1, 'underlay-color': '#a48bff', 'underlay-opacity': 0.14, 'underlay-padding': 12, 'underlay-shape': 'ellipse' } },
  { selector: 'edge.selected', style: { width: 5, 'line-color': '#fff0a8', 'target-arrow-color': '#fff0a8', opacity: 1 } },
  // Keep kind-specific color, dash and arrow rules; only amplify the incident stroke.
  { selector: 'edge.direct-edge', style: { width: 4.5, opacity: 1 } },
];
