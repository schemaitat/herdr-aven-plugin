import { z } from 'zod';
import { LIST_LIMIT, type Runner, type Scope } from '../commands.js';
import type { SourceHealth } from '../../shared/graph.js';

const text = z.string().max(16384);
const id = z.string().regex(/^[A-Za-z0-9]+$/).max(128);
export const referenceSchema = z.object({ id, ref: text.optional(), display_ref: text.optional() });
export const taskSchema = z.object({
  id, ref: z.string().regex(/^[A-Za-z0-9]+-[A-Za-z0-9]+$/), title: text, project: text,
  status: text, is_epic: z.boolean(), deleted: z.boolean().default(false),
  priority: text.default('none'), available_at: text.default(''), due_on: text.default(''),
  updated_at: text.default(''), epic_parent: referenceSchema.nullish(),
  epic_children: z.array(referenceSchema).max(1000).default([]),
});
export const contextSchema = z.object({
  task: z.object({ id, display_ref: text, status: text }),
  project: z.object({ key: text }), workspace: z.object({ key: text }),
  metadata: z.record(z.string(), z.unknown()).default({}),
  dependencies: z.object({ depends_on: z.array(referenceSchema).max(1000), blocks: z.array(referenceSchema).max(1000) }),
  related: z.array(z.object({ task_id: id, display_ref: text.optional() }).transform(other => ({ id: other.task_id, display_ref: other.display_ref }))).max(1000).default([]),
  epic_parent: referenceSchema.nullish(), epic_children: z.array(referenceSchema).max(1000).default([]),
});
export type AvenTask = z.infer<typeof taskSchema>;
export type AvenContext = z.infer<typeof contextSchema>;
export interface AvenRead { tasks: AvenTask[]; contexts: Map<string, AvenContext>; contextObservedAt?: Map<string, string>; health: SourceHealth }

export function avenSource(scope: Scope, run: Runner, hydrationLimit = 80) {
  const cache = new Map<string, { context: AvenContext; updated: string; time: number }>();
  let offset = 0;
  return async (): Promise<AvenRead> => {
    const observedAt = new Date().toISOString();
    const health: SourceHealth = { source: 'aven', status: 'ok', observedAt, message: `Scoped lists (limit ${LIST_LIMIT} each); bounded context hydration` };
    try {
      const results = await Promise.all([run({ kind: 'list' }), run({ kind: 'list', upcoming: true })]);
      const lists = results.map(value => z.array(taskSchema).max(LIST_LIMIT).parse(value));
      const tasks = [...new Map(lists.flat().filter(task => task.project === scope.project).map(task => [task.id, task])).values()];
      const live = new Set(tasks.map(task => task.id));
      for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
      const pending = tasks.filter(task => {
        const hit = cache.get(task.id);
        return !hit || hit.updated !== task.updated_at || Date.now() - hit.time > 15000;
      });
      // Rotate bounded hydration so larger projects eventually obtain coverage, never per-frame fan-out.
      const selected = Array.from({ length: Math.min(pending.length, hydrationLimit) }, (_, i) => pending[(offset + i) % pending.length]);
      offset = pending.length ? (offset + selected.length) % pending.length : 0;
      let failed = false;
      let next = 0;
      const hydrationStarted = Date.now();
      await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
        while (next < selected.length && Date.now() - hydrationStarted < 4000) {
          const task = selected[next++];
          try {
            const context = contextSchema.parse(await run({ kind: 'context', ref: task.ref }));
            if (context.task.id !== task.id || context.project.key !== scope.project || context.workspace.key !== scope.workspace) throw new Error('Scope mismatch');
            cache.set(task.id, { context, updated: task.updated_at, time: Date.now() });
          } catch { cache.delete(task.id); failed = true; }
        }
      }));
      const contexts = new Map(tasks.flatMap(task => {
        const hit = cache.get(task.id);
        return hit && hit.updated === task.updated_at ? [[task.id, hit.context] as const] : [];
      }));
      if (lists.some(list => list.length >= LIST_LIMIT) || contexts.size < tasks.length || failed) {
        health.status = 'incomplete';
        health.message = `Coverage incomplete: ${contexts.size}/${tasks.length} contexts; list cap ${LIST_LIMIT} per available/deferred list. Boundary references are not hydrated.`;
      }
      const contextObservedAt = new Map([...contexts.keys()].map(key => [key, new Date(cache.get(key)!.time).toISOString()]));
      return { tasks, contexts, contextObservedAt, health };
    } catch {
      return { tasks: [], contexts: new Map(), health: { ...health, status: 'unavailable', message: 'Aven unavailable, timed out, or returned an unsupported payload' } };
    }
  };
}
