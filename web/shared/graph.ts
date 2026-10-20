export type NodeKind = 'epic' | 'task' | 'attempt' | 'agent' | 'session' | 'workspace' | 'pane' | 'worktree' | 'boundary';
export type EdgeKind = 'contains' | 'blocks' | 'related' | 'assigned' | 'session' | 'placed-in' | 'worktree';
export type SourceName = 'aven' | 'dispatcher' | 'herdr';
export interface Provenance { source: SourceName; observedAt: string; record: string }
export interface Entity {
  id: string;
  kind: NodeKind;
  label: string;
  state: string;
  boundary?: boolean;
  details: Record<string, string | number | boolean>;
  provenance: Provenance[];
}
export interface Relationship {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  provenance: Provenance[];
}
export interface SourceHealth {
  source: SourceName;
  status: 'ok' | 'unavailable' | 'incomplete' | 'stale';
  observedAt: string;
  message: string;
}
export interface GraphSnapshot {
  schema: 'local-explorer/v1';
  observedAt: string;
  scope: { project: string; workspace: string };
  nodes: Entity[];
  edges: Relationship[];
  health: SourceHealth[];
}
export const entityId = (kind: NodeKind, ...identity: (string | number)[]) => `${kind}:${identity.map(value => encodeURIComponent(String(value))).join(':')}`;
