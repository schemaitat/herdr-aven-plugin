import { describe, expect, test } from 'vitest';
import type { Entity } from '../shared/graph.js';
import { searchEntities, searchScore } from '../src/graph/search.js';
import { ALL_TYPES, defaultFilters, projectGraph } from '../src/graph/state.js';
import { graphFixture } from './fixtures/graph-snapshot.js';
import { largeGraph } from './fixtures/large-graph.js';

const entity = (id: string, label: string, ref = ''): Entity => ({ ...graphFixture.nodes[0]!, id, label, details: { ref } });
describe('bounded deterministic fuzzy search', () => {
  test('exact then prefix then subsequence, with stable ID ties independent of input order', () => {
    const nodes = [entity('z', 'A very big cat'), entity('b', 'abc extra'), entity('a', 'ABC'), entity('c', 'abc extra')];
    expect(searchEntities(nodes, 'abc').map(node => node.id)).toEqual(['a', 'b', 'c', 'z']);
    expect(searchEntities([...nodes].reverse(), 'ABC').map(node => node.id)).toEqual(['a', 'b', 'c', 'z']);
  });
  test('label, ref and id are searchable; multiword, whitespace, empty and no matches', () => {
    const nodes = [entity('task:one', 'Build the graph', 'APP-123'), entity('task:two', 'Other')];
    for (const query of ['bd gh', ' APP-123 ', 'TASK:ONE']) expect(searchEntities(nodes, query).map(node => node.id)).toEqual(['task:one']);
    expect(searchEntities(nodes, ' \t ')).toHaveLength(2);
    expect(searchEntities(nodes, 'xyz')).toEqual([]);
    expect(searchScore(entity('id', 'a'.repeat(4096) + 'z'), 'z')).toBeUndefined();
  });
  test('canvas is capped while the matching list is complete and ordered identically', () => {
    const snapshot = largeGraph(560);
    const graph = projectGraph(snapshot, { ...defaultFilters(), query: 't', kinds: new Set(ALL_TYPES) }, new Set(), Date.parse(snapshot.observedAt));
    expect(graph.discoveryNodes).toEqual(searchEntities(snapshot.nodes, 't'));
    expect(graph.nodes).toEqual(graph.discoveryNodes.slice(0, 500));
    expect(graph.cappedNodes).toBe(graph.discoveryNodes.length - 500);
  });
});
