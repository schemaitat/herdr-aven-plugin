import { describe, expect, test } from 'vitest';
import cytoscape from 'cytoscape';
import { createRequire } from 'node:module';
import { elements, relationships } from '../src/graph/elements.js';
import { orbitalLayout } from '../src/graph/layout.js';
import { nodeRadius } from '../src/graph/physics.js';
import { graphFixture as fixture } from './fixtures/graph-snapshot.js';
import { isCurrentWorking } from '../src/graph/activity.js';

describe('graph identity, direction and evidence', () => {
  test('only current linked API activity qualifies for a working ring', () => {
    expect(isCurrentWorking({ activity: [{ sessionId: 'one', state: 'working', freshness: 'current', observedAt: '', expiresAt: '', approval: false, input: false }] })).toBe(true);
    expect(isCurrentWorking({ activity: [{ sessionId: 'one', state: 'working', freshness: 'stale', observedAt: '', expiresAt: '', approval: false, input: false }] })).toBe(false);
    expect(isCurrentWorking({ activity: undefined })).toBe(false);
  });
  test('retains all normalized identities, standalone tasks and unassigned resources', () => {
    const edges = relationships(fixture);
    const projected = elements(fixture.nodes, edges);
    expect(new Set(projected.map(element => element.data.id)).size).toBe(projected.length);
    expect(projected.slice(0, fixture.nodes.length).map(element => element.data.id)).toEqual(fixture.nodes.map(node => node.id));
    for (const { id, kind, source, target } of fixture.edges) expect(projected.find(element => element.data.id === id)?.data).toMatchObject({ id, kind, source, target });
    expect(edges.filter(edge => edge.kind === 'agent-dependency').map(edge => [edge.source, edge.target])).toEqual([['agent:a', 'agent:b'], ['agent:b', 'agent:c']]);
  });
  test('derives only from a blocker and two actual agent assignments, never proximity/name/session', () => {
    const derived = relationships(fixture).filter(edge => edge.kind === 'agent-dependency');
    for (const edge of derived) {
      const evidence = edge.evidence!.map(id => fixture.edges.find(record => record.id === id)!);
      expect(evidence.map(record => record.kind)).toEqual(['blocks', 'assigned', 'assigned']);
      expect(evidence[1].source).toBe(evidence[0].source);
      expect(evidence[2].source).toBe(evidence[0].target);
      expect(edge.provenance).toEqual(evidence.flatMap(record => record.provenance));
    }
    expect(relationships({ ...fixture, edges: fixture.edges.filter(edge => edge.kind !== 'assigned') }).some(edge => edge.kind === 'agent-dependency')).toBe(false);
    expect(relationships({ ...fixture, edges: fixture.edges.filter(edge => edge.kind !== 'blocks') }).some(edge => edge.kind === 'agent-dependency')).toBe(false);
    expect(relationships({ ...fixture, nodes: [...fixture.nodes].reverse(), edges: [...fixture.edges].reverse() }).map(edge => edge.id).sort()).toEqual(relationships(fixture).map(edge => edge.id).sort());
  });
  test('evidenced components are deterministic and keep epic children near their hub', () => {
    const edges = relationships(fixture);
    const layout = orbitalLayout(fixture.nodes, edges);
    expect(orbitalLayout([...fixture.nodes].reverse(), [...edges].reverse())).toEqual(layout);
    const epic = layout.get('epic:a')!;
    for (const id of ['task:a', 'task:b']) {
      const child = layout.get(id)!;
      expect(Math.hypot(child.x - epic.x, child.y - epic.y)).toBeGreaterThan(nodeRadius(fixture.nodes.find(node => node.id === id)!) + nodeRadius(fixture.nodes.find(node => node.id === 'epic:a')!));
      expect(Math.hypot(child.x - epic.x, child.y - epic.y)).toBeLessThan(250);
    }
    expect(layout.has('task:solo')).toBe(true);
    expect(layout.has('worktree:unused')).toBe(true);
  });
  test('pinned CiSE is compatible, but its cluster has no central epic-hub constraint', () => {
    const require = createRequire(import.meta.url);
    cytoscape.use(require('cytoscape-cise'));
    const cy = cytoscape({ headless: true, elements: elements(fixture.nodes, relationships(fixture)) });
    try {
      cy.layout({ name: 'cise', clusters: [['epic:a', 'task:a', 'task:b']], animate: false, randomize: false, fit: false, packComponents: false } as cytoscape.LayoutOptions).run();
      for (const node of cy.nodes()) { expect(Number.isFinite(node.position().x)).toBe(true); expect(Number.isFinite(node.position().y)).toBe(true); }
      const hub = cy.getElementById('epic:a').position();
      const a = cy.getElementById('task:a').position();
      const b = cy.getElementById('task:b').position();
      expect(Math.hypot(hub.x - (a.x + b.x) / 2, hub.y - (a.y + b.y) / 2)).toBeGreaterThan(1);
    } finally { cy.destroy(); }
  });
});
