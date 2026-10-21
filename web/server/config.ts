import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { Scope } from './commands.js';

export interface ProjectConfig { scope: Scope; primary: string; storePath?: string; localCoverage?: boolean }

export function projectConfig(config: ProjectConfig, project: string): ProjectConfig {
  if (project === config.scope.project) return config;
  return { ...config, scope: { ...config.scope, project, herdr: false }, storePath: undefined, localCoverage: false };
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
  return { scope, primary, storePath: store ? (isAbsolute(store) ? store : resolve(cwd, store)) : resolve(primary, '.aven-dispatch/state.json') };
}
