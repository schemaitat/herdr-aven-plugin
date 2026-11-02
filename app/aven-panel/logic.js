// Pure Aven-panel contracts. Kept independent of GPUI so query and identity
// behavior can be exercised with Node fixtures.
export const OPEN_STATUSES = new Set(["inbox", "backlog", "todo", "active"]);
export const LIMIT = 500;

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

export function canonicalId(row) {
  return String(row?.id ?? row?.canonical_id ?? row?.ref ?? "").trim();
}

export function qualifiedRef(row, project) {
  const ref = String(row?.ref ?? row?.display_ref ?? "").trim();
  return ref || (project && row?.ref_suffix ? `${project}-${row.ref_suffix}` : "");
}

export function normalizeEpic(row, project, workspace) {
  if (!row || row.deleted || !row.is_epic || !OPEN_STATUSES.has(row.status)) return null;
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

export function terminalName(workspace, epicId) {
  return `aven-epic-${encodeURIComponent(workspace)}-${encodeURIComponent(epicId)}-`;
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
// Folder-derived information is deliberately display-only: it must never
// change the browser query or cause a terminal launch.
export function resolveSpaceContext({ space, attempts = [], task, root, rows = [] }) {
  const folder = String(space?.folder ?? "");
  const name = String(space?.name ?? "");
  const matches = folder ? attempts.filter((attempt) => String(attempt?.worktree ?? "") === folder) : [];
  if (!folder) return { kind: "missing", name, folder, message: "This space has no worktree folder." };
  if (matches.length !== 1) return { kind: matches.length ? "ambiguous" : "unavailable", name, folder, message: matches.length ? "Dispatcher context is ambiguous for this worktree." : "No dispatcher context for this worktree." };
  if (!task?.ref || !root?.is_epic || !root?.id) return { kind: "stale", name, folder, message: "Dispatcher context no longer resolves to an Aven root epic." };
  const pinned = rows.find((row) => canonicalId(row) === canonicalId(root)) ?? null;
  return { kind: "dispatch", name, folder, task, root, pinned, message: pinned ? "Dispatcher root epic is listed below." : "Dispatcher root epic is not in the current safe result set." };
}
