import { describe, expect, test } from 'vitest';
import { cueTargets, FLOW_COLORS, FLOW_PERIOD_MS, FLOW_SEGMENT, flowPhase, motionEnabled } from '../src/graph/motion.js';
import { RELATION_KINDS, relationships } from '../src/graph/elements.js';
import { graphFixture } from './fixtures/graph-snapshot.js';

describe('directional edge flow', () => {
  test('phase advances through one segment and wraps inside 0..1', () => {
    expect(flowPhase(0)).toBe(0);
    const samples = Array.from({ length: 10 }, (_, index) => flowPhase((index + 1) * (FLOW_PERIOD_MS / 10)));
    for (const phase of samples) expect(phase).toBeGreaterThanOrEqual(0);
    for (const phase of samples) expect(phase).toBeLessThan(1);
    for (let index = 1; index < 9; index++) expect(samples[index]).toBeGreaterThan(samples[index - 1]!);
    expect(flowPhase(FLOW_PERIOD_MS)).toBeCloseTo(0);
    expect(flowPhase(Number.NaN, 0.25)).toBeCloseTo(0.25);
    expect(flowPhase(-10, 1.25)).toBeCloseTo(0.25);
    expect(FLOW_SEGMENT).toBeGreaterThan(0);
    expect(FLOW_SEGMENT).toBeLessThan(1);
  });

  test('every directed relation kind has an overlay colour', () => {
    for (const kind of RELATION_KINDS.filter(kind => kind !== 'related')) expect(FLOW_COLORS[kind]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(FLOW_COLORS.related).toBeUndefined();
  });

  test('flow requires a mounted, visible, unpaused non-reduced-motion canvas', () => {
    const on = { mounted: true, visible: true, paused: false, reducedMotion: false };
    expect(motionEnabled(on)).toBe(true);
    for (const key of Object.keys(on) as (keyof typeof on)[]) expect(motionEnabled({ ...on, [key]: !on[key] })).toBe(false);
    expect(motionEnabled({ ...on, paused: true, reducedMotion: true })).toBe(false);
  });
});

describe('selection cue membership', () => {
  const nodes = graphFixture.nodes;
  const edges = relationships(graphFixture);

  test('includes the selected entity, its degree-1 neighbours and current working nodes', () => {
    const targets = cueTargets(nodes, edges, 'task:b', ['agent:c', 'missing']);
    expect(targets.selected).toBe('task:b');
    expect([...targets.neighbors].sort()).toEqual(['agent:b', 'epic:a', 'task:a', 'task:c']);
    expect([...targets.working]).toEqual(['agent:c']);
    expect([...targets.visible].sort()).toEqual(['agent:b', 'agent:c', 'epic:a', 'task:a', 'task:b', 'task:c']);
    expect(targets.visible.has('task:solo')).toBe(false);
  });

  test('a vanished selection falls back to neighbours/working without a selected cue', () => {
    const targets = cueTargets(nodes, edges, 'task:gone', ['epic:b']);
    expect(targets.selected).toBeUndefined();
    expect(targets.neighbors.size).toBe(0);
    expect([...targets.visible]).toEqual(['epic:b']);
  });

  test('working cues ignore entities outside the visible node set', () => {
    const targets = cueTargets(nodes, edges, undefined, ['agent:c', 'ghost:node']);
    expect(targets.selected).toBeUndefined();
    expect([...targets.visible]).toEqual(['agent:c']);
    expect([...targets.working]).toEqual(['agent:c']);
  });
});
