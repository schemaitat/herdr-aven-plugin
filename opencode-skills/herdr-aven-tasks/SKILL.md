---
name: herdr-aven-tasks
description: Analyze Aven tasks against their herdr dispatch attempts, terminals, and OpenCode sessions. Use when asked what is running, to check task or dispatch status, to find stale/stuck/zombie attempts, to see what an epic's phases are doing, or to audit a project's in-flight work.
---

# herdr-aven-tasks

Read-only triage of Aven tasks alongside `aven-dispatch` execution state and live
`hc` terminals. Report each source separately; never infer one from another.

- **Aven** owns acceptance and task status (`aven`).
- **Dispatcher** owns execution attempts and phases (`aven-dispatch`).
- **herdr-core** owns terminal liveness (`hc`).
- **OpenCode API** owns session activity.

They legitimately disagree (e.g. attempt `needs-review` while Aven is still
`active`). Surface the disagreement instead of picking a winner.

Do not mutate anything (interrupt, reset, resume, watch, edit) unless the user
explicitly asks. `reset` preserves the Aven plan, branches, worktrees, and source
files but interrupts active sessions; `interrupt` never marks an Aven task
done or canceled.

## Scope

Run from the repository whose tasks you want. Aven infers the workspace and
project from the current directory; confirm with the header line aven prints, or
`aven doctor` when routing is unclear. Use `--workspace <name-or-key>` for another
workspace and `--project <key>` for another project.

## Inventory

```sh
aven list --status active            # acceptance-active tasks
aven list --epics                    # epic containers (note: --epics, not --epic)
aven list --status todo              # queued work
aven show HAP-XXXX                   # one-line status
aven context HAP-XXXX                # description, metadata, relations, notes
aven epic list HAP-XXXX              # epic children and their statuses
aven-dispatch list --running         # audit: live attempts only, refreshes state
aven-dispatch list                   # every persisted attempt
aven-dispatch status HAP-XXXX [--workflow NAME]
aven-dispatch watch --status         # supervisor ownership; null when none
hc ls                                # live terminals (--all includes finished)
```

### Gotchas

- `aven-dispatch status` requires the **full** ref (`HAP-XXXX`); a bare suffix
  fails with "no dispatcher attempt for task".
- When a task has both planning and implementation attempts, `status` fails with
  "multiple dispatcher workflows exist"; retry with `--workflow planning` or
  `--workflow implementation`.
- `aven list --ready` excludes epics. Epics group work; their children carry the
  execution, so always expand an epic before judging progress.
- `aven-dispatch list --running` also reconciles against OpenCode, so prefer it
  over guessing from the store.
- `hc ls` reports agent terminals as `state: live` plus `status: working|idle`.
  Match `terminal.address` from the attempt to the `address` in `hc ls`.

## Join the sources

1. Take the task refs from Aven (active, epics, and their children).
2. Match each ref to dispatcher attempts by `task_ref` + `workflow`.
3. Match each attempt to a terminal via `terminal.address`.
4. Read the session id and budget from `aven-dispatch status`.
5. Compute session age from `session.data.time.updated` (epoch **milliseconds**).

Bounded parser for the running set:

```sh
aven-dispatch list --running | python3 -c '
import json,sys
for a in json.load(sys.stdin):
    t = a.get("terminal") or {}
    print(a.get("task_ref"), a.get("workflow"), a.get("state"),
          t.get("address") or "-", a.get("session_id") or "-")
'
```

Session age and cost for one attempt:

```sh
aven-dispatch status HAP-XXXX | python3 -c '
import json,sys,time
d = json.load(sys.stdin)
s = (d.get("session") or {}).get("data") or {}
u = (s.get("time") or {}).get("updated")
print(s.get("id"), f"{(time.time()-u/1000):.0f}s ago" if u else "-",
      round(float(s.get("cost") or 0), 5),
      len((d.get("pending_forms") or {}).get("data") or []),
      len((d.get("pending_permissions") or {}).get("data") or []))
'
```

## Classify

Use attempt state first, then terminal and session evidence.

| Classification | Evidence |
|---|---|
| **Running** | attempt `running`, terminal `live`/`working`, session updated within ~2 min |
| **Generating** | attempt `running`, session activity recent but terminal idle between turns |
| **Awaiting review** | attempt `needs-review` (work complete, not merged) |
| **Interrupted / failed** | attempt `interrupted` or `failed` |
| **Stuck mid-admission** | `workspace-pending`, `session-pending`, `terminal-pending`, or `prompt-pending` with no session or terminal |
| **Stale / zombie** | attempt `running` but no terminal address, or session updated > ~10 min ago |
| **Not started** | Aven `todo`/`inbox` with no live attempt |
| **Mismatch** | Aven status contradicts attempt state (e.g. Aven `done` but attempt still `running`, or attempt `needs-review` with Aven `active`) |

Also report:

- **Watcher**: `aven-dispatch watch --status`. `lock: null` / `state: null`
  means nothing is reconciling attempts, so stale states will not self-heal.
- **Epic phase view**: `aven epic list` for each active epic. An epic may be
  `todo` while its child phase is `active`; that is normal in plan-implement
  workflows.
- **Pending gates**: non-empty `pending_forms` or `pending_permissions` means the
  session is blocked on a human.
- **Delivery state**: finished attempts live on dispatch branches and worktrees
  until merged. Note that completed work is not on `main`.

## Report

Lead with the answer, then evidence. Keep tables narrow.

```markdown
## Running now (N)
| Task | Workflow | Terminal | Last activity | Cost |

## Awaiting review / done
| Epic | Child phases | Branch merged? |

## Stuck or stale
| Task | State | Why it is suspect | Suggested action |

## Not started
Refs only.

Watcher: pid / none. Mismatches: <list>. Pending gates: <list or none>.
```

- Sort running by last activity, most recent first.
- Collapse hundreds of `needs-review` attempts; group by project and mention the
  count unless the user asks for detail.
- Flag long-idle sessions and missing terminals explicitly.
- End with a short list of safe next actions and ask before taking any.
