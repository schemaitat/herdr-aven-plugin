import { describe, expect, test } from 'vitest';
import type { Entity } from '../shared/graph.js';
import { orbitalLayout, settleNeighbourhood } from '../src/graph/layout.js';
import { componentCentres, crossingPairs, layoutMetrics, overlapPairs, rankViolations } from '../src/graph/layout-metrics.js';
import { clearOverlaps, nodeRadius } from '../src/graph/physics.js';
import type { GraphEdge } from '../src/graph/elements.js';
import { layoutFixtures } from './fixtures/small-graphs.js';

/** Orbital-baseline crossings recorded in the Phase-1 ADR on HAP-RDG1. */
const baseline = { graph: 10, 'single-epic': 22, 'two-epics': 28, mixed: 38, large: 42156 } as const;
const fixture = (name: keyof typeof baseline) => layoutFixtures.find(item => item.name === name)!;
const layoutOf = (name: keyof typeof baseline) => {
  const { snapshot } = fixture(name);
  return orbitalLayout(snapshot.nodes, snapshot.edges);
};
const componentIds = (nodes: Entity[], edges: { source: string; target: string }[]) => {
  const adjacent = new Map(nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of edges) if (adjacent.has(edge.source) && adjacent.has(edge.target) && edge.source !== edge.target) {
    adjacent.get(edge.source)!.add(edge.target); adjacent.get(edge.target)!.add(edge.source);
  }
  const seen = new Set<string>(), groups: string[][] = [];
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (seen.has(node.id)) continue;
    const group: string[] = [], queue = [node.id]; seen.add(node.id);
    for (let index = 0; index < queue.length; index++) { const id = queue[index]!; group.push(id); for (const next of adjacent.get(id)!) if (!seen.has(next)) { seen.add(next); queue.push(next); } }
    groups.push(group.sort());
  }
  return groups;
};

