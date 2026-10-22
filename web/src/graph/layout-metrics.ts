import type { Entity } from '../../shared/graph.js';
import type { GraphEdge, RelationKind } from './elements.js';
import { kindRank, type Position } from './layout.js';
import { nodeRadius } from './physics.js';

/**
 * Deterministic readability measurements for seed layouts. Every function
 * sorts by id first and never depends on argument order, so two layouts with
 * the same geometry always produce the same numbers.
 */
export interface Segment { id: string; source: string; target: string; x1: number; y1: number; x2: number; y2: number }
export interface LayoutMetrics {
  crossings: number;
  edgeLength: number;
  rankViolations: number;
  overlaps: number;
}

/** Hierarchical kinds whose child is expected to sit below its parent. */
export const HIERARCHICAL_KINDS: ReadonlySet<RelationKind> = new Set(['contains', 'assigned', 'session', 'placed-in', 'worktree']);

const finite = (point?: Position): point is Position => Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));

/** Only evidenced edges with both endpoints positioned contribute geometry. */
export function segments(edges: GraphEdge[], positions: Map<string, Position>): Segment[] {
  return [...edges].sort((a, b) => a.id.localeCompare(b.id)).flatMap(edge => {
    if (edge.source === edge.target) return [];
    const source = positions.get(edge.source), target = positions.get(edge.target);
    if (!finite(source) || !finite(target)) return [];
    return [{ id: edge.id, source: edge.source, target: edge.target, x1: source.x, y1: source.y, x2: target.x, y2: target.y }];
  });
}

const orientation = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
const onSegment = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
  Math.min(ax, bx) - 1e-9 <= cx && cx <= Math.max(ax, bx) + 1e-9 && Math.min(ay, by) - 1e-9 <= cy && cy <= Math.max(ay, by) + 1e-9;

/** Proper crossing or collinear overlap; shared endpoints never count. */
export function crosses(a: Segment, b: Segment) {
  if (a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target) return false;
  const ab1 = orientation(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1), ab2 = orientation(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const ba1 = orientation(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1), ba2 = orientation(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  if (Math.sign(ab1) !== Math.sign(ab2) && Math.sign(ba1) !== Math.sign(ba2)) return true;
  if (ab1 === 0 && onSegment(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1)) return true;
  if (ab2 === 0 && onSegment(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2)) return true;
  if (ba1 === 0 && onSegment(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1)) return true;
  if (ba2 === 0 && onSegment(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2)) return true;
  return false;
}

/** Unique crossing pairs in stable edge-id order. */
export function crossingPairs(edges: GraphEdge[], positions: Map<string, Position>): [string, string][] {
  const ordered = segments(edges, positions), pairs: [string, string][] = [];
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
    if (crosses(ordered[i]!, ordered[j]!)) pairs.push([ordered[i]!.id, ordered[j]!.id]);
  }
  return pairs;
}

export const totalEdgeLength = (edges: GraphEdge[], positions: Map<string, Position>) =>
  segments(edges, positions).reduce((sum, segment) => sum + Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1), 0);

/**
 * Component centres for radial reads: the midpoint of each evidenced group's
 * drawn bounds. Kind ranks are expected to sit on increasing radii around it.
 */
export function componentCentres(nodes: Entity[], edges: GraphEdge[], positions: Map<string, Position>) {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id)).filter(node => finite(positions.get(node.id)));
  const adjacent = new Map(ordered.map(node => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (!adjacent.has(edge.source) || !adjacent.has(edge.target) || edge.source === edge.target) continue;
    adjacent.get(edge.source)!.add(edge.target); adjacent.get(edge.target)!.add(edge.source);
  }
  const centres = new Map<string, Position>(), seen = new Set<string>();
  for (const node of ordered) {
    if (seen.has(node.id)) continue;
    const members: string[] = [], queue = [node.id];
    seen.add(node.id);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!; members.push(id);
      for (const next of adjacent.get(id)!) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    // The radial origin is the innermost kind row (normally the epic hub); using
    // drawn bounds would offset sparse rings and fake radius violations.
    const innermost = Math.min(...members.map(id => kindRank(nodes.find(node => node.id === id)!)));
    const anchors = members.filter(id => kindRank(nodes.find(node => node.id === id)!) === innermost).map(id => positions.get(id)!);
    const centre = anchors.length
      ? { x: anchors.reduce((sum, point) => sum + point.x, 0) / anchors.length, y: anchors.reduce((sum, point) => sum + point.y, 0) / anchors.length }
      : { x: (Math.min(...members.map(id => positions.get(id)!.x)) + Math.max(...members.map(id => positions.get(id)!.x))) / 2,
          y: (Math.min(...members.map(id => positions.get(id)!.y)) + Math.max(...members.map(id => positions.get(id)!.y))) / 2 };
    for (const id of members) centres.set(id, centre);
  }
  return centres;
}

/**
 * A hierarchical edge violates direction when its child kind ranks above its
 * parent kind or when the child is drawn closer to the component centre (the
 * radial analog of "above"). Rank-by-kind is checked too because it catches
 * data that no coordinate choice can redeem.
 */
export function rankViolations(nodes: Entity[], edges: GraphEdge[], positions: Map<string, Position>) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const centres = componentCentres(nodes, edges, positions);
  const radius = (id: string) => {
    const point = positions.get(id)!, centre = centres.get(id);
    return point && centre ? Math.hypot(point.x - centre.x, point.y - centre.y) : Number.NaN;
  };
  return [...edges].sort((a, b) => a.id.localeCompare(b.id)).filter(edge => {
    if (!HIERARCHICAL_KINDS.has(edge.kind)) return false;
    const parent = byId.get(edge.source), child = byId.get(edge.target);
    if (!parent || !child) return false;
    if (kindRank(child) < kindRank(parent)) return true;
    const from = radius(edge.source), to = radius(edge.target);
    return Number.isFinite(from) && Number.isFinite(to) && to < from - 1e-6;
  }).map(edge => edge.id);
}

/** Pairs closer than their drawn radii plus the static clearance used by `clearOverlaps`. */
export function overlapPairs(nodes: Entity[], positions: Map<string, Position>, clearance = 2): [string, string][] {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id)), pairs: [string, string][] = [];
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
    const a = ordered[i]!, b = ordered[j]!, p = positions.get(a.id), q = positions.get(b.id);
    if (!finite(p) || !finite(q)) continue;
    if (Math.hypot(q.x - p.x, q.y - p.y) < nodeRadius(a) + nodeRadius(b) + clearance - 1e-6) pairs.push([a.id, b.id]);
  }
  return pairs;
}

export function layoutMetrics(nodes: Entity[], edges: GraphEdge[], positions: Map<string, Position>): LayoutMetrics {
  return {
    crossings: crossingPairs(edges, positions).length,
    edgeLength: totalEdgeLength(edges, positions),
    rankViolations: rankViolations(nodes, edges, positions).length,
    overlaps: overlapPairs(nodes, positions).length,
  };
}
