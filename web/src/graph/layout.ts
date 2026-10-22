import type { Entity, NodeKind } from '../../shared/graph.js';
import type { GraphEdge, RelationKind } from './elements.js';
import { clearOverlaps, nodeRadius } from './physics.js';

export type Position = { x: number; y: number };

/** Radial readability order: ownership at the centre, resources on the outer rings. */
export const KIND_RANK = {
  epic: 0, task: 1, attempt: 2, agent: 3, session: 4, pane: 5, worktree: 5, workspace: 6, boundary: 6,
} as const satisfies Record<NodeKind, number>;

export const kindRank = (node: Pick<Entity, 'kind'>) => KIND_RANK[node.kind];

// Visual tuning is for the primary ≤50-node component case; the 500-node graph is
// only a guardrail. Gaps are measured between drawn circles, never centre-to-centre.
const SIBLING_GAP = 40, GROUP_GAP = 28, BAND_GAP = 56, COMPONENT_GAP = 90;

/** Barycenter weights: containment keeps epic groups together, blockers next. */
const ORDER_WEIGHT: Partial<Record<RelationKind, number>> = {
  contains: 8, blocks: 4, 'agent-dependency': 4, assigned: 2, session: 1.5, 'placed-in': 1, worktree: 1,
};
/** Same-rank edges whose direction orders siblings left-to-right. */
const ORDERING_KINDS: ReadonlySet<RelationKind> = new Set(['blocks', 'agent-dependency']);
/** Edges that express ownership/execution hierarchy for grouping and rank direction. */
const HIERARCHICAL: ReadonlySet<RelationKind> = new Set(['contains', 'assigned', 'session', 'placed-in', 'worktree']);
const ORDER_PASSES = 16;

interface Component { ids: string[]; ranks: number[]; order: Map<number, string[]>; rootOf: (id: string) => string }

const byIdOrder = (a: string, b: string) => a.localeCompare(b);
const radiusOf = (id: string, byId: Map<string, Entity>) => nodeRadius(byId.get(id)!);

/** Ownership/grouping parent: the lowest-ranked hierarchy parent, first by edge id. */
function ownershipParents(edges: GraphEdge[], byId: Map<string, Entity>) {
  const parents = new Map<string, string>();
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!HIERARCHICAL.has(edge.kind)) continue;
    const parent = byId.get(edge.source), child = byId.get(edge.target);
    if (!parent || !child || kindRank(parent) >= kindRank(child)) continue;
    const current = parents.has(child.id) ? byId.get(parents.get(child.id)!) : undefined;
    if (!current || kindRank(parent) < kindRank(current)) parents.set(child.id, parent.id);
  }
  return parents;
}

/**
 * Deterministic longest-path levels for same-rank ordering edges. Kahn-style
 * ready sets keep DAG order stable; a same-rank cycle is broken by taking the
 * smallest remaining id. This changes ordering only — rendered arrows still show
 * source-truth direction.
 */
function sameRankLevels(ids: string[], edges: GraphEdge[]): Map<string, number> {
  const band = new Set(ids);
  const incoming = new Map(ids.map(id => [id, new Set<string>()]));
  for (const edge of edges) {
    if (!ORDERING_KINDS.has(edge.kind) || edge.source === edge.target) continue;
    if (band.has(edge.source) && band.has(edge.target)) incoming.get(edge.target)!.add(edge.source);
  }
  const levels = new Map<string, number>(), remaining = new Set(ids);
  while (remaining.size) {
    const ready = [...remaining].filter(id => [...incoming.get(id)!].every(source => !remaining.has(source))).sort(byIdOrder);
    for (const id of ready.length ? ready : [[...remaining].sort(byIdOrder)[0]!]) {
      if (!remaining.has(id)) continue;
      const parents = [...incoming.get(id)!].filter(source => levels.has(source));
      levels.set(id, parents.length ? Math.max(...parents.map(source => levels.get(source)! + 1)) : 0);
      remaining.delete(id);
    }
  }
  return levels;
}

