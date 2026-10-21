import type { GraphSnapshot } from './graph.js';

// Browser-side expiry is essential: a disconnected browser receives no server expiry updates.
export function expireSnapshot(snapshot: GraphSnapshot, now = Date.now()): GraphSnapshot {
  let stale = false;
  const nodes = snapshot.nodes.map(node => {
    if (!node.activity?.some(item => item.freshness === 'current' && Date.parse(item.expiresAt) <= now)) return node;
    stale = true;
    const activity = node.activity.map(item => Date.parse(item.expiresAt) <= now ? { ...item, state: 'unknown' as const, freshness: 'stale' as const, approval: 'unknown' as const, input: 'unknown' as const } : item);
    return { ...node, activity, state: node.kind === 'session' ? activity[0].state : node.state, details: { ...node.details, apiActivity: activity.some(item => item.state === 'working') ? 'Working (linked execution, not acceptance)' : 'unknown/stale' } };
  });
  return stale ? { ...snapshot, nodes, health: snapshot.health.map(item => item.source === 'opencode' ? { ...item, status: 'stale', message: 'API observation expired; current activity unknown.' } : item) } : snapshot;
}

export interface LiveEnvelope { schema: 'live-graph/v1'; version: number; snapshot: GraphSnapshot }
export interface HeartbeatEnvelope { schema: 'live-heartbeat/v1'; scope?: GraphSnapshot['scope']; version: number; instance?: string; health: GraphSnapshot['health']; stream: GraphSnapshot['stream'] }
export function parseFrame(frame: string): LiveEnvelope | HeartbeatEnvelope | undefined {
  const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
  if (!data || data.length > 4 * 1024 * 1024) return;
  const value: LiveEnvelope | HeartbeatEnvelope = JSON.parse(data);
  if (!Number.isSafeInteger(value.version)) throw new Error('Unsupported stream');
  if (value.schema === 'live-heartbeat/v1' && Array.isArray(value.health)) return value;
  if (value.schema !== 'live-graph/v1' || value.snapshot?.schema !== 'local-explorer/v1' || value.snapshot.version !== value.version) throw new Error('Unsupported stream');
  return value;
}
