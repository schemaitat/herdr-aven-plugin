---
name: opencode-api
description: Operate durable OpenCode V2 sessions through the local OpenCode API without guessing endpoints.
---

# OpenCode V2 session API

Use this guide when a dispatcher or coordinator needs to inspect, admit, or
interrupt an **API-owned OpenCode session**. Use the OpenCode API for durable
session operations; use Herdr only to attach an existing session to a pane and
inspect its terminal lifecycle.

## Ownership boundary

- **OpenCode API** owns session IDs, models, prompts, permissions, outcomes,
  forms, and interruption.
- **Herdr** owns worktrees, panes, terminal attachment, and screen/agent
  lifecycle. Its `agent` commands are not a replacement for creating or
  addressing an OpenCode V2 session by its durable ID.
- Let `aven-dispatch reconcile <root-ref>` advance cumulative phases. It
  verifies a completed worker, fast-forwards the root, advances the next
  worktree, and admits the already-created successor session. Do not manually
  reconstruct a successor prompt through a raw API call.

## Verified CLI form

Use the local client; it discovers the correct local service and credentials:

```sh
opencode api GET /api/session/<session-id>
opencode api GET /api/session/<session-id>/permission
opencode api GET /api/session/<session-id>/form
opencode api POST /api/session/<session-id>/interrupt
```

The session response is authoritative for completion: inspect
`.data.outcome` for `succeeded`, not only the terminal’s idle state.

For a dispatcher that owns a new prompt, use the documented prompt endpoint
with a caller-generated message ID and require the returned `.data.id` to
match it:

```sh
opencode api POST /api/session/<session-id>/prompt --data \
  '{"id":"msg_unique","text":"Work request","resume":true}'
```

Do not probe invented endpoints such as `prompt_async`. When the exact schema
is needed, inspect the running server’s `/openapi.json` through `opencode api`
or the V2 API reference.

## Safe inspection

```sh
opencode api GET /api/session/<session-id>/message
opencode api GET /api/experimental/session/<session-id>/log?after=<cursor>&follow=false
```

Responses are wrapped in `data`; message lists are at `.data`, not the JSON
root. Never confuse successful prompt admission with completed work: verify
the worker’s Aven result, Git evidence, and session outcome before integration.
