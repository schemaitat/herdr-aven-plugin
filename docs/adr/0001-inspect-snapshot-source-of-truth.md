# ADR 0001: `inspect --json` owns the structural snapshot

- Status: accepted
- Date: 2026-11-06
- Schema: `aven-dispatch-inspect/v1`

## Context

The Rust inspector (`src/inspect/**`) and the read-only dashboard
(`web/server/sources/**`) independently shelled out to Aven, the dispatcher
SQLite store, herdr-core, Git and herdr-app, then parsed and normalized the
results into equivalent models. The two implementations had already diverged in
context caching, list/admission limits, terminal health wording and topology
enrichment. Test fixtures were duplicated across `test/` and `web/test/`.

## Decision

`aven-dispatch inspect --json` is the single source of truth for the structural
snapshot. The dashboard consumes that JSON, validates it against the
`aven-dispatch-inspect/v1` schema and maps it to its graph inputs. The dashboard
does not contain Aven, dispatcher-store, herdr-core, worktree or herdr-app
readers or parsers.

OpenCode live events, activity polling and log pagination remain in the web
server. That is a streaming concern; it is not part of a one-shot snapshot and
it is the only deliberate adapter exception. The dashboard invokes the
inspector with `--no-api` so one-shot activity semantics do not compete with the
live transport.

## Alternatives considered

1. **Shared Rust crate plus generated TypeScript schema.** Stronger type
   sharing, but the web process would still need a WASM/process boundary. The
   JSON contract already supplies the runtime boundary; generating types would
   not remove the larger runtime change.
2. **Keep both implementations and add contract tests.** Would not remove the
   divergence or the duplicated fixtures.
3. **Move the adapters into the web server and have Rust call Node.** Reverses
   ownership and makes the Rust binary depend on Node.

## Consequences

- New structural fields are added to `src/inspect/sources/**` and the snapshot
  model, then surfaced through the web client's schema. They are never read a
  second time in `web/server/sources/**`.
- The dashboard requires a compatible `aven-dispatch` binary. It resolves
  `UI_INSPECT_BIN`, then `target/debug/aven-dispatch`, then `aven-dispatch` from
  `PATH`. Missing or incompatible output marks the structural sources
  `unavailable`; there is no second-parser fallback.
- Limits, caching, sanitization and source-health wording are shared.
- The web bundle keeps only `sources/inspect.ts`, `sources/bounded.ts` and the
  OpenCode live client.

## Migration path (completed)

1. Extended `inspect --json` with task dates/priority/deleted, attempt terminal
   observations/log ref, core identity/terminal facts, worktree inventory and
   optional app placement; added `--no-api`.
2. Added `web/server/sources/inspect.ts` and removed
   `web/server/sources/{aven,dispatcher,core,worktrees,app}.ts`.
3. Rewrote `web/server/graph.ts` source reading to one inspector call per
   structural cycle; kept the graph projection and live SSE layer.
4. Consolidated dashboard fixtures into `web/test/fixtures/inspect.ts` and
   rewrote source/graph/project/refresh/security tests.
5. Recorded this decision and updated the README architecture notes.

## Adding a new structural source

Add the read and model to `src/inspect/sources/`, include it in snapshot
assembly and source health, extend the web schema in
`web/server/sources/inspect.ts`, and add assertions to `test/inspect.test.sh`.
Do not add a new `web/server/sources/<source>.ts` reader.
