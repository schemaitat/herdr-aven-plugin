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
  const childrenByEpic = new Map(epics.map(epic => [epic.id, new Set<string>()]));
  for (const edge of edges) if (edge.kind === 'contains' && tasks.has(edge.target)) childrenByEpic.get(edge.source)?.add(edge.target);
  const groups = epics.map(epic => ({ epic, children: [...childrenByEpic.get(epic.id)!].sort() }));
  const radiusFor = (count: number) => 170 + Math.max(0, Math.ceil(count / 12) - 1) * 120;
  const spacing = Math.max(460, ...groups.map(group => 2 * radiusFor(group.children.length) + 180));
  const columns = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
  groups.forEach(({ epic, children }, index) => {
    const center = { x: (index % columns) * spacing, y: Math.floor(index / columns) * spacing };
    positions.set(epic.id, center);
    children.forEach((id, child) => {
      if (positions.has(id)) return;
      const ring = Math.floor(child / 12);
      const count = Math.min(12, children.length - ring * 12);
      const angle = (child % 12) * 2 * Math.PI / count - Math.PI / 2;
      const radius = 170 + ring * 120;
      positions.set(id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    });
  });
  const resourceY = Math.max(0, ...[...positions.values()].map(position => position.y)) + 220;
  const remaining = ordered.filter(node => !positions.has(node.id));
  const resourceColumns = Math.max(5, Math.ceil(Math.sqrt(remaining.length)));
  remaining.forEach((node, index) => {
    positions.set(node.id, { x: (index % resourceColumns) * 210, y: resourceY + Math.floor(index / resourceColumns) * 170 });
  });
  return positions;
}
