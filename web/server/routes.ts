import type { FastifyInstance } from 'fastify';
import type { GraphSnapshot } from '../shared/graph.js';
import type { createLogs } from './logs.js';

export function routes(app: FastifyInstance, snapshot: () => Promise<GraphSnapshot>, logs?: ReturnType<typeof createLogs>) {
  app.get('/api/snapshot', async (_request, reply) => {
    try { return await snapshot(); }
    catch { return reply.code(503).send({ error: 'Snapshot temporarily unavailable' }); }
  });
  if (logs) app.get<{ Params: { scope: string; cursor: string } }>('/api/logs/:scope/:cursor', async (request, reply) => {
    try { return await logs.page(await snapshot(), request.params.scope, request.params.cursor); }
    catch { return reply.code(400).send({ error: 'Invalid linked scope or cursor' }); }
  });
}
