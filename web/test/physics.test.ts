import { describe, expect, test } from 'vitest';
import { ACTIVATION_MS, clearOverlaps, GraphPhysics, MotionScheduler, nodeRadius, selectionTargets, topologyKey, type FrameClock } from '../src/graph/physics.js';
import { orbitalLayout } from '../src/graph/layout.js';
import { relationships } from '../src/graph/elements.js';
import { graphFixture } from './fixtures/graph-snapshot.js';
import { largeGraph } from './fixtures/large-graph.js';

const nodes = graphFixture.nodes.filter(node => ['task:a', 'task:b', 'task:solo'].includes(node.id));
const edges = relationships(graphFixture).filter(edge => nodes.some(node => node.id === edge.source) && nodes.some(node => node.id === edge.target));
const baseline = new Map([['task:a', { x: 0, y: 0 }], ['task:b', { x: 400, y: 0 }], ['task:solo', { x: 1500, y: 0 }]]);
function run(solver: GraphPhysics, count = 120) { for (let i = 0; i < count; i++) solver.tick(); return solver.positions(); }

describe('copied, seeded bounded forces', () => {
  test('relationship springs contract the selected neighborhood, unrelated positions remain exact, no source mutation', () => {
    const before = structuredClone({ nodes, edges });
    const solver = new GraphPhysics(nodes, edges, baseline, selectionTargets(nodes, edges, baseline, 'task:a'), new Map(), 'task:a');
    const result = run(solver);
    expect(result.get('task:a')).toEqual(baseline.get('task:a'));
    expect(result.get('task:solo')).toEqual(baseline.get('task:solo'));
    expect(result.get('task:b')!.x).toBeLessThan(250);
    expect({ nodes, edges }).toEqual(before);
    solver.stop(); expect(solver.particles.every(node => node.vx === 0 && node.vy === 0)).toBe(true);
  });
  test('many-body repulsion separates close unlinked particles; cooling reaches rest', () => {
    const pair = nodes.slice(0, 2), points = new Map(pair.map((node, i) => [node.id, { x: i * 70, y: 0 }]));
    const solver = new GraphPhysics(pair, [], points, points);
    let cooled = false;
    for (let i = 0; i < 160; i++) cooled ||= solver.tick();
    expect(solver.positions().get(pair[1].id)!.x).toBeGreaterThan(70);
    expect(cooled).toBe(true); solver.stop();
  });
  test('coincident seeds and zero-length edges produce deterministic finite coordinates and clearance', () => {
    const coincident = new Map(nodes.map(node => [node.id, { x: 0, y: 0 }]));
    const a = new GraphPhysics(nodes, edges, coincident, coincident), b = new GraphPhysics(nodes, edges, coincident, coincident);
    const result = run(a); expect(run(b)).toEqual(result);
    expect([...result.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const p = result.get(nodes[i].id)!, q = result.get(nodes[j].id)!;
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(nodeRadius(nodes[i]) + nodeRadius(nodes[j]) - 0.1);
    }
    a.stop(); b.stop();
  });
  test('manual pins take priority over selection, collision, repulsion and anchors, including conflicts', () => {
    const pins = new Map(nodes.map(node => [node.id, { x: 9, y: 7 }]));
    const solver = new GraphPhysics(nodes, edges, baseline, baseline, pins, 'task:a');
    expect(run(solver)).toEqual(pins);
    expect(clearOverlaps(nodes, baseline, pins)).toEqual(pins); solver.stop();
  });
  test('invalid entering coordinates recover to finite deterministic anchors, and speed is bounded', () => {
    const invalid = new Map(nodes.map(node => [node.id, { x: NaN, y: Infinity }]));
    const solver = new GraphPhysics(nodes, edges, invalid, invalid, invalid);
    const before = solver.positions(); solver.tick();
    for (const [id, point] of solver.positions()) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      expect(Math.hypot(point.x - before.get(id)!.x, point.y - before.get(id)!.y)).toBeLessThanOrEqual(12.00001);
    }
    solver.stop();
  });
  test('drag reuses copied particles, follows the pointer exactly and reheats neighbors', () => {
    const solver = new GraphPhysics(nodes, edges, baseline, baseline, new Map(), 'task:a', 'task:a');
    const records = solver.particles;
    run(solver);
    solver.drag('task:a', { x: 600, y: 40 }); const before = solver.positions(); solver.tick();
    expect(solver.particles).toBe(records);
    expect(solver.positions().get('task:a')).toEqual({ x: 600, y: 40 });
    expect(solver.positions().get('task:b')).not.toEqual(before.get('task:b'));
    expect(baseline.get('task:a')).toEqual({ x: 0, y: 0 }); solver.stop();
  });
  test('connected groups have deterministic geometry and the large fixture has clearance', () => {
    const fixture = largeGraph(), links = relationships(fixture), anchors = orbitalLayout(fixture.nodes, links);
    const solver = new GraphPhysics(fixture.nodes, links, anchors, anchors);
    const result = clearOverlaps(fixture.nodes, run(solver));
    expect(orbitalLayout([...fixture.nodes].reverse(), [...links].reverse())).toEqual(anchors);
    expect(result.size).toBe(fixture.nodes.length);
    for (let i = 0; i < fixture.nodes.length; i++) for (let j = i + 1; j < fixture.nodes.length; j++) {
      const a = fixture.nodes[i], b = fixture.nodes[j], p = result.get(a.id)!, q = result.get(b.id)!;
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(nodeRadius(a) + nodeRadius(b) - 0.1);
    }
    solver.stop();
  });
  test('scoped edges, not hidden canonical edges, determine component seeds and force distances', () => {
    const local = orbitalLayout(nodes, edges);
    const nearby = Math.hypot(local.get('task:a')!.x - local.get('task:b')!.x, local.get('task:a')!.y - local.get('task:b')!.y);
    const unrelated = Math.hypot(local.get('task:a')!.x - local.get('task:solo')!.x, local.get('task:a')!.y - local.get('task:solo')!.y);
    expect(nearby).toBeLessThan(unrelated);
    const fixture = largeGraph();
    const linked = relationships(fixture);
    const withLinks = orbitalLayout(fixture.nodes, linked);
    const withoutLinks = orbitalLayout(fixture.nodes, []);
    expect(orbitalLayout([...fixture.nodes].reverse(), [...linked].reverse())).toEqual(withLinks);
    expect(withLinks).not.toEqual(withoutLinks);
    const isolated = clearOverlaps(fixture.nodes, withoutLinks);
    for (let i = 0; i < fixture.nodes.length; i++) for (let j = i + 1; j < fixture.nodes.length; j++) {
      const a = fixture.nodes[i], b = fixture.nodes[j], p = isolated.get(a.id)!, q = isolated.get(b.id)!;
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(nodeRadius(a) + nodeRadius(b) - .1);
    }
  });
  test('dense coincident mixed bodies separate without moving an explicit pin', () => {
    const fixture = largeGraph(), dense = fixture.nodes.slice(0, 500);
    const seeds = new Map(dense.map(node => [node.id, { x: 0, y: 0 }]));
    const pins = new Map([[dense[0].id, { x: 0, y: 0 }]]);
    const points = clearOverlaps(dense, seeds, pins);
    expect(points.get(dense[0].id)).toEqual(pins.get(dense[0].id));
    for (let i = 0; i < dense.length; i++) for (let j = i + 1; j < dense.length; j++) {
      const a = dense[i], b = dense[j], p = points.get(a.id)!, q = points.get(b.id)!;
      expect(Math.hypot(p.x - q.x, p.y - q.y) - nodeRadius(a) - nodeRadius(b)).toBeGreaterThanOrEqual(-.01);
    }
  });
  test('status, labels, heartbeat and ordering are not topology changes', () => {
    expect(topologyKey(nodes, edges)).toBe(topologyKey([...nodes].reverse().map(node => ({ ...node, label: 'new', state: 'done' })), [...edges].reverse()));
    expect(topologyKey(nodes, edges)).not.toBe(topologyKey(nodes.slice(1), edges));
  });
});

