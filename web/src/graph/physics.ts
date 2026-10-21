import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import type { Entity } from '../../shared/graph.js';
import type { GraphEdge } from './elements.js';
import type { Position } from './layout.js';

export const ACTIVATION_MS = 1500;
export const nodeRadius = (node: Pick<Entity, 'kind'>) => node.kind === 'epic' ? 58 : 31;
export function topologyKey(nodes: Entity[], edges: GraphEdge[]) {
  return JSON.stringify([nodes.map(node => [node.id, node.kind]).sort(), edges.map(edge => [edge.id, edge.source, edge.target, edge.kind]).sort()]);
}
const copy = (positions: Map<string, Position>) => new Map([...positions].map(([id, point]) => [id, { ...point }]));
interface Particle extends SimulationNodeDatum { id: string; x: number; y: number; radius: number; anchor: Position }
const finitePoint = (point?: Position): point is Position => Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));

// Deterministic static clearance, also used for reduced motion. Pins always win;
// two overlapping pins are intentionally not "fixed" by moving user geometry.
export function clearOverlaps(nodes: Entity[], positions: Map<string, Position>, pins = new Map<string, Position>()) {
  const result = copy(positions);
  for (const [id, point] of pins) if (result.has(id)) result.set(id, { ...point });
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  for (let pass = 0; pass < 96; pass++) {
    let overlap = false;
    for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i], b = ordered[j], p = result.get(a.id)!, q = result.get(b.id)!;
      const minimum = nodeRadius(a) + nodeRadius(b) + 2;
      let dx = q.x - p.x, dy = q.y - p.y, distance = Math.hypot(dx, dy);
      if (distance >= minimum - 0.01 || pins.has(a.id) && pins.has(b.id)) continue;
      overlap = true;
      if (distance < 0.0001) { dx = 1; dy = 0; distance = 1; }
      const move = (minimum - distance + 0.02) / (pins.has(a.id) || pins.has(b.id) ? 1 : 2);
      if (!pins.has(a.id)) { p.x -= dx / distance * move; p.y -= dy / distance * move; }
      if (!pins.has(b.id)) { q.x += dx / distance * move; q.y += dy / distance * move; }
    }
    if (!overlap) break;
  }
  for (const [id, point] of pins) if (result.has(id)) result.set(id, { ...point });
  return result;
}

export function selectionTargets(nodes: Entity[], edges: GraphEdge[], overview: Map<string, Position>, selected?: string) {
  const result = copy(overview), center = selected && result.get(selected);
  if (!center) return result;
  const neighbors = new Set(edges.flatMap(edge => edge.source === selected ? [edge.target] : edge.target === selected ? [edge.source] : []));
  const ordered = [...neighbors].filter(id => result.has(id)).sort();
  const selectedRadius = nodeRadius(nodes.find(node => node.id === selected)!);
  ordered.forEach((id, index) => {
    const angle = index * Math.PI * 2 / ordered.length - Math.PI / 2;
    const radius = Math.max(selectedRadius + 55, ordered.length * 72 / (2 * Math.PI));
    result.set(id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  });
  return result;
}

/** Deterministic caption-spaced shells for component focus. Pins are applied by the caller. */
export function hopRingTargets(nodes: Entity[], distances: Map<string, number>, anchor: string, fallback: Map<string, Position>) {
  const result = copy(fallback);
  const center = fallback.get(anchor) ?? { x: 0, y: 0 };
  result.set(anchor, { ...center });
  const byId = new Map(nodes.map(node => [node.id, node]));
  const rings = new Map<number, string[]>();
  for (const [id, distance] of distances) if (id !== anchor && fallback.has(id) && byId.has(id)) rings.set(distance, [...(rings.get(distance) ?? []), id]);
  for (const [distance, ids] of rings) {
    ids.sort();
    const largest = Math.max(...ids.map(id => nodeRadius(byId.get(id)!)));
    const radius = Math.max(155 + distance * 175, ids.length * (largest * 2 + 56) / (2 * Math.PI));
    ids.forEach((id, index) => { const angle = index * Math.PI * 2 / ids.length - Math.PI / 2; result.set(id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }); });
  }
  return result;
}

