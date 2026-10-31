import { z } from 'zod';
import type { Runner, Scope } from '../commands.js';
import type { SourceHealth } from '../../shared/graph.js';

const text = z.string().max(16384);
const terminalSchema = z.object({
  terminal: text,
  pane: text.optional(),
  status: z.string().max(256).nullable().optional(),
  app: z.string().max(256).nullable().optional(),
  name: z.string().max(16384).nullable().optional(),
});
const tabSchema = z.object({ id: text, name: text.default(''), terminals: z.array(terminalSchema).max(1000).default([]) });
const spaceSchema = z.object({ id: text, name: text.default(''), folder: z.string().max(16384).optional(), tabs: z.array(tabSchema).max(100).default([]) });

export interface AppPlacement {
  terminal: string;
  pane: string;
  space: string;
  spaceName: string;
  tab: string;
  tabName: string;
  status: string;
  app: string;
  name: string;
}
export interface AppRead { spaces: { id: string; name: string; folder?: string }[]; placements: AppPlacement[]; health: SourceHealth }

// Optional placement only. Core facts remain available headlessly; app absence
// is a normal state and never makes a terminal look controlled or accepted.
export async function readApp(scope: Scope, run: Runner): Promise<AppRead> {
  const observedAt = new Date().toISOString();
  if (!scope.core) return { spaces: [], placements: [], health: { source: 'app', status: 'unavailable', observedAt, message: 'Project has no configured checkout; app placement is not scoped to another repository' } };
  if (!scope.session) return { spaces: [], placements: [], health: { source: 'app', status: 'unavailable', observedAt, message: 'No desktop app session; terminals remain observable headlessly' } };
  try {
    const parsed = z.object({ spaces: z.array(spaceSchema).max(200) }).parse(await run({ kind: 'app' }));
    const placements: AppPlacement[] = [];
    for (const space of parsed.spaces) for (const tab of space.tabs) for (const terminal of tab.terminals) {
      placements.push({
        terminal: terminal.terminal,
        pane: terminal.pane ?? '',
        space: space.id,
        spaceName: space.name,
        tab: tab.id,
        tabName: tab.name,
        status: terminal.status ?? '',
        app: terminal.app ?? '',
        name: terminal.name ?? '',
      });
    }
    return {
      spaces: parsed.spaces.map(space => ({ id: space.id, name: space.name, folder: space.folder })),
      placements: placements.slice(0, 4000),
      health: { source: 'app', status: 'ok', observedAt, message: 'Optional herdr-app placement; not execution state' },
    };
  } catch {
    return { spaces: [], placements: [], health: { source: 'app', status: 'unavailable', observedAt, message: 'herdr-app unavailable, closed, or returned unsupported topology; headless mode remains supported' } };
  }
}
