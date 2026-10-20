export type NodeKind = 'epic' | 'task' | 'attempt' | 'agent' | 'session' | 'workspace' | 'pane' | 'worktree' | 'boundary';
export type EdgeKind = 'contains' | 'blocks' | 'related' | 'assigned' | 'session' | 'placed-in' | 'worktree';
export type SourceName = 'aven' | 'dispatcher' | 'herdr' | 'opencode';
export interface Activity {
  sessionId: string;
  state: 'working' | 'idle' | 'missing' | 'unknown';
  freshness: 'current' | 'stale' | 'unknown';
  observedAt: string;
  expiresAt: string;
  approval: boolean | 'unknown';
  input: boolean | 'unknown';
  parentId?: string;
}
export interface Provenance { source: SourceName; observedAt: string; record: string }
export interface Entity {
  id: string;
  kind: NodeKind;
  label: string;
  state: string;
  boundary?: boolean;
  details: Record<string, string | number | boolean>;
  provenance: Provenance[];
  activity?: Activity[];
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
  version?: number;
  events?: TimelineEvent[];
  stream?: { status: string; gaps: number; instance?: string };
}
export interface TimelineEvent {
  id: string; source: 'opencode' | 'dispatcher' | 'bridge'; sessionId?: string; attemptId?: string;
  cursor?: string; observedAt: string; text: string; durable: boolean;
}
export interface LogPage { entries: TimelineEvent[]; next?: string; message: string; gap: boolean }
export const entityId = (kind: NodeKind, ...identity: (string | number)[]) => `${kind}:${identity.map(value => encodeURIComponent(String(value))).join(':')}`;