// d3 owns copied particles/links only. Its internal timer is stopped immediately;
// the caller is the sole clock and cannot queue multiple competing animations.
export class GraphPhysics {
  readonly particles: Particle[];
  private simulation;
  private ticks = 0;
  constructor(nodes: Entity[], edges: GraphEdge[], positions: Map<string, Position>, anchors: Map<string, Position>, pins = new Map<string, Position>(), selected?: string, dragging?: string) {
    const neighbors = new Set(edges.flatMap(edge => edge.source === selected ? [edge.target] : edge.target === selected ? [edge.source] : []));
    this.particles = [...nodes].sort((a, b) => a.id.localeCompare(b.id)).map((node, index) => {
      const storedAnchor = anchors.get(node.id), storedPoint = positions.get(node.id), pin = pins.get(node.id);
      const anchor = finitePoint(storedAnchor) ? storedAnchor : { x: index * 140, y: 0 };
      const point = finitePoint(storedPoint) ? storedPoint : anchor;
      const fixed = (finitePoint(pin) ? pin : undefined) ?? (node.id === selected || selected && !neighbors.has(node.id) && node.id !== dragging ? point : undefined);
      return { id: node.id, x: point.x, y: point.y, radius: nodeRadius(node), anchor: { ...anchor }, fx: fixed?.x, fy: fixed?.y };
    });
    const byId = new Map(this.particles.map(node => [node.id, node]));
    const links = [...edges].sort((a, b) => a.id.localeCompare(b.id)).filter(edge => byId.has(edge.source) && byId.has(edge.target) && edge.source !== edge.target).map(edge => ({ source: edge.source, target: edge.target }));
    let seed = 0x6d2b79f5;
    this.simulation = forceSimulation(this.particles).stop().randomSource(() => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; })
      .alphaDecay(0.065).velocityDecay(0.48)
      .force('links', forceLink<Particle, { source: string; target: string }>(links).id(node => node.id).distance(link => {
        const source = byId.get(typeof link.source === 'string' ? link.source : (link.source as Particle).id)!;
        const target = byId.get(typeof link.target === 'string' ? link.target : (link.target as Particle).id)!;
        return source.radius + target.radius + (selected && (source.id === selected || target.id === selected) ? 25 : 90);
      }).strength(selected ? 0.3 : 0.16))
      .force('charge', forceManyBody<Particle>().strength(-140).distanceMax(350).theta(0.9))
      .force('collision', forceCollide<Particle>().radius(node => node.radius + 2).iterations(2))
       .force('x', forceX<Particle>(node => node.anchor.x).strength(0.035))
       .force('y', forceY<Particle>(node => node.anchor.y).strength(0.035));
  }
  tick() {
    const previous = this.particles.map(node => ({ x: node.x, y: node.y }));
    this.simulation.tick(); this.ticks++;
    this.particles.forEach((node, index) => {
      if (node.fx != null && node.fy != null) { node.x = node.fx; node.y = node.fy; node.vx = node.vy = 0; return; }
      const dx = node.x - previous[index].x, dy = node.y - previous[index].y;
      const factor = Math.min(1, 12 / (Math.hypot(dx, dy) || 1));
      node.x = previous[index].x + dx * factor; node.y = previous[index].y + dy * factor;
      node.vx = (node.vx ?? 0) * factor; node.vy = (node.vy ?? 0) * factor;
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) { node.x = node.anchor.x; node.y = node.anchor.y; node.vx = node.vy = 0; }
    });
    return this.ticks > 16 && this.simulation.alpha() < 0.015 && this.particles.every(node => Math.hypot(node.vx ?? 0, node.vy ?? 0) < 0.08);
  }
  positions() { return new Map(this.particles.map(node => [node.id, { x: node.x, y: node.y }])); }
  drag(id: string, point: Position) {
    const node = this.particles.find(node => node.id === id);
    if (!node || !finitePoint(point)) return;
    node.x = node.fx = point.x; node.y = node.fy = point.y; node.vx = node.vy = 0;
    this.ticks = 0; this.simulation.alpha(1);
  }
  stop() { this.simulation.stop(); for (const node of this.particles) node.vx = node.vy = 0; }
}

export interface FrameClock { now: () => number; request: (callback: FrameRequestCallback) => number; cancel: (frame: number) => void }
export class MotionScheduler {
  private frame?: number;
  private deadline = 0;
  private step?: () => boolean;
  private finish?: () => void;
  private hidden = false;
  private stepsPerFrame = 2;
  constructor(private clock: FrameClock, private paint: () => void) {}
  start(step: () => boolean, finish: () => void, stepsPerFrame = 2) {
    this.cancel(); this.step = step; this.finish = finish; this.stepsPerFrame = Math.max(1, Math.min(2, stepsPerFrame)); this.deadline = this.clock.now() + ACTIVATION_MS; this.schedule();
  }
  private schedule() {
    if (!this.hidden && this.step && this.frame === undefined) this.frame = this.clock.request(() => {
      this.frame = undefined;
      let settled = this.clock.now() >= this.deadline;
      for (let i = 0; i < this.stepsPerFrame && !settled; i++) settled = this.step!();
      if (settled) { const finish = this.finish; this.cancel(); finish?.(); }
      this.paint(); this.schedule();
    });
  }
  visibility(hidden: boolean) {
    this.hidden = hidden;
    if (hidden && this.frame !== undefined) { this.clock.cancel(this.frame); this.frame = undefined; }
    else this.schedule();
  }
  cancel() { if (this.frame !== undefined) this.clock.cancel(this.frame); this.frame = undefined; this.step = undefined; this.finish = undefined; }
  interact() { if (this.step) this.deadline = this.clock.now() + ACTIVATION_MS; }
  get active() { return Boolean(this.step); }
}
