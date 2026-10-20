import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import type { GraphSnapshot, LogPage, TimelineEvent } from '../shared/graph.js';
import type { Runner } from './commands.js';
import type { OpenCodeSource } from './sources/opencode.js';
import { linkedSessions } from './activity.js';

export const PAGE_SIZE = 100;
export const LIVE_LIMIT = 1000;
const sequence = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d{1,16}$/).transform(Number).refine(Number.isSafeInteger)]);
export function safeText(value: string, secrets: string[] = []) {
  let text = stripVTControlCharacters(value.slice(0, 32768)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [redacted]').replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+)\b/g, '[redacted]').slice(0, 2048);
}
export function retainEvents(previous: TimelineEvent[], incoming: TimelineEvent[], limit = LIVE_LIMIT) {
  return [...new Map([...previous, ...incoming].map(event => [event.id, event])).values()]
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id)).slice(-limit);
}
export function summarizeEvent(raw: unknown, sessionId: string, secrets: string[], durable = false): TimelineEvent | undefined {
  const parsed = z.object({ id: z.string().max(256), type: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/), created: z.number().finite(),
    data: z.object({ sessionID: z.literal(sessionId) }), durable: z.object({ aggregateID: z.literal(sessionId), seq: sequence }).optional() }).safeParse(raw);
  if (!parsed.success || !Number.isFinite(new Date(parsed.data.created).getTime())) return;
  const item = parsed.data;
  return { id: `opencode:${sessionId}:${item.id}`, source: 'opencode', sessionId, cursor: item.durable ? String(item.durable.seq) : undefined,
    observedAt: new Date(item.created).toISOString(), text: safeText(item.type, secrets), durable };
}
const cursorSchema = z.object({ scope: z.string().max(1024), source: z.enum(['opencode', 'dispatcher']), after: z.string().max(256) });
export const scopeKey = (id: string) => Buffer.from(id).toString('base64url');
export const pageCursor = (scope: string, source: 'opencode' | 'dispatcher', after: string) => Buffer.from(JSON.stringify({ scope, source, after })).toString('base64url');

// Shared bounded lazy reader: cache and admission bound apply across ALL browsers.
export function createLogs(api: OpenCodeSource, run: Runner, workspace: string) {
  const lifetime = new AbortController();
  const cache = new Map<string, { time: number; page: Promise<LogPage> }>();
  let active = 0;
  return {
    close() { lifetime.abort(); cache.clear(); },
    async page(graph: GraphSnapshot, key: string, encoded = 'start'): Promise<LogPage> {
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(key) || !/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) throw new Error('Invalid scope/cursor');
      const id = Buffer.from(key, 'base64url').toString();
      const node = graph.nodes.find(node => node.id === id);
      if (!node) throw new Error('Unknown scope');
      const session = node.kind === 'session' && linkedSessions(graph).has(String(node.details.sessionId)) ? String(node.details.sessionId) : undefined;
      const logRef = node.kind === 'attempt' && /^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(String(node.details.logRef)) ? String(node.details.logRef) : undefined;
      let after = '';
      if (encoded !== 'start') {
        const cursor = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString()));
        if (cursor.scope !== id || cursor.source !== (session ? 'opencode' : 'dispatcher')) throw new Error('Cursor scope mismatch');
        after = cursor.after;
      }
      if (!session && !logRef) return { entries: [], message: 'History unavailable for this entity. Select a linked OpenCode session or dispatcher attempt.', gap: false };
      const cacheKey = `${key}/${encoded}`;
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.time < 5000) return hit.page;
      if (active >= 2) return { entries: [], message: 'Log reader busy; retry shortly (shared concurrency limit 2).', gap: true };
      active++;
      const page = (async (): Promise<LogPage> => {
        const entries: TimelineEvent[] = [];
        try {
          if (session) {
            if (after && (!/^\d{1,16}$/.test(after) || !Number.isSafeInteger(Number(after)))) throw new Error('Invalid sequence');
            let last = after ? Number(after) : -1;
            let gap = false;
            let count = 0;
            let capped = false;
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(4000)]);
            for await (const raw of api.logs(session, after ? Number(after) : undefined, signal)) {
              if (++count > 2000) { gap = true; capped = true; break; }
              const position = z.object({ durable: z.object({ aggregateID: z.literal(session), seq: sequence }) }).safeParse(raw);
              if (!position.success) continue;
              const seq = position.data.durable.seq;
              if (seq <= last) { if (seq < last) gap = true; continue; }
              if (last >= 0 && seq > last + 1) gap = true;
              last = seq;
              const entry = summarizeEvent(raw, session, api.secrets, true);
              if (entry) entries.push(entry); else gap = true;
              if (entries.length === PAGE_SIZE) break;
            }
            return { entries, next: entries.length === PAGE_SIZE || (capped && last >= 0) ? pageCursor(id, 'opencode', String(last)) : undefined, gap,
              message: capped && last < 0 ? 'History inspection cap reached without a durable sequence; remaining history cannot be resumed from this unsupported response.' : 'Durable API event summaries only; prompt, reasoning and tool payloads omitted. Sequence gaps are reported.' };
          }
          // Installed Aven has bounded context reads, not a note-page API. Page its available note window locally; disclose coverage.
          const context = z.object({ workspace: z.object({ key: z.literal(workspace) }), metadata: z.record(z.string(), z.unknown()),
            related: z.array(z.object({ task_id: z.string() })), notes: z.array(z.object({ id: z.string().max(128), created_at: z.string(), body: z.string().max(65536) })).max(2000) }).parse(await run({ kind: 'context', ref: logRef! }));
          if (context.metadata['dispatch.attempt-id'] !== node.details.attemptId || !context.related.some(other => other.task_id === node.details.taskId)) throw new Error('Unlinked log task');
          const notes = context.notes.filter(note => Number.isFinite(Date.parse(note.created_at))).map(note => ({ ...note, created_at: new Date(note.created_at).toISOString() }))
            .sort((a, b) => `${a.created_at}/${a.id}`.localeCompare(`${b.created_at}/${b.id}`));
          let next: string | undefined;
          for (const note of notes.filter(note => `${note.created_at}/${note.id}` > after)) {
            let raw: unknown;
            try { raw = JSON.parse(note.body); } catch { /* Non-dispatch notes are not log events. */ }
            const event = z.object({ schema: z.literal('aven-dispatch-event/v1'), attempt_id: z.literal(String(node.details.attemptId)), event: z.string(), state: z.string().optional() }).safeParse(raw);
            const cursor = `${note.created_at}/${note.id}`;
            if (event.success) entries.push({ id: `dispatcher:${node.details.attemptId}:${note.id}`, source: 'dispatcher', attemptId: String(node.details.attemptId), cursor, observedAt: note.created_at, text: safeText(`${event.data.event}${event.data.state ? ` · ${event.data.state}` : ''}`, api.secrets), durable: true });
            if (entries.length === PAGE_SIZE) { next = pageCursor(id, 'dispatcher', cursor); break; }
          }
          return { entries, next, gap: true, message: 'Dispatcher note window (Aven context limit; older history may be unavailable). Payload details omitted. Cursor resumes by source timestamp and note ID.' };
        } catch { return { entries, gap: true, message: 'History unavailable, unsupported, oversized or interrupted. Live observations are not durable history; retry to recover.' }; }
      })().finally(() => { active--; });
      cache.set(cacheKey, { time: Date.now(), page });
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
      return page;
    },
  };
}
