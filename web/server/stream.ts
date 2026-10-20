import type { FastifyInstance } from 'fastify';
import type { Collector } from './refresh.js';

export function streamRoute(app: FastifyInstance, collector: Collector) {
  const connections = new Set<() => void>();
  app.addHook('preClose', async () => { for (const close of connections) close(); });
  app.get('/api/stream', async (request, reply) => {
    if (connections.size >= 16) return reply.code(503).send({ error: 'Local stream limit reached' });
    const response = reply.raw;
    let unsubscribe = () => {};
    let closed = false;
    let blocked = false;
    const close = () => { if (closed) return; closed = true; unsubscribe(); connections.delete(close); response.end(); };
    // Reserve before awaiting initialization, so concurrent browser requests cannot exceed the cap.
    connections.add(close);
    reply.hijack(); // This route owns the raw response on every path, including cancellation during initialization.
    request.raw.once('aborted', close);
    response.once('close', close); response.once('error', close);
    try { await collector.snapshot(); } catch { response.statusCode = 503; close(); return; }
    if (closed) return;
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) response.setHeader(name, value);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    response.on('drain', () => { blocked = false; });
    const send = (snapshot: Awaited<ReturnType<Collector['snapshot']>>, kind = 'snapshot') => {
      try {
      if (closed) return;
      if (blocked) return close(); // No additional buffered frame for a slow reader.
      const envelope = kind === 'heartbeat' ? { schema: 'live-heartbeat/v1', version: snapshot.version, instance: snapshot.stream?.instance, health: snapshot.health, stream: snapshot.stream } : { schema: 'live-graph/v1', version: snapshot.version, snapshot };
      const data = `id: ${snapshot.version}\nevent: ${kind}\ndata: ${JSON.stringify(envelope)}\n\n`;
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) return close();
      blocked = !response.write(data); // Allow one bounded frame to drain; never queue another.
      } catch { close(); }
    };
    unsubscribe = collector.subscribe(send);
    send(await collector.snapshot());
  });
}
