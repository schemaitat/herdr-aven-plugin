import type { FastifyInstance } from 'fastify';
import type { GraphSnapshot } from '../shared/graph.js';

export function routes(app: FastifyInstance, snapshot: () => Promise<GraphSnapshot>) {
  app.get('/api/snapshot', async (_request, reply) => {
    try { return await snapshot(); }
    catch { return reply.code(503).send({ error: 'Snapshot temporarily unavailable' }); }
  });
}
