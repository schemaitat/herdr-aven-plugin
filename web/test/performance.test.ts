import { expect, it } from 'vitest';
import { largeGraph } from './fixtures/large-graph.js';
import { projectGraph, VISIBLE_NODE_CAP } from '../src/graph/state.js';
import { orbitalLayout } from '../src/graph/layout.js';

it('deterministic fixture and cap preserve full relationship/detail discovery', () => {
  const fixture = largeGraph();
  expect(fixture.nodes).toHaveLength(500); expect(fixture.edges).toHaveLength(1000);
  expect(largeGraph()).toEqual(fixture);
  const projected = projectGraph(largeGraph(560), { query: '', kind: 'all', state: 'all' }, new Set());
  expect(projected.nodes).toHaveLength(VISIBLE_NODE_CAP);
  expect(projected.discoveryNodes).toHaveLength(560);
  expect(projected.cappedNodes).toBe(60); expect(projected.allEdges).toHaveLength(1060); expect(projected.omittedRelationships).toBe(60);
  const taskOnly = projectGraph(largeGraph(560), { query: '', kind: 'task', state: 'all' }, new Set());
  expect(taskOnly.cappedNodes).toBe(40); expect(taskOnly.omittedRelationships).toBe(40);
  const searched = projectGraph(largeGraph(560), { query: 'Task 559', kind: 'all', state: 'all' }, new Set());
  expect(searched.nodes.map(node => node.id)).toEqual(['task:559']);
  expect(orbitalLayout(fixture.nodes, fixture.edges)).toEqual(orbitalLayout([...fixture.nodes].reverse(), [...fixture.edges].reverse()));
  expect(new Set([...orbitalLayout(fixture.nodes, fixture.edges).values()].map(point => JSON.stringify(point))).size).toBe(500);
});
