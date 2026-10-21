import type { Entity } from '../../shared/graph.js';

/** Presentation only: canonical ids remain the Cytoscape key and search value. */
export function compactId(value: string) {
  const session = /^(ses_)(.+)$/i.exec(value);
  if (session) return `${session[1]}${session[2].slice(0, 4)}`;
  const attempt = /^(att_)(.+)$/i.exec(value);
  if (attempt) return `${attempt[1]}${attempt[2].slice(0, 4)}`;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return value.slice(0, 4);
  if (/^[0-9A-HJKMNP-TV-Z]{20,}$/i.test(value)) return value.slice(0, 4);
  return value;
}

export function conciseLabel(node: Entity) {
  const label = node.label || compactId(node.id);
  const opaque = compactId(label);
  return opaque.length > 22 ? `${opaque.slice(0, 19)}…` : opaque;
}

export function graphLabel(node: Entity) { return conciseLabel(node); }

/** Greedy deterministic rectangle suppression; selected labels always remain. */
export function nonOverlappingLabels(items: { id: string; x: number; y: number; width: number; height: number; priority?: number }[]) {
  const kept: typeof items = [];
  for (const item of [...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))) {
    const overlaps = kept.some(other => Math.abs(item.x - other.x) * 2 < item.width + other.width && Math.abs(item.y - other.y) * 2 < item.height + other.height);
    if (!overlaps) kept.push(item);
  }
  return new Set(kept.map(item => item.id));
}
