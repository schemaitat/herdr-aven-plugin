import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { identifier, type Scope } from './commands.js';
import { z } from 'zod';

export interface ProjectConfig { scope: Scope; primary: string; storePath: string; localCoverage?: boolean; projectCheckouts: ReadonlyMap<string, string> }

export async function projectConfig(config: ProjectConfig, project: string): Promise<ProjectConfig> {
  if (project === config.scope.project) return config;
  // Paths are accepted only from startup configuration. The browser supplies a
  // project key, which has already been authorized by the project registry.
  const checkout = config.projectCheckouts.get(project);
  // Every project reads the same central store; the checkout mapping only
  // authorizes the project's Aven reads (topology stays intentionally scoped).
  if (!checkout) return { ...config, scope: { ...config.scope, project, herdr: false }, localCoverage: false };
  const primary = await primaryCheckout(checkout);
  return { ...config, scope: { ...config.scope, cwd: checkout, project, herdr: false }, primary, localCoverage: false };
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

// Same XDG-compatible default and override as the Rust dispatcher.
export function dispatcherStorePath(
  env: { AVEN_DISPATCH_STORE?: string; XDG_STATE_HOME?: string },
  cwd: string,
  home = homedir(),
): string {
  const store = env.AVEN_DISPATCH_STORE;
  if (store) return isAbsolute(store) ? store : resolve(cwd, store);
  const state = env.XDG_STATE_HOME;
  const base = state ? (isAbsolute(state) ? state : resolve(cwd, state)) : join(home, '.local', 'state');
  return join(base, 'aven', 'dispatch.sqlite');
}

export async function startupConfig(env = process.env, cwd = resolve(process.cwd(), '..')) {
  const primary = await primaryCheckout(cwd);
  const scope: Scope = {
    cwd, project: env.UI_PROJECT ?? basename(primary), workspace: env.UI_WORKSPACE ?? 'default',
    herdr: env.HERDR_ENV === '1', session: env.HERDR_SESSION ?? env.HERDR_SOCKET_PATH ?? 'inherited',
  };
  return { scope, primary, storePath: dispatcherStorePath(env, cwd), projectCheckouts: await configuredProjectCheckouts(env.UI_PROJECT_CHECKOUTS) };
}
