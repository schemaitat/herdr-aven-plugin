import { z } from 'zod';
import { boundedJsonFile } from './dispatcher.js';
import type { Runner, Scope } from '../commands.js';
import type { SourceHealth } from '../../shared/graph.js';

const text = z.string().max(16384);
const labelMap = z.record(z.string().max(256), z.string().max(1024)).default({});
const terminalSchema = z.object({
  address: text,
  name: text.default(''),
  state: text.default('unknown'),
  status: text.default(''),
  status_kind: text.default(''),
  program: text.default(''),
  reason: text.default(''),
  turn: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  reported: z.boolean().default(false),
  recovered_shell: z.boolean().default(false),
  labels: labelMap,
});
export type CoreTerminal = z.infer<typeof terminalSchema>;
export interface CoreRead {
  core: { id: string; name: string; version: string; machine: string };
  terminals: CoreTerminal[];
  observedAt: string;
  health: SourceHealth;
}

const inventorySchema = z.object({
  schema: z.literal('aven-dispatch-terminals/v1'),
  observed_at: z.number().nonnegative(),
  core: z.object({ id: text, name: text, version: text, machine: text }).default({ id: '', name: '', version: '', machine: '' }),
  terminals: z.array(terminalSchema).max(4000),
});

const listSchema = z.object({
  terminals: z.array(z.object({
    address: text,
    agent: text.optional(),
    cwd: text.optional(),
    name: z.string().max(16384).nullable().optional(),
    state: text,
    status: z.union([text, z.object({ state: text }).passthrough()]).optional(),
    turn: z.number().int().nonnegative().default(0),
  })).max(4000),
});

const empty = (message: string, observedAt = new Date(0).toISOString()): CoreRead => ({
  core: { id: '', name: '', version: '', machine: '' }, terminals: [], observedAt,
  health: { source: 'core', status: 'unavailable', observedAt, message },
});

// The watcher writes one bounded inventory file. Reading it grants no control
// over a terminal and never turns core status into task acceptance.
export async function readCore(scope: Scope, inventoryPath: string | undefined, run: Runner): Promise<CoreRead> {
  const observedAt = new Date().toISOString();
  if (!scope.core) return empty('herdr-core is not enabled for this project', observedAt);
  if (inventoryPath) {
    try {
      const parsed = inventorySchema.parse(await boundedJsonFile(inventoryPath));
      return {
        core: parsed.core,
        terminals: parsed.terminals,
        observedAt: new Date(parsed.observed_at).toISOString(),
        health: { source: 'core', status: 'ok', observedAt, message: 'Bounded herdr-core terminal inventory; status is observation, not API activity or acceptance' },
      };
    } catch {
      // Fall through to the minimal live listing.
    }
  }
  try {
    const [listing, status] = await Promise.all([
      run({ kind: 'core-list' }) as Promise<z.infer<typeof listSchema>>,
      run({ kind: 'core-status' }).catch(() => undefined) as Promise<unknown>,
    ]);
    const parsed = listSchema.parse(listing);
    const core = z.object({ core: z.object({ id: text.default(''), name: text.default('') }).default({ id: '', name: '' }), version: text.default('') }).safeParse(status);
    return {
      core: {
        id: core.success ? core.data.core.id : '',
        name: core.success ? core.data.core.name : '',
        version: core.success ? core.data.version : '',
        machine: '',
      },
      terminals: parsed.terminals.map(terminal => ({
        address: terminal.address,
        name: terminal.name ?? '',
        state: terminal.state,
        status: typeof terminal.status === 'string' ? terminal.status : terminal.status?.state ?? '',
        status_kind: '',
        program: terminal.agent ?? '',
        reason: '',
        turn: terminal.turn,
        reported: typeof terminal.status === 'object' && terminal.status !== null,
        recovered_shell: false,
        labels: {},
      })),
      observedAt,
      health: { source: 'core', status: 'incomplete', observedAt, message: 'Live herdr-core listing without dispatcher ownership labels; status is observation, not acceptance' },
    };
  } catch {
    return empty('herdr-core unavailable or returned unsupported terminal facts', observedAt);
  }
}
