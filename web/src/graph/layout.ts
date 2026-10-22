import type { Entity } from '../../shared/graph.js';
import type { GraphEdge } from './elements.js';
import { CLEARANCE_GAP, nodeRadius } from './physics.js';

export type Position = { x: number; y: number };

/** Seed each evidenced connected component locally, then pack components without overlap. */
export function orbitalLayout(nodes: Entity[], edges: GraphEdge[]): Map<string, Position> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(ordered.map(node => [node.id, node]));
  const adjacent = new Map(ordered.map(node => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.source === edge.target || !adjacent.has(edge.source) || !adjacent.has(edge.target)) continue;
    adjacent.get(edge.source)!.add(edge.target);
    adjacent.get(edge.target)!.add(edge.source);
  }
  const seen = new Set<string>();
  const components: { points: Map<string, Position>; width: number; height: number }[] = [];
  for (const first of ordered) {
    if (seen.has(first.id)) continue;
    const members: string[] = [], queue = [first.id];
    seen.add(first.id);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]; members.push(id);
      for (const neighbor of [...adjacent.get(id)!].sort()) if (!seen.has(neighbor)) {
        seen.add(neighbor); queue.push(neighbor);
      }
    }
    // An epic is the ownership-aware root when one belongs to this component.
    const root = members.filter(id => byId.get(id)!.kind === 'epic').sort()[0] ?? members.sort()[0];
    const distances = new Map([[root, 0]]), frontier = [root];
    for (let index = 0; index < frontier.length; index++) {
      const id = frontier[index];
      for (const neighbor of [...adjacent.get(id)!].sort()) if (!distances.has(neighbor)) {
        distances.set(neighbor, distances.get(id)! + 1); frontier.push(neighbor);
      }
    }
    const rings = new Map<number, string[]>();
    for (const id of members) {
      const distance = distances.get(id)!;
      rings.set(distance, [...(rings.get(distance) ?? []), id]);
    }
    const points = new Map<string, Position>([[root, { x: 0, y: 0 }]]);
    let radius: number = nodeRadius(byId.get(root)!);
    for (const distance of [...rings.keys()].filter(value => value > 0).sort((a, b) => a - b)) {
      const ring = rings.get(distance)!.sort();
      const largest = Math.max(...ring.map(id => nodeRadius(byId.get(id)!)));
      radius = Math.max(radius + largest * 2 + CLEARANCE_GAP + 60, ring.length * (largest * 2 + 48) / (2 * Math.PI));
      ring.forEach((id, index) => {
        const angle = index * Math.PI * 2 / ring.length - Math.PI / 2;
        points.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
      });
    }
    const left = Math.min(...members.map(id => points.get(id)!.x - nodeRadius(byId.get(id)!)));
    const right = Math.max(...members.map(id => points.get(id)!.x + nodeRadius(byId.get(id)!)));
    const top = Math.min(...members.map(id => points.get(id)!.y - nodeRadius(byId.get(id)!)));
    const bottom = Math.max(...members.map(id => points.get(id)!.y + nodeRadius(byId.get(id)!)));
    for (const point of points.values()) { point.x -= left; point.y -= top; }
    components.push({ points, width: right - left, height: bottom - top });
  }
  const result = new Map<string, Position>();
  const area = components.reduce((total, group) => total + (group.width + 120) * (group.height + 120), 0);
  const rowLimit = Math.max(400, Math.sqrt(area) * 1.5);
  let x = 0, y = 0, rowHeight = 0;
  for (const group of components) {
    if (x > 0 && x + group.width > rowLimit) { x = 0; y += rowHeight + 120; rowHeight = 0; }
    for (const [id, point] of group.points) result.set(id, { x: point.x + x, y: point.y + y });
    x += group.width + 120;
    rowHeight = Math.max(rowHeight, group.height);
  }
  return result;
}
