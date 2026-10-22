import { describe, expect, test } from 'vitest';
import type { Entity, NodeKind } from '../shared/graph.js';
import type { GraphEdge } from '../src/graph/elements.js';
import { crossingPairs, layoutMetrics, overlapPairs, rankViolations, segments, totalEdgeLength } from '../src/graph/layout-metrics.js';
import { layoutFixtures } from './fixtures/small-graphs.js';

const entity = (id: string, kind: NodeKind): Entity => ({ id, kind, label: id, state: 'todo', details: {}, provenance: [] });
const edge = (id: string, kind: GraphEdge['kind'], source: string, target: string): GraphEdge => ({ id, kind, source, target, provenance: [] });
const positions = (entries: Record<string, [number, number]>) => new Map(Object.entries(entries).map(([id, [x, y]]) => [id, { x, y }]));

describe('deterministic layout metrics', () => {
  test('counts proper crossings and collinear overlaps but never shared endpoints', () => {
    const crossing = positions({ a: [0, 0], b: [10, 10], c: [0, 10], d: [10, 0] });
    const edges = [edge('ab', 'blocks', 'a', 'b'), edge('cd', 'blocks', 'c', 'd')];
    expect(crossingPairs(edges, crossing)).toEqual([['ab', 'cd']]);
    expect(crossingPairs([...edges].reverse(), crossing)).toEqual([['ab', 'cd']]);
    const shared = positions({ a: [0, 0], b: [10, 10], c: [10, 0] });
    expect(crossingPairs([edge('ab', 'blocks', 'a', 'b'), edge('ac', 'related', 'a', 'c')], shared)).toEqual([]);
    const parallel = positions({ a: [0, 0], b: [10, 0], c: [0, 5], d: [10, 5] });
    expect(crossingPairs([edge('ab', 'blocks', 'a', 'b'), edge('cd', 'blocks', 'c', 'd')], parallel)).toEqual([]);
    const overlap = positions({ a: [0, 0], b: [10, 0], c: [2, 0], d: [8, 0] });
    expect(crossingPairs([edge('ab', 'blocks', 'a', 'b'), edge('cd', 'blocks', 'c', 'd')], overlap)).toEqual([['ab', 'cd']]);
  });

  test('ignores missing endpoints, self-edges and non-finite geometry deterministically', () => {
    const points = positions({ a: [0, 0], b: [10, 10] });
    points.set('bad', { x: Number.NaN, y: 2 });
    const edges = [edge('self', 'related', 'a', 'a'), edge('missing', 'blocks', 'a', 'zzz'), edge('bad', 'blocks', 'a', 'bad'), edge('ab', 'blocks', 'a', 'b')];
    expect(segments(edges, points).map(segment => segment.id)).toEqual(['ab']);
    expect(layoutMetrics([entity('a', 'task'), entity('b', 'task')], edges, points).crossings).toBe(0);
  });

  test('sums straight-line length and reports rank-direction violations by kind and by position', () => {
    const nodes = [entity('epic', 'epic'), entity('task', 'task'), entity('agent', 'agent')];
    const edges = [edge('contains', 'contains', 'epic', 'task'), edge('assigned', 'assigned', 'task', 'agent'), edge('related', 'related', 'agent', 'epic')];
    expect(totalEdgeLength(edges, positions({ epic: [0, 0], task: [0, 100], agent: [0, 200] }))).toBe(400);
    expect(rankViolations(nodes, edges, positions({ epic: [0, 0], task: [0, 100], agent: [0, 200] }))).toEqual([]);
    // A child drawn back inside its parent's ring is a radial position violation.
    expect(rankViolations(nodes, edges, positions({ epic: [0, 0], task: [100, 0], agent: [0, 0] }))).toEqual(['assigned']);
    // A data reversal no geometry can fix is still reported.
    expect(rankViolations([entity('task', 'task'), entity('epic', 'epic')], [edge('flip', 'contains', 'task', 'epic')], positions({ task: [0, 0], epic: [0, 100] }))).toEqual(['flip']);
  });

  test('overlap pairs use drawn radii plus clearance and ignore unpositioned nodes', () => {
    const nodes = [entity('epic', 'epic'), entity('task', 'task')];
    expect(overlapPairs(nodes, positions({ epic: [0, 0], task: [110, 0] }))).toEqual([]);
    expect(overlapPairs(nodes, positions({ epic: [0, 0], task: [30, 0] }))).toEqual([['epic', 'task']]);
    expect(overlapPairs(nodes, positions({ epic: [0, 0] }))).toEqual([]);
  });

  test('aggregate metrics are input-order independent', () => {
    const nodes = [entity('epic', 'epic'), entity('task', 'task'), entity('agent', 'agent')];
    const edges = [edge('contains', 'contains', 'epic', 'task'), edge('assigned', 'assigned', 'task', 'agent')];
    const points = positions({ epic: [50, 0], task: [0, 100], agent: [100, 200] });
    const forward = layoutMetrics(nodes, edges, points);
    expect(layoutMetrics([...nodes].reverse(), [...edges].reverse(), new Map([...points].reverse()))).toEqual(forward);
    expect(forward).toMatchObject({ overlaps: 0, rankViolations: 0 });
  });
});

describe('readability fixtures', () => {
  test('primary fixtures stay in the ≤50-node readability target and resolve every endpoint', () => {
    const primary = layoutFixtures.filter(fixture => fixture.name !== 'large');
    expect(primary.map(fixture => fixture.name)).toEqual(['graph', 'single-epic', 'two-epics', 'mixed']);
    for (const { name, snapshot } of primary) {
      expect(snapshot.nodes.length, name).toBeLessThanOrEqual(50);
      const ids = new Set(snapshot.nodes.map(node => node.id));
      expect(snapshot.edges.every(relation => ids.has(relation.source) && ids.has(relation.target)), name).toBe(true);
      expect(new Set(snapshot.nodes.map(node => node.kind)).size, name).toBeGreaterThanOrEqual(5);
      expect(snapshot.edges.some(relation => relation.kind === 'blocks'), name).toBe(true);
      expect(snapshot.edges.some(relation => relation.kind === 'contains'), name).toBe(true);
    }
    expect(layoutFixtures.find(fixture => fixture.name === 'large')!.snapshot.nodes).toHaveLength(500);
  });
});
