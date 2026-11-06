import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inspectSnapshot, inspectSourcesFixture, scope, config, avenFixture } from './fixtures/inspect.js';
import type { AvenContext } from '../server/sources/inspect.js';
import type { Scope } from '../server/commands.js';

export { inspectSnapshot, inspectSourcesFixture, avenFixture, scope, config };
export const scratchRoot = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();

// Legacy view helper derives from the one inspector snapshot so old tests do
// not need a second Aven/core/app fixture corpus.
export function fixture(name: 'aven' | 'core' | 'app') {
  const snapshot = inspectSnapshot();
  if (name === 'aven') {
    const contexts: AvenContext[] = [];
    for (const task of snapshot.tasks) {
      if (!task.hydrated) continue;
      contexts.push({
        task: { id: task.id, display_ref: task.ref, status: task.status },
        project: { key: task.project }, workspace: { key: scope.workspace }, metadata: {},
        dependencies: { depends_on: task.dependencies.map(item => ({ id: item.id, ref: item.ref })), blocks: task.blocks.map(item => ({ id: item.id, ref: item.ref })) },
        related: task.related.map(item => ({ id: item.id, display_ref: item.ref })),
        epic_parent: task.epic_parent ? { id: task.epic_parent.id, ref: task.epic_parent.ref } : null,
        epic_children: task.epic_children.map(item => ({ id: item.id, ref: item.ref })),
      });
    }
    return { tasks: snapshot.tasks, contexts };
  }
  if (name === 'core') {
    return {
      schema: 'aven-dispatch-terminals/v1', observed_at: snapshot.observed_at_ms, core: snapshot.core,
      terminals: snapshot.panes.map(pane => ({
        address: pane.pane_id, name: pane.name, state: pane.state, status: pane.status, status_kind: pane.status_kind,
        program: pane.program, reason: pane.reason, turn: pane.turn, reported: pane.reported,
        recovered_shell: pane.recovered_shell, labels: pane.labels,
      })),
    };
  }
  return {
    spaces: snapshot.app.spaces.map(space => ({
      ...space,
      tabs: [{
        id: `${space.id}:t1`, name: space.name,
        terminals: snapshot.app.placements.filter(item => item.space === space.id).map(item => ({
          terminal: item.terminal, pane: item.pane, status: item.status, app: item.app, name: item.name || null,
        })),
      }],
    })),
  };
}

export type { AvenContext, Scope };
