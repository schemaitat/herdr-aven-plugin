import type { FastifyInstance } from 'fastify';
import type { GraphSnapshot } from '../shared/graph.js';
import type { createLogs } from './logs.js';
import { ProjectError, type ProjectManager } from './projects.js';

export interface ProjectRoutes { manager: ProjectManager; startup: string; workspace: string }
export function assertScope(graph: GraphSnapshot, project: string, workspace: string) {
  if (graph.scope.project !== project || graph.scope.workspace !== workspace) throw new ProjectError('Source scope mismatch', 503);
}

export function routes(app: FastifyInstance, snapshot: () => Promise<GraphSnapshot>, logs?: ReturnType<typeof createLogs>, projects?: ProjectRoutes) {
  if (projects) {
    app.get('/api/projects', async () => projects.manager.list());
    for (const path of ['/api/snapshot', '/api/projects/:project/snapshot']) app.get<{ Params: { project?: string } }>(path, async (request, reply) => {
      let lease;
      try {
        const project = request.params.project ?? projects.startup;
        lease = await projects.manager.acquire(project);
        const graph = await lease.collector.snapshot(); assertScope(graph, project, projects.workspace);
        lease.success(); return graph;
      } catch (error) {
        const status = error instanceof ProjectError ? error.statusCode : 503;
        if (status === 503) reply.header('Retry-After', '2');
        return reply.code(status).send({ error: error instanceof ProjectError ? error.message : 'Snapshot temporarily unavailable' });
      } finally { lease?.release(); }
    });
    for (const path of ['/api/logs/:scope/:cursor', '/api/projects/:project/logs/:scope/:cursor']) app.get<{ Params: { project?: string; scope: string; cursor: string } }>(path, async (request, reply) => {
      let lease;
      try {
        const project = request.params.project ?? projects.startup;
        lease = await projects.manager.acquire(project);
        const graph = await lease.collector.snapshot(); assertScope(graph, project, projects.workspace);
        // Authorize against the current project snapshot before touching even a cached page.
        const result = await lease.logs.page(graph, request.params.scope, request.params.cursor);
        lease.success(); return result;
      } catch (error) {
        const status = error instanceof ProjectError ? error.statusCode : 400;
        if (status === 503) reply.header('Retry-After', '2');
        return reply.code(status).send({ error: error instanceof ProjectError ? error.message : 'Invalid linked scope or cursor' });
      } finally { lease?.release(); }
    });
    return;
  }
  app.get('/api/snapshot', async (_request, reply) => {
    try { return await snapshot(); }
    catch { return reply.code(503).send({ error: 'Snapshot temporarily unavailable' }); }
  });
  if (logs) app.get<{ Params: { scope: string; cursor: string } }>('/api/logs/:scope/:cursor', async (request, reply) => {
    try { return await logs.page(await snapshot(), request.params.scope, request.params.cursor); }
    catch { return reply.code(400).send({ error: 'Invalid linked scope or cursor' }); }
  });
}
