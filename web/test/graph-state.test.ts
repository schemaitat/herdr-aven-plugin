import { describe, expect, test } from 'vitest';
import cytoscape from 'cytoscape';
import { graphFixture as fixture } from './fixtures/graph-snapshot.js';
import { canonicalSelection, projectGraph, stateDescription, toggleEpic } from '../src/graph/state.js';
import { elements } from '../src/graph/elements.js';
import { orbitalLayout } from '../src/graph/layout.js';
import { highlight, syncElements } from '../src/graph/interactions.js';

const filters = { query: '', kind: 'all', state: 'all' };
describe('shared graph/list state', () => {
  test('collapse retains standalone/resources and directed cross-epic boundary evidence', () => {
    const graph = projectGraph(fixture, filters, new Set(['epic:a']));
    expect(graph.nodes.map(node => node.id)).not.toContain('task:a');
    expect(graph.nodes.map(node => node.id)).toContain('task:solo');
    expect(graph.nodes.map(node => node.id)).toContain('pane:unused');
    expect(graph.hiddenTasks).toBe(2);
    expect(graph.hiddenRelationships).toBeGreaterThan(0);
    const summary = graph.edges.find(edge => edge.kind === 'blocks' && edge.source === 'epic:a');
    expect(summary).toMatchObject({ target: 'task:c', summary: true });
    expect(summary?.evidence).toContain(fixture.edges.find(edge => edge.source === 'task:b' && edge.target === 'task:c')!.id);
    const selection = canonicalSelection(graph.edges, summary!.id);
    expect(projectGraph(fixture, filters, new Set()).edges.find(edge => edge.id === selection)).toMatchObject({ source: 'task:b', target: 'task:c' });
    expect(graph.allEdges.filter(edge => edge.kind === 'blocks')).toHaveLength(3);
    expect(projectGraph(fixture, filters, new Set(['epic:a', 'epic:b'])).edges.some(edge => edge.kind === 'blocks' && edge.source === 'epic:a' && edge.target === 'epic:b')).toBe(true);
  });
  test('filters and search have identical node scope; do not invent missing endpoints', () => {
    for (const f of [{ ...filters, query: 'standalone' }, { ...filters, kind: 'agent' }, { ...filters, state: 'active' }, { ...filters, query: 'missing' }]) {
      const graph = projectGraph(fixture, f, new Set());
      const ids = new Set(graph.nodes.map(node => node.id));
      expect(graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
      if (f.query === 'standalone') expect([...ids]).toEqual(['task:solo']);
      if (f.state === 'active') expect([...ids]).toEqual(['task:b']);
    }
    const old = new Set<string>(); const collapsed = toggleEpic(old, 'epic:a');
    expect(old.size).toBe(0);
    expect(toggleEpic(collapsed, 'epic:a').size).toBe(0);
    expect(stateDescription(fixture.nodes.find(node => node.id === 'task:b')!)).toBe('Task status: active');
    expect(stateDescription(fixture.nodes.find(node => node.id === 'agent:b')!)).toBe('Persisted execution state: running');
  });
  test('incremental updates preserve camera, node identity, dragged positions and restore filtered positions', () => {
    const cy = cytoscape({ headless: true });
    const positions = new Map();
    const graph = projectGraph(fixture, filters, new Set());
    const layout = orbitalLayout(graph.nodes, graph.edges);
    try {
      syncElements(cy, elements(graph.nodes, graph.edges), positions, layout);
      const node = cy.getElementById('task:b');
      node.position({ x: 912, y: 567 });
      cy.zoom(0.7); cy.pan({ x: 23, y: 45 });
      syncElements(cy, elements(graph.nodes.map(node => ({ ...node, state: 'changed' })), graph.edges), positions, layout);
      expect(cy.getElementById('task:b')[0]).toBe(node[0]);
      expect(node.position()).toEqual({ x: 912, y: 567 });
      expect(cy.zoom()).toBe(0.7); expect(cy.pan()).toEqual({ x: 23, y: 45 });
      const collapsed = projectGraph(fixture, filters, new Set(['epic:a']));
      syncElements(cy, elements(collapsed.nodes, collapsed.edges), positions, layout);
      syncElements(cy, elements(graph.nodes, graph.edges), positions, layout);
      expect(cy.getElementById('task:b').position()).toEqual({ x: 912, y: 567 });
      expect(cy.edges().length).toBe(graph.edges.length);
      highlight(cy, 'task:b');
      expect(cy.getElementById('task:b').hasClass('selected')).toBe(true);
      expect(cy.getElementById('pane:unused').hasClass('muted')).toBe(true);
      highlight(cy);
      expect(cy.elements('.muted').length).toBe(0);
    } finally { cy.destroy(); }
    expect(cy.destroyed()).toBe(true);
  });
});
