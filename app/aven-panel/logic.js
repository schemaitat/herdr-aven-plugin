// Pure Aven-panel contracts. Kept independent of GPUI so query and identity
// behavior can be exercised with Node fixtures.
export const LIMIT = 500;
export const DISPATCH_ACTIONS = [
  { id: "dispatch", detailKey: "d", terminalKey: "d", label: "z d", description: "Dispatch task" },
  { id: "plan-implement", detailKey: "s", terminalKey: "s", label: "z s", description: "Plan then implement" },
  { id: "plan", detailKey: "p", terminalKey: "p", label: "z p", description: "Create implementation plan" },
  { id: "implement", detailKey: "i", terminalKey: "i", label: "z i", description: "Implement existing plan" },
  { id: "reset", detailKey: "r", terminalKey: "r", label: "z r", description: "Reset dispatcher execution" },
  { id: "plan-implement-babysitter", detailKey: "x", terminalKey: "x", label: "z x", description: "Plan then implement with babysitter" },
  { id: "implement-babysitter", detailKey: "b", terminalKey: "b", label: "z b", description: "Implement with babysitter" },
];

export function projectArgs(workspace) {
  return ["project", "list", "--workspace", workspace, "--limit", String(LIMIT), "--json"];
}

export function openArgs(workspace, project) {
  return ["list", "--workspace", workspace, "--project", project, "--open", "--epics", "--limit", String(LIMIT), "--json"];
}

// `--upcoming` cannot be combined with `--epics`, so callers filter it here.
export function upcomingArgs(workspace, project) {
  return ["list", "--workspace", workspace, "--project", project, "--upcoming", "--limit", String(LIMIT), "--json"];
}

// Omitting --project lets Aven infer the project from the selected space's
// Git root. This keeps All scoped to (for example) HAP, not every workspace
// project, while still including every space in that project.
export function inferredEpicArgs(workspace) {
  return ["list", "--workspace", workspace, "--epics", "--limit", String(LIMIT), "--json"];
}

export function inferredUpcomingArgs(workspace) {
  return ["list", "--workspace", workspace, "--upcoming", "--limit", String(LIMIT), "--json"];
}

export function canonicalId(row) {
  return String(row?.id ?? row?.canonical_id ?? row?.ref ?? "").trim();
}

export function qualifiedRef(row, project) {
  const ref = String(row?.ref ?? row?.display_ref ?? "").trim();
  return ref || (project && row?.ref_suffix ? `${project}-${row.ref_suffix}` : "");
}

export function normalizeEpic(row, project, workspace) {
  if (!row || row.deleted || !row.is_epic || row.status === "done" || row.status === "canceled") return null;
  const id = canonicalId(row);
  const ref = qualifiedRef(row, project);
  if (!id || !ref) return null;
  return {
    id, ref, project: String(row.project?.key ?? row.project ?? project ?? ""), workspace,
    title: String(row.title ?? "Untitled epic"), status: String(row.status),
    created_at: typeof row.created_at === "string" ? row.created_at : "",
  };
}

function dateValue(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function sortEpics(rows) {
  return [...rows].sort((a, b) => {
    const ad = dateValue(a.created_at), bd = dateValue(b.created_at);
    if (ad !== null && bd !== null && ad !== bd) return bd - ad;
    if (ad !== null && bd === null) return -1;
    if (ad === null && bd !== null) return 1;
    return a.id.localeCompare(b.id);
  });
}

export function mergeProjectRows({ workspace, project, open = [], upcoming = [] }) {
  const rows = new Map();
  for (const raw of [...open, ...upcoming]) {
    const row = normalizeEpic(raw, project, workspace);
    if (row && !rows.has(row.id)) rows.set(row.id, row);
  }
  return sortEpics([...rows.values()]);
}

export function mergeCoverage(results) {
  const rows = new Map();
  const errors = [];
  for (const result of results) {
    if (result.error) { errors.push(`${result.project}: ${result.error}`); continue; }
    for (const row of result.rows ?? []) if (!rows.has(row.id)) rows.set(row.id, row);
  }
  return { rows: sortEpics([...rows.values()]), coverageError: errors.join("; ") };
}

function terminalHash(value) {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0").slice(0, 4)}`;
}

export function scopeEpics(rows, scope, context) {
  if (scope !== "space") return rows;
  const rootId = context?.kind === "dispatch" ? canonicalId(context.root) : "";
  // A normal project/root space may not belong to a dispatcher attempt. The
  // caller already queried epics from that space's Git project, so keep those
  // rows instead of making Space appear empty. Dispatched worktrees stay pinned
  // to their owning root epic.
  return rootId ? rows.filter((row) => canonicalId(row) === rootId) : rows;
}

export function terminalName(workspace, epicId) {
  // Herdr terminal names are limited to 32 chars. Keep a stable, compact
  // per-workspace/task prefix so existing terminals can still be reused.
  return `aven-e-${terminalHash(`${workspace}\u0000${epicId}`)}-`;
}

export function terminalIdentity(workspace, epicId) {
  return `${workspace}\u0000${epicId}`;
}

export function launchArgs({ workspace, epic, cwd, name }) {
  const cwdArgs = cwd ? ["--cwd", cwd] : [];
  return ["run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name,
    ...cwdArgs, "--", "aven", "--workspace", workspace, "tui", epic.ref];
}

export function isLiveEpicTerminal(terminal, workspace, epicId) {
  return terminal?.state === "live" && String(terminal?.name ?? "").startsWith(terminalName(workspace, epicId));
}

// Dispatcher data is only authoritative when it names this exact worktree.
export function resolveSpaceContext({ space, attempts = [], task, root, rows = [] }) {
  const folder = String(space?.folder ?? "");
  const name = String(space?.name ?? "");
  const matches = folder ? attempts.filter((attempt) => String(attempt?.worktree ?? "") === folder) : [];
  if (!folder) return { kind: "missing", name, folder, message: "This space has no worktree folder." };
  if (matches.length !== 1) return { kind: matches.length ? "ambiguous" : "unavailable", name, folder, message: matches.length ? "Multiple dispatches found; showing project epics." : "Project space; showing project epics." };
  if (!task?.ref || !root?.is_epic || !root?.id) return { kind: "stale", name, folder, message: "Dispatcher context no longer resolves to an Aven root epic." };
  const pinned = rows.find((row) => canonicalId(row) === canonicalId(root)) ?? null;
  return { kind: "dispatch", name, folder, task, root, pinned, message: pinned ? "Dispatcher root epic is listed below." : "Dispatcher root epic is not in the current safe result set." };
}
