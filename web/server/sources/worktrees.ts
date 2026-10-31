import { z } from 'zod';
import type { Runner, Scope } from '../commands.js';
import type { SourceHealth } from '../../shared/graph.js';

export interface CoreWorktree { path: string; head: string; branch: string; bare: boolean; detached: boolean }
export interface WorktreeRead { primary: string; worktrees: CoreWorktree[]; health: SourceHealth }

export function parsePorcelain(text: string): CoreWorktree[] {
  return text.split('\n\n').filter(entry => entry.trim()).map(entry => {
    const tree: CoreWorktree = { path: '', head: '', branch: '', bare: false, detached: false };
    for (const line of entry.split('\n')) {
      if (line.startsWith('worktree ')) tree.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) tree.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) tree.branch = line.slice('branch '.length);
      else if (line === 'bare') tree.bare = true;
      else if (line === 'detached') tree.detached = true;
    }
    return tree;
  }).filter(tree => tree.path.length > 0).slice(0, 2000);
}

// Read-only inventory, always through `hc exec ... git ...`. The dashboard
// never creates, opens, or removes a worktree.
export async function readWorktrees(scope: Scope, primary: string, run: Runner): Promise<WorktreeRead> {
  const observedAt = new Date().toISOString();
  if (!scope.core) return { primary, worktrees: [], health: { source: 'worktrees', status: 'unavailable', observedAt, message: 'herdr-core is not enabled; Git worktree inventory unavailable' } };
  try {
    const output = z.string().max(4 * 1024 * 1024).parse(await run({ kind: 'worktrees' }));
    const worktrees = parsePorcelain(output);
    const root = worktrees[0]?.path;
    if (!root) throw new Error('No worktrees');
    // The dashboard may only report checkouts belonging to the configured
    // repository. A mismatched listing is unavailable, never merged blindly.
    if (firstRealpath(primary) !== firstRealpath(root)) throw new Error('Repository mismatch');
    return { primary: root, worktrees, health: { source: 'worktrees', status: 'ok', observedAt, message: 'Git worktree inventory through hc exec; read-only' } };
  } catch {
    return { primary, worktrees: [], health: { source: 'worktrees', status: 'unavailable', observedAt, message: 'Worktree inventory unavailable: hc exec, Git, or repository scope failed' } };
  }
}

function firstRealpath(path: string): string {
  return path.replace(/\/+$/, '');
}
