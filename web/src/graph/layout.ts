import type { Entity } from '../../shared/graph.js';
import type { GraphEdge } from './elements.js';

export type Position = { x: number; y: number };

// CiSE compatibility is tested, but it places the epic on the perimeter too.
// Constrained radial placement keeps a real circular hub and explicit child edges.
export function orbitalLayout(nodes: Entity[], edges: GraphEdge[]): Map<string, Position> {
  const positions = new Map<string, Position>();
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const epics = ordered.filter(node => node.kind === 'epic');
  const tasks = new Set(ordered.filter(node => node.kind === 'task').map(node => node.id));
  const groups = epics.map(epic => ({ epic, children: edges.filter(edge => edge.kind === 'contains' && edge.source === epic.id && tasks.has(edge.target)).map(edge => edge.target).sort() }));
  const spacing = Math.max(460, ...groups.map(group => 2 * Math.max(170, group.children.length * 28) + 120));
  const columns = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
  groups.forEach(({ epic, children }, index) => {
    const center = { x: (index % columns) * spacing, y: Math.floor(index / columns) * spacing };
    positions.set(epic.id, center);
    children.forEach((id, child) => {
      if (positions.has(id)) return;
      const angle = child * 2 * Math.PI / children.length - Math.PI / 2;
      const radius = Math.max(170, children.length * 28);
      positions.set(id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    });
  });
  const resourceY = Math.max(0, ...[...positions.values()].map(position => position.y)) + 220;
  ordered.filter(node => !positions.has(node.id)).forEach((node, index) => {
    positions.set(node.id, { x: (index % 5) * 210, y: resourceY + Math.floor(index / 5) * 170 });
  });
  return positions;
}