/** Rank bands, grouped by ownership root, ordered by weighted barycenter sweeps. */
function orderComponent(ids: string[], edges: GraphEdge[], byId: Map<string, Entity>, parents: Map<string, string>): Component {
  const cache = new Map<string, string>();
  const rootOf = (id: string) => {
    if (cache.has(id)) return cache.get(id)!;
    const trail: string[] = [];
    let current = id;
    while (parents.has(current) && !cache.has(current) && !trail.includes(current)) { trail.push(current); current = parents.get(current)!; }
    const root = cache.get(current) ?? current;
    for (const item of trail) cache.set(item, root);
    return root;
  };
  const ranks = [...new Set(ids.map(id => kindRank(byId.get(id)!)))].sort((a, b) => a - b);
  const roots = [...new Set(ids.map(rootOf))].sort((a, b) => (kindRank(byId.get(a)!) - kindRank(byId.get(b)!)) || byIdOrder(a, b));
  const order = new Map<number, string[]>(ranks.map(rank => [rank, ids.filter(id => kindRank(byId.get(id)!) === rank)]));
  const levels = new Map<string, number>();
  for (const rank of ranks) for (const [id, level] of sameRankLevels(order.get(rank)!, edges)) levels.set(id, level);

  const groupIndex = () => new Map(roots.map((root, index) => [root, index]));
  const sortBand = (rank: number, score: (id: string) => number) => {
    const ranking = groupIndex();
    order.get(rank)!.sort((a, b) => (ranking.get(rootOf(a))! - ranking.get(rootOf(b))!) ||
      (levels.get(a)! - levels.get(b)!) || (score(a) - score(b)) || byIdOrder(a, b));
  };
  // Grouping first, then same-rank flow, then id: the deterministic baseline that
  // every sweep starts from regardless of input order.
  for (const rank of ranks) sortBand(rank, () => 0);

  const neighbours = new Map(ids.map(id => [id, [] as { id: string; weight: number }[]]));
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const weight = ORDER_WEIGHT[edge.kind];
    if (!weight || edge.source === edge.target) continue;
    if (!neighbours.has(edge.source) || !neighbours.has(edge.target)) continue;
    neighbours.get(edge.source)!.push({ id: edge.target, weight });
    neighbours.get(edge.target)!.push({ id: edge.source, weight });
  }
  const fractions = () => {
    const result = new Map<string, number>();
    for (const rank of ranks) {
      const list = order.get(rank)!;
      list.forEach((id, index) => result.set(id, list.length > 1 ? index / (list.length - 1) : 0.5));
    }
    return result;
  };
  for (let pass = 0; pass < ORDER_PASSES; pass++) {
    const down = pass % 2 === 0, x = fractions();
    const sweep = down ? ranks : [...ranks].reverse();
    for (const rank of sweep) sortBand(rank, id => {
      let total = 0, weight = 0;
      for (const neighbour of neighbours.get(id)!) { total += x.get(neighbour.id)! * neighbour.weight; weight += neighbour.weight; }
      return weight ? total / weight : x.get(id)!;
    });
    // Upward sweeps let columns trade places while groups stay contiguous.
    if (!down && roots.length > 1) {
      const x2 = fractions();
      const score = (root: string) => {
        const members = ids.filter(id => rootOf(id) === root && kindRank(byId.get(id)!) > 0);
        return members.length ? members.reduce((sum, id) => sum + x2.get(id)!, 0) / members.length : x2.get(root)!;
      };
      roots.sort((a, b) => (score(a) - score(b)) || byIdOrder(a, b));
      sortBand(ranks[0]!, id => x2.get(id)!);
    }
  }
  return { ids, ranks, order, rootOf };
}

