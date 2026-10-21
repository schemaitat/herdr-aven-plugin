import { expect, it } from 'vitest';
import { largeGraph } from './fixtures/large-graph.js';
import { ALL_TYPES, defaultFilters, projectGraph, VISIBLE_NODE_CAP } from '../src/graph/state.js';
import { orbitalLayout } from '../src/graph/layout.js';

it('deterministic fixture and cap preserve full relationship/detail discovery', () => {
  const fixture = largeGraph();
  expect(fixture.nodes).toHaveLength(500); expect(fixture.edges).toHaveLength(1000);
  expect(largeGraph()).toEqual(fixture);
  const filters = { ...defaultFilters(), kinds: new Set(ALL_TYPES) };
  const now = Date.parse('2026-10-20T12:00:00Z');
  const projected = projectGraph(largeGraph(560), filters, new Set(), now);
  expect(projected.nodes).toHaveLength(VISIBLE_NODE_CAP);
  expect(projected.discoveryNodes).toHaveLength(560);
  expect(projected.cappedNodes).toBe(60); expect(projected.allEdges).toHaveLength(1060); expect(projected.omittedRelationships).toBe(60);
  expect(projected.eligibleGraph.nodes).toHaveLength(560);
  expect(projected.eligibleGraph.edges).toHaveLength(1060);
  const component = projectGraph(largeGraph(560), filters, new Set(), now, 'task:559');
  expect(component.componentAvailable).toBe(true);
  expect(component.eligibleGraph.nodes.map(node => node.id)).toContain('task:559');
  expect(component.discoveryNodes.length).toBeGreaterThan(500);
  const taskOnly = projectGraph(largeGraph(560), { ...defaultFilters(), kinds: new Set(['task']) }, new Set(), now);
  expect(taskOnly.cappedNodes).toBe(40); expect(taskOnly.omittedRelationships).toBe(40);
  const searched = projectGraph(largeGraph(560), { ...filters, query: 'Task 559' }, new Set(), now);
  expect(searched.nodes.map(node => node.id)).toEqual(['task:559']);
  expect(orbitalLayout(fixture.nodes, fixture.edges)).toEqual(orbitalLayout([...fixture.nodes].reverse(), [...fixture.edges].reverse()));
  expect(new Set([...orbitalLayout(fixture.nodes, fixture.edges).values()].map(point => JSON.stringify(point))).size).toBe(500);
});