describe('single manually clocked scheduler', () => {
  function clock() {
    let now = 0, id = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const clock: FrameClock = { now: () => now, request: callback => { callbacks.set(++id, callback); return id; }, cancel: frame => { callbacks.delete(frame); } };
    return { clock, callbacks, frame(ms = 16) { now += ms; const current = [...callbacks.values()]; callbacks.clear(); current.forEach(callback => callback(now)); } };
  }
  test('at most two fixed steps and one paint per frame; deadline stops and never catches up', () => {
    const c = clock(); let ticks = 0, paints = 0, finishes = 0;
    const scheduler = new MotionScheduler(c.clock, () => paints++);
    scheduler.start(() => { ticks++; return false; }, () => finishes++);
    c.frame(400); expect(ticks).toBe(2); expect(paints).toBe(1); expect(c.callbacks.size).toBe(1);
    c.frame(ACTIVATION_MS); expect(ticks).toBe(2); expect(finishes).toBe(1); expect(scheduler.active).toBe(false); expect(c.callbacks.size).toBe(0);
  });
  test('new actions replace old targets, cancel leaves no timer, hidden tab discards elapsed time', () => {
    const c = clock(); let stale = 0, current = 0;
    const scheduler = new MotionScheduler(c.clock, () => {});
    scheduler.start(() => { stale++; return false; }, () => stale++);
    scheduler.start(() => { current++; return false; }, () => current++);
    expect(c.callbacks.size).toBe(1); c.frame(); expect(stale).toBe(0); expect(current).toBe(2);
    scheduler.visibility(true); expect(c.callbacks.size).toBe(0);
    c.frame(2000); scheduler.visibility(false); c.frame();
    expect(current).toBe(3); expect(scheduler.active).toBe(false); expect(c.callbacks.size).toBe(0);
    scheduler.start(() => false, () => {}); scheduler.cancel(); expect(c.callbacks.size).toBe(0);
  });
  test('early sleep zeroes scheduling; repeated unchanged-data calls need not touch clock', () => {
    const c = clock(); const scheduler = new MotionScheduler(c.clock, () => {});
    scheduler.start(() => true, () => {}); c.frame();
    expect(scheduler.active).toBe(false); expect(c.callbacks.size).toBe(0);
  });
  test('dense activations can spend one fixed step per frame without changing the deadline', () => {
    const c = clock(); let ticks = 0;
    const scheduler = new MotionScheduler(c.clock, () => {});
    scheduler.start(() => { ticks++; return false; }, () => {}, 1);
    c.frame(); expect(ticks).toBe(1);
    c.frame(ACTIVATION_MS); expect(ticks).toBe(1); expect(scheduler.active).toBe(false);
  });
  test('drag extends only the current deadline without adding a queued animation', () => {
    const c = clock(); let ticks = 0;
    const scheduler = new MotionScheduler(c.clock, () => {});
    scheduler.start(() => { ticks++; return false; }, () => {});
    c.frame(1000); scheduler.interact(); expect(c.callbacks.size).toBe(1);
    c.frame(1000); expect(ticks).toBe(4); expect(scheduler.active).toBe(true);
    c.frame(500); expect(ticks).toBe(4); expect(scheduler.active).toBe(false);
  });
});
