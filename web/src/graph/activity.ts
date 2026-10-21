import type { Entity } from '../../shared/graph.js';

/** API-backed, current execution only. Persisted task/agent state is deliberately insufficient. */
export function isCurrentWorking(entity: Pick<Entity, 'activity'>) {
  return entity.activity?.some(item => item.state === 'working' && item.freshness === 'current') === true;
}
