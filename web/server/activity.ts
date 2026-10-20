import { entityId, type Activity, type GraphSnapshot } from '../shared/graph.js';

export const ACTIVITY_TTL = 4500;
export function linkedSessions(graph: GraphSnapshot) {
  // Only dispatcher assignments authorize API reads; Herdr alone is not project/session authority.
  const assigned = new Set(graph.edges.filter(edge => edge.kind === 'session').map(edge => edge.target));
  for (let depth = 0; depth < 4; depth++) for (const edge of graph.edges) {
    if (edge.kind === 'contains' && assigned.has(edge.source) && edge.provenance.some(p => p.source === 'opencode')) assigned.add(edge.target);
  }
  return new Set(graph.nodes.filter(node => node.kind === 'session' && node.details.service === 'opencode' && assigned.has(node.id)).map(node => String(node.details.sessionId)));
}

export function applyActivity(graph: GraphSnapshot, readings: Map<string, Activity>, now = Date.now()): GraphSnapshot {
  const linked = linkedSessions(graph);
  for (let depth = 0; depth < 4; depth++) for (const [id, item] of readings) if (item.parentId && linked.has(item.parentId)) linked.add(id);
  const byNode = new Map<string, Activity[]>();
  for (const [id, raw] of readings) {
    const activity: Activity = Date.parse(raw.expiresAt) <= now ? { ...raw, state: 'unknown', freshness: 'stale', approval: 'unknown', input: 'unknown' } : raw;
    byNode.set(entityId('session', 'opencode', id), [activity]);
  }
  const childEdges: GraphSnapshot['edges'] = [];
  const nodes = graph.nodes.map(node => ({ ...node, details: { ...node.details }, provenance: [...node.provenance] }));
  for (const [id, reading] of readings) if (reading.parentId && linked.has(reading.parentId)) {
    const child = entityId('session', 'opencode', id);
    const provenance = [{ source: 'opencode' as const, observedAt: reading.observedAt, record: id }];
    if (!nodes.some(node => node.id === child)) nodes.push({ id: child, kind: 'session', label: id, state: 'unknown', details: { sessionId: id, service: 'opencode', parentId: reading.parentId }, provenance });
    childEdges.push({ id: JSON.stringify(['api-child', reading.parentId, id]), kind: 'contains', source: entityId('session', 'opencode', reading.parentId), target: child, provenance });
  }
  // Bounded explicit ancestry, not proximity. Repeated passes also handle out-of-order child snapshots.
  for (let depth = 0; depth < 4; depth++) for (const edge of childEdges) {
    byNode.set(edge.source, [...new Map([...(byNode.get(edge.source) ?? []), ...(byNode.get(edge.target) ?? [])].map(item => [item.sessionId, item])).values()]);
  }
  for (const edge of graph.edges.filter(edge => edge.kind === 'session')) byNode.set(edge.source, byNode.get(edge.target) ?? []);
  for (const edge of graph.edges.filter(edge => edge.kind === 'assigned')) byNode.set(edge.source, [...(byNode.get(edge.source) ?? []), ...(byNode.get(edge.target) ?? [])]);
  return { ...graph, edges: [...graph.edges, ...childEdges], nodes: nodes.map(node => {
    const activity = [...new Map((byNode.get(node.id) ?? []).map(item => [item.sessionId, item])).values()];
    if (!activity.length) return node;
    return { ...node, activity, state: node.kind === 'session' ? activity[0].state : node.state,
      details: { ...node.details, apiActivity: activity.some(item => item.state === 'working') ? 'Working (linked execution, not acceptance)' : activity.map(item => `${item.state}/${item.freshness}`).join(', ') },
      provenance: [...node.provenance, ...activity.map(item => ({ source: 'opencode' as const, record: item.sessionId, observedAt: item.observedAt }))] };
  }) };
}
