import { describe, expect, test } from 'vitest';
import cytoscape from 'cytoscape';
import { graphFixture as fixture } from './fixtures/graph-snapshot.js';
import { ALL_TYPES, componentMembers, componentResolver, defaultFilters, TIME_WINDOWS, canonicalSelection, projectGraph, stateDescription, toggleEpic, type Filters } from '../src/graph/state.js';
import type { Entity, GraphSnapshot, Relationship } from '../shared/graph.js';
import { effectiveTimes } from '../shared/scope.js';
import { elements } from '../src/graph/elements.js';
import { orbitalLayout } from '../src/graph/layout.js';
import { highlight, syncElements } from '../src/graph/interactions.js';

const filters: Filters = { ...defaultFilters(), kinds: new Set(ALL_TYPES) };
const now = Date.parse('2026-10-20T12:00:00Z');
describe('shared graph/list state', () => {
  test('component uses undirected evidenced relationships before collapse and never traverses hidden kinds', () => {
    const graph = projectGraph(fixture, filters, new Set(['epic:a']), now, 'task:b');
    expect(graph.eligibleGraph.nodes.map(node => node.id)).toContain('task:a');
    expect(graph.discoveryNodes.map(node => node.id)).not.toContain('task:a');
    expect(graph.discoveryNodes.map(node => node.id)).not.toContain('pane:unused');
    expect(graph.allEdges).toHaveLength(fixture.edges.length + 2);
    const taskOnly = projectGraph(fixture, { ...filters, kinds: new Set(['task']) }, new Set(), now, 'task:b');
    expect(taskOnly.nodes.every(node => node.kind === 'task')).toBe(true);
    expect(taskOnly.nodes.map(node => node.id)).toContain('task:c');
    expect(projectGraph(fixture, { ...filters, query: 'standalone' }, new Set(), now, 'task:b').componentAvailable).toBe(false);
    const derived = graph.allEdges.filter(edge => edge.kind === 'agent-dependency');
    expect(componentMembers(new Set(['agent:a', 'agent:b', 'agent:c']), derived, 'agent:c')).toEqual(new Set(['agent:a', 'agent:b', 'agent:c']));
  });
  test('stable anchor membership cache ignores heartbeat/labels but reacts to actual eligible topology', () => {
    const resolve = componentResolver(), ids = new Set(fixture.nodes.map(node => node.id));
    const first = resolve(ids, fixture.edges, 'task:b');
    expect(resolve(new Set([...ids].reverse()), [...fixture.edges].reverse(), 'task:b')).toBe(first);
    ids.delete('task:b'); expect(resolve(ids, fixture.edges, 'task:b')).toBeUndefined();
  });
  test('collapse retains standalone/resources and directed cross-epic boundary evidence', () => {
    const graph = projectGraph(fixture, filters, new Set(['epic:a']), now);
    expect(graph.nodes.map(node => node.id)).not.toContain('task:a');
    expect(graph.nodes.map(node => node.id)).toContain('task:solo');
    expect(graph.nodes.map(node => node.id)).toContain('pane:unused');
    expect(graph.hiddenTasks).toBe(2);
    expect(graph.hiddenRelationships).toBeGreaterThan(0);
    const summary = graph.edges.find(edge => edge.kind === 'blocks' && edge.source === 'epic:a');
    expect(summary).toMatchObject({ target: 'task:c', summary: true });
    expect(summary?.evidence).toContain(fixture.edges.find(edge => edge.source === 'task:b' && edge.target === 'task:c')!.id);
    const selection = canonicalSelection(graph.edges, summary!.id);
    expect(projectGraph(fixture, filters, new Set(), now).edges.find(edge => edge.id === selection)).toMatchObject({ source: 'task:b', target: 'task:c' });
    expect(graph.allEdges.filter(edge => edge.kind === 'blocks')).toHaveLength(3);
    expect(projectGraph(fixture, filters, new Set(['epic:a', 'epic:b']), now).edges.some(edge => edge.kind === 'blocks' && edge.source === 'epic:a' && edge.target === 'epic:b')).toBe(true);
  });
  test('filters and search have identical node scope; do not invent missing endpoints', () => {
    for (const f of [{ ...filters, query: 'standalone' }, { ...filters, kinds: new Set<Entity['kind']>(['agent']) }, { ...filters, state: 'active' }, { ...filters, query: 'missing' }]) {
      const graph = projectGraph(fixture, f, new Set(), now);
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
    const graph = projectGraph(fixture, filters, new Set(), now);
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
      const collapsed = projectGraph(fixture, filters, new Set(['epic:a']), now);
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

describe('composable source scope', () => {
  const entity = (id: string, kind: Entity['kind'], changedAt?: string): Entity => ({ id, kind, label: id, state: 'active', changedAt, details: {}, provenance: fixture.nodes[0].provenance });
  const link = (kind: Relationship['kind'], source: string, target: string): Relationship => ({ id: `${kind}/${source}/${target}`, kind, source, target, provenance: fixture.nodes[0].provenance });
  const graph = (nodes: Entity[], edges: Relationship[] = []): GraphSnapshot => ({ ...fixture, nodes, edges });
  const ids = (snapshot: GraphSnapshot, options: Partial<Filters> = {}) => projectGraph(snapshot, { ...filters, ...options }, new Set(), now).nodes.map(node => node.id);
  test.each(Object.entries(TIME_WINDOWS))('%s has inclusive rolling cutoff, not calendar subtraction', (time, hours) => {
    const cutoff = now - hours * 3600000;
    const snapshot = graph([entity('cutoff', 'task', new Date(cutoff).toISOString()), entity('outside', 'task', new Date(cutoff - 1).toISOString()), entity('current', 'task', new Date(now).toISOString()), entity('future', 'task', new Date(now + 1).toISOString()), entity('missing', 'task'), entity('invalid', 'task', '2026-02-31T00:00:00Z')]);
    const projected = projectGraph(snapshot, { ...filters, time: time as Filters['time'] }, new Set(), now);
    expect(projected.discoveryNodes.map(node => node.id)).toEqual(['current', 'cutoff']);
    expect(projected.unknownTimeExclusions).toBe(3);
    expect(ids(snapshot)).toHaveLength(6);
  });
  test('defaults, multiple kinds, empty kinds, all kinds and filter intersections', () => {
    expect(defaultFilters().kinds).toEqual(new Set(['epic', 'task', 'attempt', 'agent', 'session']));
    expect(projectGraph(fixture, defaultFilters(), new Set(), now).nodes.some(node => node.kind === 'pane')).toBe(false);
    expect(ids(fixture, { kinds: new Set() })).toEqual([]);
    expect(ids(fixture)).toHaveLength(fixture.nodes.length);
    expect(ids(fixture, { kinds: new Set(['task', 'agent']), query: 'bgr', state: 'active', epic: 'epic:a' })).toEqual(['task:b']);
    expect(ids(fixture, { epic: 'missing' })).toEqual([]);
  });
  test('nested/cyclic containment and shared topology never walk back to other owners', () => {
    const snapshot = graph([
      entity('root', 'epic'), entity('nested', 'epic'), entity('task', 'task', '2026-10-20T10:00:00Z'), entity('other', 'task', '2026-10-20T11:00:00Z'),
      entity('attempt', 'attempt', '2026-10-19T12:00:00Z'), entity('agent', 'agent'), entity('other-agent', 'agent'), entity('shared', 'session'), entity('pane', 'pane'), entity('tree', 'worktree'), entity('workspace', 'workspace'), entity('unrelated-tree', 'worktree'),
    ], [link('contains', 'root', 'nested'), link('contains', 'nested', 'root'), link('contains', 'nested', 'task'), link('assigned', 'task', 'attempt'), link('contains', 'attempt', 'agent'), link('assigned', 'other', 'other-agent'), link('session', 'agent', 'shared'), link('session', 'other-agent', 'shared'), link('placed-in', 'shared', 'pane'), link('contains', 'workspace', 'pane'), link('worktree', 'workspace', 'unrelated-tree'), link('worktree', 'pane', 'unrelated-tree'), link('worktree', 'agent', 'tree'), link('blocks', 'task', 'other'), link('related', 'nested', 'other')]);
    expect(new Set(ids(snapshot, { epic: 'root' }))).toEqual(new Set(['root', 'nested', 'task', 'attempt', 'agent', 'shared', 'pane', 'tree']));
    const times = effectiveTimes(snapshot.nodes, snapshot.edges, now);
    expect(times.get('shared')).toBe(Date.parse('2026-10-20T11:00:00Z'));
    expect(times.get('pane')).toBe(times.get('shared'));
    expect(times.get('tree')).toBe(Date.parse('2026-10-20T10:00:00Z'));
    expect(times.has('workspace')).toBe(false);
    expect(times.has('unrelated-tree')).toBe(false);
    expect(times.get('attempt')).toBe(Date.parse('2026-10-19T12:00:00Z')); // not its task's later time
    expect(times.get('agent')).toBe(Date.parse('2026-10-20T10:00:00Z'));
  });
  test('eligibility precedes collapse; excluded source edges remain only in details', () => {
    const projected = projectGraph(fixture, { ...filters, state: 'active' }, new Set(['epic:a']), now);
    expect(projected.discoveryNodes.map(node => node.id)).toEqual(['task:b']);
    expect(projected.hiddenTasks).toBe(0);
    expect(projected.edges).toEqual([]);
    expect(projected.allEdges).toHaveLength(fixture.edges.length + 2);
    const collapsed = projectGraph(fixture, filters, new Set(['epic:a']), now);
    expect(collapsed.eligibleGraph.nodes.map(node => node.id)).toContain('task:a');
    expect(collapsed.eligibleGraph.edges.some(edge => edge.source === 'task:b' && edge.target === 'task:c')).toBe(true);
  });
  test('observation and heartbeat changes do not refresh date eligibility or exclusions', () => {
    const first = projectGraph(fixture, { ...filters, time: '24h' }, new Set(), now);
    const refreshed: GraphSnapshot = { ...fixture, observedAt: new Date(now).toISOString(), nodes: fixture.nodes.map(node => ({ ...node,
      activity: [{ sessionId: 'heartbeat-only', state: 'working', freshness: 'current', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 4500).toISOString(), approval: false, input: false }],
      provenance: node.provenance.map(p => ({ ...p, observedAt: new Date(now).toISOString() })),
    })) };
    const second = projectGraph(refreshed, { ...filters, time: '24h' }, new Set(), now);
    expect(second.discoveryNodes.map(node => node.id)).toEqual(first.discoveryNodes.map(node => node.id));
    expect(second.unknownTimeExclusions).toBe(first.unknownTimeExclusions);
  });
});
