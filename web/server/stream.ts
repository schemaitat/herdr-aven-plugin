import type { FastifyInstance } from 'fastify';
import type { Collector } from './refresh.js';
import { ProjectError, type ProjectLease } from './projects.js';
import { assertScope, type ProjectRoutes } from './routes.js';

export function streamRoute(app: FastifyInstance, collector?: Collector, projects?: ProjectRoutes) {
  const connections = new Set<() => void>();
  app.addHook('preClose', async () => { for (const close of connections) close(); });
  for (const path of projects ? ['/api/stream', '/api/projects/:project/stream'] : ['/api/stream']) app.get<{ Params: { project?: string } }>(path, async (request, reply) => {
    if (connections.size >= 16) return reply.code(503).send({ error: 'Local stream limit reached' });
    const response = reply.raw;
    let unsubscribe = () => {};
    let closed = false;
    let blocked = false;
    let lease: ProjectLease | undefined;
    const close = () => { if (closed) return; closed = true; unsubscribe(); lease?.release(); connections.delete(close); response.end(); };
    // Reserve before awaiting initialization, so concurrent browser requests cannot exceed the cap.
    connections.add(close);
    reply.hijack(); // This route owns the raw response on every path, including cancellation during initialization.
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) response.setHeader(name, value);
    request.raw.once('aborted', close);
    response.once('close', close); response.once('error', close);
    const project = request.params.project ?? projects?.startup;
    let source = collector;
    let initial;
    try {
      if (projects) { lease = await projects.manager.acquire(project!); source = lease.collector; }
      if (closed) { lease?.release(); return; }
      initial = await source!.snapshot();
      if (projects) assertScope(initial, project!, projects.workspace);
    } catch (error) {
      if (closed) { lease?.release(); return; }
      response.statusCode = error instanceof ProjectError ? error.statusCode : 503;
      response.setHeader('Content-Type', 'application/json');
      if (response.statusCode === 503) response.setHeader('Retry-After', '2');
      response.write(JSON.stringify({ error: error instanceof ProjectError ? error.message : 'Stream temporarily unavailable' }));
      close(); return;
    }
    if (closed) return;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    response.on('drain', () => { blocked = false; });
    const send = (snapshot: Awaited<ReturnType<Collector['snapshot']>>, kind = 'snapshot') => {
      try {
        if (closed) return;
        if (projects) assertScope(snapshot, project!, projects.workspace);
        if (blocked) return close(); // No additional buffered frame for a slow reader.
       const envelope = kind === 'heartbeat' ? { schema: 'live-heartbeat/v1', scope: snapshot.scope, version: snapshot.version, instance: snapshot.stream?.instance, health: snapshot.health, stream: snapshot.stream } : { schema: 'live-graph/v1', version: snapshot.version, snapshot };
        const data = `id: ${snapshot.version}\nevent: ${kind}\ndata: ${JSON.stringify(envelope)}\n\n`;
        if (Buffer.byteLength(data) > 4 * 1024 * 1024) return close();
       blocked = !response.write(data); // Allow one bounded frame to drain; never queue another.
       lease?.success();
      } catch { close(); }
    };
    unsubscribe = source!.subscribe(send);
    send(initial);
  });
}
