import { z } from 'zod';
import type { Runner, Scope } from '../commands.js';
import type { SourceHealth } from '../../shared/graph.js';

const text = z.string().max(16384);
const workspaceSchema = z.object({ workspace_id: text, worktree: z.object({ repo_root: text, checkout_path: text }).optional() });
const paneSchema = z.object({
  pane_id: text, workspace_id: text, tab_id: text, cwd: text.optional(),
  agent: text.optional(), agent_status: text.default('unknown'),
  agent_session: z.object({ kind: text, value: text }).optional(),
});
const worktreeSchema = z.object({ path: text, branch: text.optional(), open_workspace_id: text.optional() });
export type HerdrPane = z.infer<typeof paneSchema>;
export interface HerdrRead {
  workspaces: z.infer<typeof workspaceSchema>[];
  panes: HerdrPane[];
  worktrees: z.infer<typeof worktreeSchema>[];
  health: SourceHealth;
}
export async function readHerdr(scope: Scope, primary: string, run: Runner): Promise<HerdrRead> {
  const health: SourceHealth = { source: 'herdr', status: 'ok', observedAt: new Date().toISOString(), message: 'Inherited session topology, filtered to repository; terminal state is not API activity' };
  const empty = { panes: [], workspaces: [], worktrees: [] };
  if (!scope.herdr) return { ...empty, health: { ...health, status: 'unavailable', message: 'Not running inside Herdr; terminal topology unavailable' } };
  try {
    const [snapshot, listing] = await Promise.all([run({ kind: 'snapshot' }), run({ kind: 'worktrees' })]);
    const data = z.object({ result: z.object({ snapshot: z.object({ workspaces: z.array(workspaceSchema).max(2000), panes: z.array(paneSchema).max(4000) }) }) }).parse(snapshot).result.snapshot;
    const inventory = z.object({ result: z.object({ source: z.object({ repo_root: text }), worktrees: z.array(worktreeSchema).max(2000) }) }).parse(listing).result;
    if (inventory.source.repo_root !== primary) throw new Error('Repository mismatch');
    const paths = new Set(inventory.worktrees.map(tree => tree.path));
    const workspaces = data.workspaces.filter(workspace => workspace.worktree?.repo_root === primary);
    const ids = new Set(workspaces.map(workspace => workspace.workspace_id));
    // Also accept panes in unannotated workspaces only when exact checkout identity matches.
    const panes = data.panes.filter(pane => ids.has(pane.workspace_id) || (pane.cwd && paths.has(pane.cwd)));
    const visible = new Set(panes.map(pane => pane.workspace_id));
    return { workspaces: data.workspaces.filter(workspace => ids.has(workspace.workspace_id) || visible.has(workspace.workspace_id)), panes, worktrees: inventory.worktrees, health };
  } catch {
    return { ...empty, health: { ...health, status: 'unavailable', message: 'Herdr unavailable, timed out, or returned unsupported topology' } };
  }
}
