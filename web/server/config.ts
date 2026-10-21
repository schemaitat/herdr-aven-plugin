import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { identifier, type Scope } from './commands.js';
import { z } from 'zod';

export interface ProjectConfig { scope: Scope; primary: string; storePath?: string; localCoverage?: boolean; projectCheckouts: ReadonlyMap<string, string> }

export async function projectConfig(config: ProjectConfig, project: string): Promise<ProjectConfig> {
  if (project === config.scope.project) return config;
  // Paths are accepted only from startup configuration. The browser supplies a
  // project key, which has already been authorized by the project registry.
  const checkout = config.projectCheckouts.get(project);
  if (!checkout) return { ...config, scope: { ...config.scope, project, herdr: false }, storePath: undefined, localCoverage: false };
  const primary = await primaryCheckout(checkout);
  return { ...config, scope: { ...config.scope, cwd: checkout, project, herdr: false }, primary, storePath: resolve(primary, '.aven-dispatch/state.json'), localCoverage: false };
}

const checkoutMapSchema = z.record(z.string().max(128), z.string().min(1).max(4096)).refine(
  map => Object.keys(map).length <= 100,
  'At most 100 project checkouts may be configured',
);

export async function configuredProjectCheckouts(raw: string | undefined): Promise<ReadonlyMap<string, string>> {
  if (!raw) return new Map();
  const parsed = checkoutMapSchema.parse(JSON.parse(raw));
  const checkouts = new Map<string, string>();
  for (const [project, directory] of Object.entries(parsed)) {
    if (!identifier.test(project) || !isAbsolute(directory)) throw new Error('Invalid UI_PROJECT_CHECKOUTS entry');
    checkouts.set(project, await realpath(directory));
  }
  return checkouts;
}

// Filesystem-only equivalent of the dispatcher's primary-checkout lookup; no store lock or git writes.
export async function primaryCheckout(cwd: string): Promise<string> {
  const dotgit = resolve(cwd, '.git');
  try {
    const pointer = await readFile(dotgit, 'utf8');
    if (!pointer.startsWith('gitdir: ')) throw new Error('Invalid gitdir');
    const gitdir = resolve(cwd, pointer.slice(8).trim());
    const common = (await readFile(resolve(gitdir, 'commondir'), 'utf8')).trim();
    return dirname(await realpath(resolve(gitdir, common)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EISDIR' || (error as NodeJS.ErrnoException).code === 'ENOENT') return cwd;
    throw error;
  }
}

export async function startupConfig(env = process.env, cwd = resolve(process.cwd(), '..')) {
  const primary = await primaryCheckout(cwd);
  const scope: Scope = {
    cwd, project: env.UI_PROJECT ?? basename(primary), workspace: env.UI_WORKSPACE ?? 'default',
    herdr: env.HERDR_ENV === '1', session: env.HERDR_SESSION ?? env.HERDR_SOCKET_PATH ?? 'inherited',
  };
  const store = env.AVEN_DISPATCH_STORE;
  return { scope, primary, storePath: store ? (isAbsolute(store) ? store : resolve(cwd, store)) : resolve(primary, '.aven-dispatch/state.json'), projectCheckouts: await configuredProjectCheckouts(env.UI_PROJECT_CHECKOUTS) };
}
