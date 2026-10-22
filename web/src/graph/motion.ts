import type { Entity } from '../../shared/graph.js';
import type { GraphEdge } from './elements.js';

/** Time for one directional dash to travel a full edge; calm drift, not strobing. */
export const FLOW_PERIOD_MS = 2600;
/** Bound overlay redraws and therefore canvas work to a calm cadence. */
export const FLOW_UPDATE_MS = 50;
/** Portion of an edge covered by one flow segment. */
export const FLOW_SEGMENT = 0.07;

export interface MotionGate {
  mounted: boolean;
  visible: boolean;
  paused: boolean;
  reducedMotion: boolean;
}

/** Continuous presentation motion is allowed only in the foreground and when requested. */
export function motionEnabled({ mounted, visible, paused, reducedMotion }: MotionGate) {
  return mounted && visible && !paused && !reducedMotion;
}

/**
 * Wrapped 0..1 phase for one edge. The overlay draws a short segment at this
 * position, so an increasing phase visibly travels from source to target.
 * A deterministic per-edge seed avoids a mechanical, synchronised row of dots.
 */
export function flowPhase(elapsedMs: number, seed = 0) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return ((seed % 1) + 1) % 1;
  const phase = (elapsedMs / FLOW_PERIOD_MS + seed) % 1;
  return phase < 0 ? phase + 1 : phase;
}

/** Overlay stroke colors mirror the styled edge kinds without reading style each frame. */
export const FLOW_COLORS: Record<string, string> = {
  contains: '#a48bd4',
  blocks: '#f0b676',
  'agent-dependency': '#f0b676',
  assigned: '#73d5cd',
  session: '#8699bc',
  'placed-in': '#8699bc',
  worktree: '#8699bc',
};

export interface CueTargets {
  selected?: string;
  neighbors: Set<string>;
  working: Set<string>;
  visible: Set<string>;
}

/**
 * Selection, one-hop and working cues in one place. Direction is irrelevant for
 * degree-1 neighbours: an edge in either direction is an immediate relationship.
 */
export function cueTargets(nodes: Entity[], edges: GraphEdge[], selected: string | undefined, workingIds: Iterable<string>): CueTargets {
  const neighborSet = new Set<string>();
  if (selected) {
    for (const edge of edges) {
      if (edge.source === selected && edge.target !== selected) neighborSet.add(edge.target);
      else if (edge.target === selected && edge.source !== selected) neighborSet.add(edge.source);
    }
  }
  const present = new Set(nodes.map(node => node.id));
  const neighbors = new Set([...neighborSet].filter(id => present.has(id)));
  const working = new Set([...workingIds].filter(id => present.has(id)));
  const selectedPresent = selected && present.has(selected) ? selected : undefined;
  const visible = new Set([...neighbors, ...working]);
  if (selectedPresent) visible.add(selectedPresent);
  return { selected: selectedPresent, neighbors, working, visible };
}