/** Kind-ranked concentric rings, then component packing without overlap. */
function placeComponent({ ids, ranks, order, rootOf }: Component, byId: Map<string, Entity>) {
  const points = new Map<string, Position>(), radii = new Map<number, number>();
  let previousRadius = 0, previousMax = 0;
  for (const rank of ranks) {
    const list = order.get(rank)!;
    const largest = Math.max(...list.map(id => radiusOf(id, byId)));
    // Even angular slots need enough radius for adjacent drawn circles.
    const circumference = list.length > 1 ? (largest + SIBLING_GAP / 2) / Math.sin(Math.PI / list.length) : 0;
    // A single hub sits at the centre; every other kind gets a ring with radial
    // clearance from the previous ring.
    const radius = rank === ranks[0] ? circumference : Math.max(previousRadius + previousMax + largest + BAND_GAP, circumference);
    radii.set(rank, radius);
    previousRadius = radius; previousMax = largest;
  }
  const angleOf = (id: string) => {
    const position = points.get(id);
    return position && (position.x !== 0 || position.y !== 0) ? Math.atan2(position.y, position.x) : undefined;
  };
  for (const rank of ranks) {
    const list = order.get(rank)!, radius = radii.get(rank)!;
    if (radius === 0) { points.set(list[0]!, { x: 0, y: 0 }); continue; }
    const angles = new Map<string, number>();
    list.forEach((id, index) => angles.set(id, -Math.PI / 2 + Math.PI * 2 * index / list.length));
    // Each ring is rotated so its ownership groups face their root on the inner
    // ring: containment/assignment edges stay short radial spokes.
    if (rank !== ranks[0]) {
      const groups = new Map<string, string[]>();
      for (const id of list) groups.set(rootOf(id), [...(groups.get(rootOf(id)) ?? []), id]);
      let sx = 0, sy = 0, weight = 0;
      for (const [root, members] of groups) {
        const target = angleOf(root);
        if (target === undefined) continue;
        const own = members.reduce((sum, id) => sum + angles.get(id)!, 0) / members.length;
        const delta = target - own;
        sx += Math.cos(delta) * members.length; sy += Math.sin(delta) * members.length; weight += members.length;
      }
      if (weight) {
        const rotation = Math.atan2(sy, sx);
        for (const [id, angle] of angles) angles.set(id, angle + rotation);
      }
    }
    for (const id of list) {
      const angle = angles.get(id)!;
      points.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
  }
  const left = Math.min(...ids.map(id => points.get(id)!.x - radiusOf(id, byId)));
  const right = Math.max(...ids.map(id => points.get(id)!.x + radiusOf(id, byId)));
  const top = Math.min(...ids.map(id => points.get(id)!.y - radiusOf(id, byId)));
  const bottom = Math.max(...ids.map(id => points.get(id)!.y + radiusOf(id, byId)));
  for (const point of points.values()) { point.x -= left; point.y -= top; }
  return { points, width: right - left, height: bottom - top };
}

/**
 * Deterministic kind-ranked radial seed layout: evidenced connected components
 * place epic hubs at the centre and each successive kind (task → attempt → agent
 * → session → pane/worktree → workspace/boundary) on an outer ring. Same-rank
 * blocker order is a longest-path level bounded by a stable cycle break; grouping
 * by ownership keeps an epic's children in one arc facing it. Components are
 * shelf-packed without overlap. Pins, `clearOverlaps` and the d3-force polish
 * consume these seeds unchanged.
 */
export function orbitalLayout(nodes: Entity[], edges: GraphEdge[]): Map<string, Position> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(ordered.map(node => [node.id, node]));
  const adjacent = new Map(ordered.map(node => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.source === edge.target || !adjacent.has(edge.source) || !adjacent.has(edge.target)) continue;
    adjacent.get(edge.source)!.add(edge.target);
    adjacent.get(edge.target)!.add(edge.source);
  }
  const parents = ownershipParents(edges, byId);
  const components: { points: Map<string, Position>; width: number; height: number }[] = [];
  const seen = new Set<string>();
  for (const first of ordered) {
    if (seen.has(first.id)) continue;
    const ids: string[] = [], queue = [first.id];
    seen.add(first.id);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      ids.push(id);
      for (const neighbour of [...adjacent.get(id)!].sort()) if (!seen.has(neighbour)) { seen.add(neighbour); queue.push(neighbour); }
    }
    components.push(placeComponent(orderComponent(ids.sort(byIdOrder), edges, byId, parents), byId));
  }
  const result = new Map<string, Position>();
  const area = components.reduce((total, group) => total + (group.width + COMPONENT_GAP) * (group.height + COMPONENT_GAP), 0);
  const rowLimit = Math.max(400, Math.sqrt(area) * 1.5);
  let x = 0, y = 0, rowHeight = 0;
  for (const group of components) {
    if (x > 0 && x + group.width > rowLimit) { x = 0; y += rowHeight + COMPONENT_GAP; rowHeight = 0; }
    for (const [id, point] of group.points) result.set(id, { x: point.x + x, y: point.y + y });
    x += group.width + COMPONENT_GAP;
    rowHeight = Math.max(rowHeight, group.height);
  }
  return result;
}

