import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export function localAddress(host: string, port: number) {
  if (host !== '127.0.0.1') throw new Error('Only 127.0.0.1 binding is supported');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
  return { host, port, origin: `http://${host}:${port}` };
}

export function devAssetPath(url: string) {
  const path = url.split('?')[0];
  if (path.includes('%') || path.includes('\\') || path.split('/').includes('..')) return false;
  return path === '/' || path === '/@react-refresh' || path === '/node_modules/vite/dist/client/env.mjs' ||
    ['/src/', '/shared/', '/node_modules/.vite/', '/@vite/'].some(prefix => path.startsWith(prefix));
}

export function secure(app: FastifyInstance, origin: string, token = randomBytes(32).toString('hex'), nonce?: string) {
  const expectedHost = new URL(origin).host;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    if (request.headers.host !== expectedHost ||
      (request.headers.origin !== undefined && request.headers.origin !== origin) ||
      (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))) {
      return reply.code(403).send({ error: 'Local same-origin access only' });
    }
    if (!['GET', 'HEAD'].includes(request.method)) return reply.code(405).send({ error: 'Read-only' });
    // Only allowlisted discovered project keys select read scope within the configured workspace.
    // No endpoint accepts filesystem paths, commands, upstream URLs, workspace overrides or query tokens.
    const api = request.url.startsWith('/api/') || request.routeOptions.url?.startsWith('/api/');
    if (request.url.includes('?') && (api || request.url.startsWith('/bootstrap'))) return reply.code(400).send({ error: 'Query parameters are not supported' });
    if (api) {
      const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const valid = Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
      if (!valid) return reply.code(401).send({ error: 'API authentication required' });
    }
  });
  // Bootstrap is same-origin only, is never CORS-readable, and does not carry service credentials.
  app.get('/bootstrap', async () => ({ token }));
}
