import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { devAssetPath, localAddress, secure } from './security.js';
import { startupConfig } from './config.js';
import { createRunner } from './commands.js';
import { createSnapshotSource } from './graph.js';
import { routes } from './routes.js';

const address = localAddress(process.env.UI_HOST ?? '127.0.0.1', Number(process.env.UI_PORT ?? 4318));
const config = await startupConfig();
const app = Fastify({ logger: false, bodyLimit: 1024, requestTimeout: 10000 });
const nonce = randomBytes(24).toString('base64');
secure(app, address.origin, undefined, process.argv.includes('--dev') ? nonce : undefined);
routes(app, createSnapshotSource(config, createRunner(config.scope)));

if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: process.cwd(), html: { cspNonce: nonce }, server: { middlewareMode: true, hmr: false, fs: { strict: true, allow: [process.cwd()], deny: ['**/.git/**', '**/.env*', '**/server/**', '**/test/**'] } } });
  app.addHook('onRequest', (request, reply, done) => {
    if (request.url.startsWith('/api/') || request.url === '/bootstrap') return done();
    if (!devAssetPath(request.url)) {
      void reply.code(404).send({ error: 'Not found' });
      return;
    }
    vite.middlewares(request.raw, reply.raw, done);
  });
  app.get('/', async (_request, reply) => reply.type('text/html').send(await vite.transformIndexHtml('/', await readFile('index.html', 'utf8'))));
  app.addHook('onClose', async () => { await vite.close(); });
} else {
  await app.register(fastifyStatic, { root: fileURLToPath(new URL('../client/', import.meta.url)), index: ['index.html'] });
}

await app.listen({ host: address.host, port: address.port });
console.log(`Read-only explorer: ${address.origin} · ${config.scope.workspace}/${config.scope.project}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