/**
 * Radial ranked re-placement of an anchor's one-hop neighbourhood after a drop.
 * Same-kind siblings flank the drop point on the innermost arc; each successive
 * kind rank gets its own radius-aware arc above (lower kinds) or below (higher
 * kinds). Arcs keep the arrangement close without stacking edges on one axis.
 */
export function settleNeighbourhood(nodes: Entity[], edges: GraphEdge[], anchor: string, point: Position, base: Map<string, Position>): Map<string, Position> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const dragged = byId.get(anchor);
  const result = new Map([...base].map(([id, saved]) => [id, { ...saved }] as const));
  if (!dragged || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return result;
  result.set(anchor, { ...point });
  const neighbours = new Set<string>();
  for (const edge of edges) {
    if (edge.source === anchor && byId.has(edge.target)) neighbours.add(edge.target);
    else if (edge.target === anchor && byId.has(edge.source)) neighbours.add(edge.source);
  }
  neighbours.delete(anchor);
  const rank = kindRank(dragged), draggedRadius = nodeRadius(dragged);
  const groups = new Map<number, string[]>();
  for (const id of [...neighbours].sort(byIdOrder)) {
    const value = kindRank(byId.get(id)!);
    groups.set(value, [...(groups.get(value) ?? []), id]);
  }
  const angle = (id: string) => {
    const saved = base.get(id);
    return saved ? Math.atan2(saved.y - point.y, saved.x - point.x) : 0;
  };
  // Spread ids along an arc at `radius`, centred on `centre`, using arc-length
  // spacing so drawn circles never touch.
  const arc = (ids: string[], radius: number, centre: number) => {
    if (!ids.length) return;
    const radii = ids.map(id => nodeRadius(byId.get(id)!));
    const span = radii.reduce((sum, value) => sum + value * 2 + SIBLING_GAP, 0) / radius;
    let cursor = centre - span / 2;
    ids.forEach((id, index) => {
      const value = radii[index]!;
      const position = cursor + (value + SIBLING_GAP / 2) / radius;
      result.set(id, { x: point.x + Math.cos(position) * radius, y: point.y + Math.sin(position) * radius });
      cursor += (value * 2 + SIBLING_GAP) / radius;
    });
  };
  // Same kind: half to the right, half to the left, each ordered top-to-bottom.
  const same = (groups.get(rank) ?? []).sort((a, b) => (base.get(a)!.y - base.get(b)!.y) || byIdOrder(a, b));
  const sameRadius = draggedRadius + SIBLING_GAP + Math.max(0, ...same.map(id => nodeRadius(byId.get(id)!)));
  const half = Math.ceil(same.length / 2);
  arc(same.slice(0, half), sameRadius, 0);
  arc(same.slice(half), sameRadius, Math.PI);
  let edge = draggedRadius + SIBLING_GAP;
  for (const value of [...groups.keys()].filter(item => item > rank).sort((a, b) => a - b)) {
    const ids = groups.get(value)!.sort((a, b) => (base.get(a)!.x - base.get(b)!.x) || byIdOrder(a, b));
    const largest = Math.max(...ids.map(id => nodeRadius(byId.get(id)!)));
    arc(ids, edge + largest, Math.PI / 2);
    edge += largest * 2 + SIBLING_GAP;
  }
  edge = draggedRadius + SIBLING_GAP;
  for (const value of [...groups.keys()].filter(item => item < rank).sort((a, b) => b - a)) {
    const ids = groups.get(value)!.sort((a, b) => (base.get(a)!.x - base.get(b)!.x) || byIdOrder(a, b));
    const largest = Math.max(...ids.map(id => nodeRadius(byId.get(id)!)));
    arc(ids, edge + largest, -Math.PI / 2);
    edge += largest * 2 + SIBLING_GAP;
  }
  // The drop point and every unconnected node are fixed; only neighbours resolve overlaps.
  const fixed = new Map<string, Position>([[anchor, { ...point }]]);
  for (const node of nodes) if (node.id !== anchor && !neighbours.has(node.id)) fixed.set(node.id, { ...result.get(node.id)! });
  return clearOverlaps(nodes, result, fixed);
}