describe('kind-ranked radial layout', () => {
  test('keeps every hierarchical child on an outer ring than its parent and one kind per ring', () => {
    for (const { name, snapshot } of layoutFixtures) {
      const layout = layoutOf(name as keyof typeof baseline);
      expect(rankViolations(snapshot.nodes, snapshot.edges, layout), name).toEqual([]);
      const centres = componentCentres(snapshot.nodes, snapshot.edges, layout);
      for (const group of componentIds(snapshot.nodes, snapshot.edges)) {
        const rings = new Map<string, number[]>();
        for (const id of group) {
          const node = snapshot.nodes.find(candidate => candidate.id === id)!;
          const point = layout.get(id)!, centre = centres.get(id)!;
          rings.set(node.kind, [...(rings.get(node.kind) ?? []), Math.hypot(point.x - centre.x, point.y - centre.y)]);
        }
        for (const [kind, values] of rings) for (const radius of values) expect(radius, `${name}:${kind}`).toBeCloseTo(values[0]!, 6);
      }
    }
  });

  test('strictly beats the recorded orbital crossing baseline on every fixture', () => {
    const crossings = Object.fromEntries(Object.keys(baseline).map(name => [name, crossingPairs(fixture(name as keyof typeof baseline).snapshot.edges, layoutOf(name as keyof typeof baseline)).length]));
    for (const [name, count] of Object.entries(crossings)) expect(count, name).toBeLessThan(baseline[name as keyof typeof baseline]);
    // Regression ceilings for the primary ≤50-node target and the 500-node guardrail.
    expect(crossings).toMatchObject({ graph: 3, 'single-epic': 11, 'two-epics': 8, mixed: 13 });
    expect(crossings.large).toBeLessThanOrEqual(1500);
  });

  test('groups an epic\'s tasks into one arc and orders sibling tasks by blockers', () => {
    const { snapshot } = fixture('two-epics'), layout = layoutOf('two-epics');
    const centres = componentCentres(snapshot.nodes, snapshot.edges, layout);
    const centre = centres.get('epic:alpha')!;
    const angle = (id: string) => { const point = layout.get(id)!; return Math.atan2(point.y - centre.y, point.x - centre.x); };
    const alpha = ['task:a1', 'task:a2', 'task:a3'].map(angle), beta = ['task:b1', 'task:b2', 'task:b3'].map(angle);
    const epicRadius = (id: string) => { const point = layout.get(id)!; return Math.hypot(point.x - centre.x, point.y - centre.y); };
    for (const id of ['task:a1', 'task:a2', 'task:a3']) expect(epicRadius(id)).toBeGreaterThan(epicRadius('epic:alpha'));
    for (const id of ['task:b1', 'task:b2', 'task:b3']) expect(epicRadius(id)).toBeGreaterThan(epicRadius('epic:beta'));
    // Each epic's tasks form exactly one contiguous arc around the shared centre.
    const ordered = [...alpha.map(value => ({ value, epic: 'a' })), ...beta.map(value => ({ value, epic: 'b' }))].sort((a, b) => a.value - b.value);
    const transitions = ordered.filter((entry, index) => entry.epic !== ordered[(index + 1) % ordered.length]!.epic).length;
    expect(transitions).toBe(2);
    // A same-rank blocks cycle must still order deterministically.
    expect(layout.get('task:a2')!).not.toEqual(layout.get('task:a3')!);
    expect(layoutOf('two-epics')).toEqual(layout);
  });

  test('is deterministic, input-order independent and unaffected by status/labels', () => {
    for (const { name, snapshot } of layoutFixtures) {
      const layout = layoutOf(name as keyof typeof baseline);
      expect(orbitalLayout([...snapshot.nodes].reverse(), [...snapshot.edges].reverse()), name).toEqual(layout);
      const relabelled = snapshot.nodes.map(node => ({ ...node, label: 'changed', state: 'done' }));
      expect(orbitalLayout(relabelled, snapshot.edges), name).toEqual(layout);
    }
  });

  test('has no overlaps after clearOverlaps, keeps pins and 500 unique positions', () => {
    for (const { name, snapshot } of layoutFixtures) {
      const seeds = layoutOf(name as keyof typeof baseline);
      expect(overlapPairs(snapshot.nodes, seeds), name).toEqual([]);
      const cleared = clearOverlaps(snapshot.nodes, seeds);
      expect(overlapPairs(snapshot.nodes, cleared), name).toEqual([]);
      const pinned = new Map([[snapshot.nodes[0]!.id, { x: 9, y: 7 }]]);
      expect(clearOverlaps(snapshot.nodes, seeds, pinned).get(snapshot.nodes[0]!.id)).toEqual({ x: 9, y: 7 });
    }
    const large = layoutOf('large');
    expect(new Set([...large.values()].map(point => JSON.stringify(point))).size).toBe(500);
  });

  test('lays out the 500-node guardrail inside the initial-interactivity budget', () => {
    const { snapshot } = fixture('large');
    const start = performance.now();
    const layout = orbitalLayout(snapshot.nodes, snapshot.edges);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(layout.size).toBe(500);
    expect(layoutMetrics(snapshot.nodes, snapshot.edges, layout)).toMatchObject({ rankViolations: 0, overlaps: 0 });
    expect([...layout.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });
});

describe('drop settlement around a dragged node', () => {
  const entity = (id: string, kind: Entity['kind']): Entity => ({ id, kind, label: id, state: 'todo', details: {}, provenance: [] });
  const nodes = [entity('epic:e', 'epic'), entity('task:t', 'task'), entity('task:s1', 'task'), entity('task:s2', 'task'),
    entity('attempt:at', 'attempt'), entity('agent:a', 'agent'), entity('task:unrelated', 'task')];
  const edge = (id: string, kind: GraphEdge['kind'], source: string, target: string): GraphEdge => ({ id, kind, source, target, provenance: [] });
  const edges = [edge('e1', 'contains', 'epic:e', 'task:t'), edge('e2', 'blocks', 'task:s1', 'task:t'),
    edge('e3', 'blocks', 'task:t', 'task:s2'), edge('e4', 'assigned', 'task:t', 'attempt:at'),
    edge('e5', 'contains', 'attempt:at', 'agent:a')];
  // Keep unconnected nodes well away so the drop arcs are not wedged between pins.
  const base = new Map(nodes.map((node, index) => [node.id, { x: index * 220, y: -600 }]));
  const point = { x: 1200, y: 800 };

  test('keeps connected kinds ranked around the drop and everything else fixed', () => {
    const settled = settleNeighbourhood(nodes, edges, 'task:t', point, base);
    expect(settled.get('task:t')).toEqual(point);
    expect(settled.get('task:unrelated')).toEqual(base.get('task:unrelated'));
    expect(settled.get('epic:e')!.y).toBeLessThan(point.y);
    expect(settled.get('task:s1')!.y).toBe(point.y);
    expect(settled.get('task:s2')!.y).toBe(point.y);
    expect(settled.get('attempt:at')!.y).toBeGreaterThan(point.y);
    // Two-hop nodes are not dragged along and keep their pre-drop position.
    expect(settled.get('agent:a')).toEqual(base.get('agent:a'));
    for (const id of ['epic:e', 'task:s1', 'task:s2', 'attempt:at']) {
      expect(Math.hypot(settled.get(id)!.x - point.x, settled.get(id)!.y - point.y), id).toBeLessThan(600);
    }
    expect(overlapPairs(nodes, settled)).toEqual([]);
    expect(settleNeighbourhood([...nodes].reverse(), [...edges].reverse(), 'task:t', point, new Map([...base].reverse()))).toEqual(settled);
  });
});
