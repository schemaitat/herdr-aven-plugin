import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, closeOverlay, exec, focused, hc, knownAgents, nextCommand, panes, props, run, setShared, shared, spaces, terminals } from "herdr";
import {
  ATTEMPT_LIMIT, BOARD_COLORS, BOARD_COLUMNS, CREATED_FILTERS, DISPATCH_ACTIONS, SUMMARY_LABEL, archiveKey, assertBoardCoverage, blockedAddress,
  boardStats, buildBoard, cardArchiveable, deleteArgs, deletedTaskIds, detailArgs, detailCacheKey, detailIsCurrent, detailNeedsRefresh, dispatchTerminalName,
  emptyWhenUnknownMetadata, enrichmentPending, epicArgs, evidenceNeedsRefresh, filterArchived, filterBoardByProject, filterRowsByCreated, firstPaneFolder, flattenBoard, hydrateDetails, indexAttempts,
  handoffSendArgs, handoffTabArgs, isLiveEpicTerminal, jumpToColumn, refreshMayPublishProgress, reopenTarget,
  boardSourceSignature,
  landedWeek, landedWeekTotal, lastQuestion, liveHandoffTerminal, mapLimit, markMergedOnMain, mergeApprovalIssue, mergeEpicRows, mergePrompt,
  mergeTabName, moveColumn, moveEdge, moveSelection, nextMove, obligationListArgs, openObligationIndex,
  openArgs, projectChips, automaticProjectFilter, currentProjectArgs, resolveCurrentProject, safeDeleteOutcome, safeDetail,
  machineOption, onMachine, qualifyAttempt, spaceMachine,
  selectAttempt, selectedCard, selectionAfterClick, selectionCards, selectWorktreeSpace, shipPrompt, shipTabName, terminalName, upcomingArgs,
  pruneSelection, bulkTargets, progressPublishDue,
} from "./logic.js";

const REFRESH_MS = 10000;
const QUESTION_MS = 5000;
const READ_WORKERS = 4;
const EVIDENCE_WORKERS = 4;
const QUESTION_WORKERS = 3;
const READY_TIMEOUT_MS = 3000;
const READY_POLL_MS = 50;
const READY_SETTLE_MS = 700;
const PROGRESS_PUBLISH_MS = 120;
// Same-second metadata collisions and branch movement are revalidated on this
// slower tier; ordinary row changes still surface on the next 10-second tick.
const FULL_REVALIDATE_MS = 60000;
const ARCHIVE_SHARED = "aven-kanban.archived";

// The reference Board palette lives in the read model so its WCAG contrast is
// unit-tested. The overlay keeps its own look instead of depending on the app
// theme, as the layout does.
const C = BOARD_COLORS;
const TONES = { dim: C.dim, attention: C.you, working: C.work, land: C.land, done: C.done };
const MONO = "JetBrains Mono";
const SANS = "Geist";
// Boundary indices for the seven daily bars: 0 at the oldest edge, 7 at today.
const LANDED_AXIS = [0, 1, 2, 3, 4, 5, 6, 7];
const CHIPS = [
  ["#e0707f", "#3b1d24"], ["#3ec9b4", "#11302d"], ["#f0a050", "#3a2410"], ["#a690e8", "#2a2245"],
  ["#e6c35c", "#352c10"], ["#6fb3f2", "#152a40"], ["#e88cc8", "#3a1a30"], ["#8fd18a", "#1c321c"],
];

function message(error) { return String(error?.message ?? error); }
function parse(result, label) {
  if (result.code !== 0) throw new Error(`${label}: ${(result.stderr || "").trim() || `exit ${result.code}`}`);
  return JSON.parse(result.stdout || "null");
}
function parseList(result, label) {
  const value = parse(result, label);
  if (!Array.isArray(value)) throw new Error(`${label}: expected a JSON list`);
  return value;
}
// Project resolution is a hint, never a reason to fail the board: an
// unavailable checkout or unknown project simply leaves the filter on all.
function projectRows(result) {
  try {
    const value = JSON.parse(result?.stdout || "[]");
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
const firstLine = (value) => ((value ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "").slice(0, 160);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const DEFAULT_CHIP = ["#c8c8cc", "#242328"];
function hash(value) {
  try {
    let h = 0;
    for (const ch of String(value ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h;
  } catch { return 0; }
}
// A chip is cosmetic: an unexpected project value must never stop a render.
function tone(value) {
  const pair = CHIPS[hash(value) % CHIPS.length] ?? DEFAULT_CHIP;
  return { fg: pair[0], bg: pair[1] };
}
function dur(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${Math.floor(hours / 24)}d`;
}
const mono = (size, color, text) => div().font_family(MONO).text_size(size).text_color(color).child(text);

export default class AvenKanban extends View {
  init(_props, cx) {
    this.cx = cx;
    this.closed = false;
    this.refreshing = false;
    this.asking = false;
    this.now = Date.now();
    this.state = {
      loading: true, rows: [], attempts: [], liveAgents: [], error: "", coverageError: "", stale: false,
      enriching: false, evidencePending: false,
    };
    this.details = new Map();
    this.obligationDetails = new Map();
    this.sources = null;
    this.mainMerged = new Set();
    this.coverageError = "";
    this.evidenceError = "";
    this.ancestryChecked = false;
    // The list-read signature and full-revalidation clock decide whether the
    // expensive detail and ancestry tiers run on a given refresh.
    this.sourceSignature = "";
    this.lastFullRefresh = 0;
    // Until the first complete board is published, enrich it progressively.
    // Later refreshes stage everything and replace the board atomically.
    this.hasSettledBoard = false;
    this.pendingLaunches = new Set();
    this.pendingHandoffs = new Set();
    this.reopening = "";
    this.machineKey = "";
    // Navigation and archive presses that arrive before classification settles
    // are replayed against the authoritative board, so a provisional frame
    // cannot move the selection to a card that later changes column.
    this.pendingMoves = 0;
    this.pendingArchive = "";
    this.pendingArchiveAll = false;
    this.autoBusy = false;
    this.autoRequests = new Set();
    this.autoAttempts = new Map();
    this.mainEvidence = { head: "", entries: new Map() };
    this.questions = new Map();
    this.programs = {};
    this.renderTimes = new Map();
    this.renderAgents = [];
    this.renderTerminals = [];
    this.relatedAgentCache = new Map();
    const storedFilter = String(shared("aven-kanban.created-filter") ?? "");
    this.createdFilter = CREATED_FILTERS.some((filter) => filter.id === storedFilter) ? storedFilter : "all";
    this.projectFilter = String(shared("aven-kanban.project-filter") ?? "");
    // Automatic resolution is the default; an explicit chip press, including
    // "all", is persisted separately so a later open never overrides it.
    this.projectAuto = shared("aven-kanban.project-auto") !== false;
    this.resolvedProject = "";
    const storedArchive = shared(ARCHIVE_SHARED);
    this.archived = new Set(Array.isArray(storedArchive) ? storedArchive.filter((value) => typeof value === "string") : []);
    this.selectedId = "";
    this.selectedIds = [];
    this.summaryCardId = "";
    this.dispatchMenuEpicId = null;
    this.deleteConfirmId = "";
    this.deleting = false;
    this.notice = "";
    this.helpOpen = false;
    this.folder = String(props()?.cwd ?? "");
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (timerCx) => this.refresh(timerCx));
    cx.timer.every(QUESTION_MS, (timerCx) => this.readQuestions(timerCx));
    cx.timer.every(30000, (timerCx) => { this.now = Date.now(); this.notify(timerCx); });
    cx.spawn(async () => {
      try { for (const program of await knownAgents(machineOption(this.machine()))) this.programs[program.key] = program; } catch {}
    });
    this.commands(cx);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeOverlay(props().overlay);
  }

  workspace() { return String(props()?.workspace ?? "default"); }
  space() {
    const id = focused()?.space;
    return spaces().find((space) => space.id === id) ?? spaces().find((space) => space.active) ?? null;
  }
  // The focused space owns its Aven database, checkout, dispatcher store, and
  // installed agents. null means this computer.
  machine() { return spaceMachine(this.space()); }
  option(extra = {}, machine = this.machine()) { return machineOption(machine, extra); }
  spaceFolder() {
    const space = this.space();
    const focus = focused();
    if (focus?.space === space?.id && focus.cwd) return focus.cwd;
    // A space's `folder` is only where its new terminals start. The board may
    // open before focus lands, so prefer a live pane cwd before that default.
    return firstPaneFolder(space, panes()) || space?.folder || this.folder || String(props()?.cwd ?? "");
  }
  notify(cx) { if (!this.closed) { try { (cx ?? this.cx).notify(); } catch {} } }

  commands(cx) {
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (this.closed) return;
        this.command(String(command).split(".").pop(), cx);
      }
    });
  }

  // One dispatcher for both keys.json actions and the focused on_key_down
  // fallback, so the two paths can never drift apart.
  command(name, cx) {
    if (this.closed) return;
    if (name === "close") this.escape(cx);
    else if (name === "help") this.toggleHelp(cx);
    else if (name === "refresh") this.refresh(cx);
    else if (name === "next") this.select(1, cx);
    else if (name === "previous") this.select(-1, cx);
    else if (name === "column-next") this.selectColumn(1, cx);
    else if (name === "column-previous") this.selectColumn(-1, cx);
    else if (name === "first") this.selectEdge(false, cx);
    else if (name === "last") this.selectEdge(true, cx);
    else if (/^column-[1-5]$/.test(name)) this.jumpColumn(Number(name.slice(-1)) - 1, cx);
    else if (name === "open") this.openSelected(cx);
    else if (name === "go") this.goSelected(cx);
    else if (name === "answer") this.answerSelected(cx);
    else if (name === "ship") this.shipSelected(cx);
    else if (name === "archive") this.archiveSelected(cx);
    else if (name === "archive-all") this.archiveAll(cx);
    else if (name === "delete") this.confirmDeleteSelected(cx);
    else if (name === "dispatch") this.toggleDispatch(cx);
    else if (name === "summary") this.toggleSummary(cx);
    else if (name === "plan" || name === "plan-implement" || name === "implement") this.dispatchSelected(name, cx);
    else if (name === "merge") this.mergeSelected(cx);
    else cx.notify();
  }

  escape(cx) {
    if (this.helpOpen) { this.helpOpen = false; this.notify(cx); }
    else if (this.deleteConfirmId) { this.deleteConfirmId = ""; this.notify(cx); }
    else if (this.dispatchMenuEpicId) { this.dispatchMenuEpicId = null; this.notify(cx); }
    else if (this.selectedIds.length > 1) this.clearSelection(cx);
    else this.close();
  }

  // Keyboard focus is always exactly one card, so navigation collapses a
  // multi-selection back to the card the person is moving through.
  focusSelection(id) {
    this.selectedId = String(id ?? "");
    this.selectedIds = this.selectedId ? [this.selectedId] : [];
  }

  clearSelection(cx) {
    this.selectedIds = this.selectedId ? [this.selectedId] : [];
    this.notify(cx);
  }

  toggleHelp(cx) {
    this.helpOpen = !this.helpOpen;
    if (this.helpOpen) this.deleteConfirmId = "";
    this.notify(cx);
  }

  selectColumn(delta, cx) {
    this.focusSelection(moveColumn(this.columns(), this.selectedId, delta));
    this.dispatchMenuEpicId = null;
    this.deleteConfirmId = "";
    this.notify(cx);
  }

  selectEdge(last, cx) {
    this.focusSelection(moveEdge(this.columns(), this.selectedId, last));
    this.dispatchMenuEpicId = null;
    this.deleteConfirmId = "";
    this.notify(cx);
  }

  jumpColumn(index, cx) {
    this.focusSelection(jumpToColumn(this.columns(), this.selectedId, index));
    this.dispatchMenuEpicId = null;
    this.deleteConfirmId = "";
    this.notify(cx);
  }

  async rootFolder(folder, machine = this.machine()) {
    const option = this.option({}, machine);
    if (!folder) {
      try {
        const current = await exec("pwd", [], option);
        folder = current.code === 0 ? current.stdout.trim() : "";
      } catch {}
    }
    if (!folder) return "";
    try {
      const result = await exec("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"], option);
      if (result.code !== 0) return "";
      const common = result.stdout.trim().replace(/\/+$/, "");
      return common.endsWith("/.git") ? common.slice(0, -5) : folder;
    } catch { return ""; }
  }

  liveAgentsSnapshot() {
    return (agents() ?? []).map((agent) => ({
      address: String(agent?.address ?? ""),
      status: String(agent?.status ?? ""),
      space: String(agent?.space ?? ""),
      tab: String(agent?.tab ?? ""),
      app: String(agent?.app ?? ""),
      program: agent?.program ?? null,
    }));
  }

  // The bounded list reads are the only prerequisite for first paint. Details
  // and Git evidence enrich the same rows afterwards.
  async readSources() {
    const workspace = this.workspace();
    const machine = this.machine();
    const folder = this.spaceFolder();
    // Never guess a checkout from the app's own cwd: a wrong repository would
    // silently mark another project's work as delivered.
    const cwd = folder ? await this.rootFolder(folder, machine) : "";
    // A non-Git folder can still be mapped to a project by Aven path mappings,
    // so let Aven see the space folder when there is no Git checkout.
    const projectCwd = cwd || folder;
    const option = machineOption(machine, cwd ? { cwd } : {});
    const projectOption = projectCwd ? machineOption(machine, { cwd: projectCwd }) : {};
    const [availableResult, upcomingResult, attemptsResult, projectResult, obligationResult] = await Promise.all([
      exec("aven", epicArgs(workspace), option),
      exec("aven", upcomingArgs(workspace), option),
      exec("aven-dispatch", ["list", "--summary", "--limit", String(ATTEMPT_LIMIT)], option),
      projectCwd ? exec("aven", currentProjectArgs(workspace), projectOption).catch(() => null) : Promise.resolve(null),
      exec("aven", obligationListArgs(workspace), option).then(emptyWhenUnknownMetadata),
    ]);
    const available = parseList(availableResult, "Epics");
    const upcoming = parseList(upcomingResult, "Upcoming epics");
    const obligationRows = parseList(obligationResult, "Delivery obligations")
      .filter((row) => String(row?.ref ?? "").trim());
    assertBoardCoverage({ available: available.length, upcoming: upcoming.length, obligations: obligationRows.length });
    const rawAttempts = parseList(attemptsResult, "Dispatcher attempts");
    assertBoardCoverage({ attempts: rawAttempts.length });
    const resolvedProject = projectResult?.code === 0
      ? resolveCurrentProject(projectRows(projectResult), projectResult.stderr)
      : "";
    // Read only changed open obligations. A resolved obligation disappears from
    // the bounded list, so the cache is pruned before indexing.
    const currentObligations = new Set(obligationRows.map((row) => String(row?.ref ?? "")).filter(Boolean));
    for (const ref of this.obligationDetails.keys()) if (!currentObligations.has(ref)) this.obligationDetails.delete(ref);
    const obligationDetails = await mapLimit(obligationRows, READ_WORKERS, async (row) => {
      const ref = String(row?.ref ?? "");
      const cached = this.obligationDetails.get(ref);
      if (cached && cached.updatedAt === row?.updated_at
        && cached.detail?.task?.status === String(row?.status ?? "")) return cached.detail;
      const detail = safeDetail(parse(
        await exec("aven", detailArgs(workspace, ref), option),
        `Obligation ${ref}`,
      ));
      this.obligationDetails.set(ref, { updatedAt: row?.updated_at, detail });
      return detail;
    });
    const obligations = openObligationIndex(obligationDetails);
    const baseRows = mergeEpicRows({ available, upcoming, obligations });
    assertBoardCoverage({ epics: baseRows.length });
    const currentKeys = new Set(baseRows.map((row) => detailCacheKey(workspace, row.id, machine)));
    for (const key of this.details.keys()) if (!currentKeys.has(key)) this.details.delete(key);
    // Stored dispatcher addresses are bare; qualify them once for matching
    // against herdr-app's machine-prefixed agent and terminal addresses.
    const attemptIndex = indexAttempts(rawAttempts.map((attempt) => qualifyAttempt(attempt, machine)));
    return {
      workspace, machine, cwd, resolvedProject, available, upcoming, obligations, baseRows, attemptIndex,
      attempts: [...attemptIndex.values()].flat(),
    };
  }

  mergedRows() {
    const sources = this.sources;
    if (!sources) return [];
    const details = {};
    for (const row of sources.baseRows) {
      const cached = this.details.get(detailCacheKey(sources.workspace, row.id, sources.machine));
      if (detailIsCurrent(cached, sources.workspace, row)) details[row.id] = cached.detail;
    }
    return markMergedOnMain(
      mergeEpicRows({ available: sources.available, upcoming: sources.upcoming, details, obligations: sources.obligations }),
      this.mainMerged,
    ).map((row) => ({ ...row, ancestryPending: !this.ancestryChecked }));
  }

  publishRows(cx, flags = {}) {
    if (!this.sources || this.closed) return;
    const rows = this.mergedRows();
    this.resolvedProject = this.sources.resolvedProject;
    if (this.projectAuto) {
      // Automatic scope follows the selected space's project, but only while
      // that project has a card the current view can actually show.
      const visible = filterArchived(filterRowsByCreated(rows, this.createdFilter), this.archived, this.workspace(), this.sources?.machine ?? null);
      this.projectFilter = automaticProjectFilter(this.resolvedProject, visible);
    } else if (this.projectFilter && !rows.some((row) => row.project === this.projectFilter)) {
      // An explicit filter that no longer matches any epic is cleared rather
      // than presenting an unexplained empty board.
      this.projectFilter = "";
      setShared("aven-kanban.project-filter", "");
    }
    this.state = {
      loading: false, rows, attempts: this.sources.attempts, attemptIndex: this.sources.attemptIndex,
      liveAgents: this.liveAgentsSnapshot(), error: "", stale: false,
      coverageError: this.coverageError,
      enriching: flags.enriching === true, evidencePending: flags.evidencePending === true,
    };
    this.retainSelection(cx);
    this.replayPending(cx);
  }

  settled() {
    return !this.state.loading && this.ancestryChecked && !enrichmentPending(this.state);
  }

  replayPending(cx) {
    if (!this.settled()) return;
    const moves = this.pendingMoves;
    const archiveId = this.pendingArchive;
    const archiveAll = this.pendingArchiveAll;
    this.pendingMoves = 0;
    this.pendingArchive = "";
    this.pendingArchiveAll = false;
    if (!moves && !archiveId && !archiveAll) return;
    const step = moves < 0 ? -1 : 1;
    for (let index = 0; index < Math.abs(moves); index += 1) {
      this.selectedId = moveSelection(this.columns(), this.selectedId, step);
    }
    if (moves) this.focusSelection(this.selectedId);
    this.retainSelection(cx);
    if (archiveId) {
      const card = archiveId === "*" ? this.selected() : selectedCard(this.columns(), archiveId);
      if (card) this.archive(card, cx);
    }
    if (archiveAll) this.archiveAll(cx);
  }

  // Read-only delivery evidence for terminal cards. Exact attempt commits are
  // checked against one resolved local main head; this never mutates Aven or Git.
  // The checks run in the same small bounded pool as metadata reads, and each
  // commit's ancestry is cached for the current main head.
  terminalAttempts(rows, attemptIndex) {
    const terminals = [];
    for (const row of rows ?? []) {
      if (row.status !== "done" && row.status !== "canceled") continue;
      const attempt = selectAttempt(attemptIndex.get(row.id) ?? [], row.id).attempt;
      if (attempt) terminals.push({ row, attempt });
    }
    return terminals;
  }

  async mainHead(cwd, machine = this.machine()) {
    if (!cwd) return { head: "", error: "main is unavailable; delivery ancestry was not checked." };
    const headResult = await exec("git", ["-C", cwd, "rev-parse", "--verify", "main"], this.option({}, machine));
    if (headResult.code === 0) return { head: headResult.stdout.trim(), error: "" };
    const detail = String(headResult.stderr ?? "").trim();
    return { head: "", error: `main is unavailable at ${cwd}; delivery ancestry was not checked${detail ? `: ${detail}` : "."}` };
  }

  // `head` is resolved by the caller so a cheap refresh can detect a moved main
  // with one probe and reuse the cached evidence when nothing else changed.
  async evidenceFromMain(cwd, terminals, head, machine = this.machine()) {
    const option = this.option({}, machine);
    if (!terminals.length) return { merged: new Set(), error: "" };
    if (!cwd || !head) return { merged: new Set(), error: "main is unavailable; delivery ancestry was not checked." };
    if (this.mainEvidence.head !== head || this.mainEvidence.machine !== machine) {
      this.mainEvidence = { head, machine, entries: new Map() };
    }
    const merged = new Set();
    await mapLimit(terminals, EVIDENCE_WORKERS, async ({ row, attempt }) => {
      const commits = new Set();
      if (attempt.branch) {
        const branch = await exec("git", ["-C", cwd, "rev-parse", "--verify", `${attempt.branch}^{commit}`], option);
        if (branch.code === 0 && branch.stdout.trim()) commits.add(branch.stdout.trim());
      }
      if (attempt.worktree) {
        const worktree = await exec("git", ["-C", attempt.worktree, "rev-parse", "HEAD"], option);
        if (worktree.code === 0 && worktree.stdout.trim()) commits.add(worktree.stdout.trim());
      }
      for (const commit of commits) {
        let contained = this.mainEvidence.entries.get(commit);
        if (contained === undefined) {
          const ancestry = await exec("git", ["-C", cwd, "merge-base", "--is-ancestor", commit, head], option);
          contained = ancestry.code === 0;
          this.mainEvidence.entries.set(commit, contained);
        }
        if (contained) { merged.add(row.id); break; }
      }
    });
    return { merged, error: "" };
  }

  refresh(cx) {
    if (this.refreshing || this.closed) return;
    // A first paint may grow progressively. A refresh of a settled board is
    // staged and published once; otherwise merged/main badges would disappear
    // and reappear while metadata and Git evidence are recomputed.
    const progressive = refreshMayPublishProgress(this.hasSettledBoard);
    // A machine switch invalidates every row before the first read. If that
    // machine is unreachable, show an empty error state rather than this
    // computer's epics labelled as the remote machine's.
    const requested = this.machine();
    if ((requested ?? "") !== this.machineKey) {
      this.machineKey = requested ?? "";
      this.sources = null;
      this.details.clear();
      this.obligationDetails.clear();
      this.mainMerged = new Set();
      this.mainEvidence = { head: "", machine: requested, entries: new Map() };
      this.questions.clear();
      this.relatedAgentCache = new Map();
      this.projectFilter = "";
      this.resolvedProject = "";
      setShared("aven-kanban.project-filter", "");
      this.selectedId = "";
      this.selectedIds = [];
      this.summaryCardId = "";
      this.dispatchMenuEpicId = null;
      this.deleteConfirmId = "";
      this.sourceSignature = "";
      this.lastFullRefresh = 0;
      this.hasSettledBoard = false;
      this.state = { ...this.state, rows: [], attempts: [], attemptIndex: new Map(), loading: true, error: "", stale: false };
    }
    this.refreshing = true;
    if (progressive) this.ancestryChecked = false;
    if (!this.state.rows.length) this.state = { ...this.state, loading: true, error: "" };
    this.notify(cx);
    cx.spawn(async (taskCx) => {
      try {
        const sources = await this.readSources();
        const machineKey = String(sources.machine ?? "");
        if (this.machineKey !== machineKey) {
          // Focus can settle after the first read. Drop every presentation fact
          // that could name another machine's repository or terminal.
          this.machineKey = machineKey;
          this.details.clear();
          this.obligationDetails.clear();
          this.mainMerged = new Set();
          this.mainEvidence = { head: "", machine: sources.machine, entries: new Map() };
          this.questions.clear();
          this.relatedAgentCache = new Map();
          this.projectFilter = "";
          this.resolvedProject = "";
          setShared("aven-kanban.project-filter", "");
          this.selectedId = "";
          this.selectedIds = [];
          this.summaryCardId = "";
          this.dispatchMenuEpicId = null;
          this.deleteConfirmId = "";
          this.sourceSignature = "";
        }
        const signature = boardSourceSignature({
          rows: sources.baseRows, attempts: sources.attempts, obligations: sources.obligations,
        });
        const changed = Boolean(this.sourceSignature) && signature !== this.sourceSignature;
        // The cheap tier always runs. Same-second metadata collisions and
        // branch movement are revalidated on the slower full tier.
        const full = progressive || Date.now() - this.lastFullRefresh >= FULL_REVALIDATE_MS;
        this.sourceSignature = signature;
        this.sources = sources;
        if (progressive) {
          this.mainMerged = new Set();
          this.coverageError = "";
        }
        const neededRows = sources.baseRows.filter((row) =>
          detailNeedsRefresh(
            this.details.get(detailCacheKey(sources.workspace, row.id, sources.machine)),
            sources.workspace,
            row,
            { revalidate: full },
          ));
        // Publish provisional cards now; enrichment continues below.
        if (progressive) this.publishRows(taskCx, { enriching: neededRows.length > 0 });
        let lastProgressPublish = progressive ? Date.now() : 0;
        const hydration = neededRows.length
          ? await hydrateDetails({
              rows: neededRows,
              workspace: sources.workspace,
              limit: READ_WORKERS,
              cached: (row) => this.details.get(detailCacheKey(sources.workspace, row.id, sources.machine)),
              read: async (row) => parse(
                await exec("aven", detailArgs(sources.workspace, row.ref), machineOption(sources.machine, sources.cwd ? { cwd: sources.cwd } : {})),
                `Epic ${row.ref}`,
              ),
              publish: (row, snapshot) => {
                const key = detailCacheKey(sources.workspace, row.id, sources.machine);
                // A failed read must not leave an older approval marker usable.
                if (snapshot) this.details.set(key, snapshot);
                else this.details.delete(key);
                // Coalesce first-paint repaints; the final publish below is
                // unconditional, so no hydrated state is lost.
                if (progressive && progressPublishDue(lastProgressPublish, Date.now(), PROGRESS_PUBLISH_MS)) {
                  lastProgressPublish = Date.now();
                  this.publishRows(taskCx, { enriching: true });
                }
              },
            })
          : { needed: 0, failures: [] };
        if (progressive) this.publishRows(taskCx, { evidencePending: true });

        const terminals = this.terminalAttempts(this.mergedRows(), sources.attemptIndex);
        let mainEvidence = { merged: this.mainMerged, error: this.evidenceError };
        if (!terminals.length) {
          mainEvidence = { merged: new Set(), error: "" };
          this.mainEvidence = { head: "", entries: new Map() };
        } else {
          // The checkout can be briefly unavailable right after the overlay
          // opens (its space or live pane is still settling). Pay that bounded
          // wait only when expensive evidence work is actually due; a steady
          // refresh of a non-Git space must not stall on it every 10 seconds.
          let cwd = sources.cwd;
          const waitForCheckout = full || changed || hydration.needed > 0 || !this.ancestryChecked;
          if (!cwd && waitForCheckout) {
            for (let attempt = 0; !cwd && attempt < 25; attempt += 1) {
              // Focus may have moved to another machine while waiting; never
              // read a new machine's folder with the old machine's target.
              if ((this.machine() ?? "") !== (sources.machine ?? "")) break;
              await taskCx.sleep(200);
              const folder = this.spaceFolder();
              cwd = folder ? await this.rootFolder(folder, sources.machine) : "";
            }
          }
          const headInfo = await this.mainHead(cwd, sources.machine);
          const evidenceDue = evidenceNeedsRefresh({
            full, changed, hydrated: hydration.needed,
            head: headInfo.head, previousHead: this.mainEvidence.head,
          });
          if (evidenceDue) {
            if (headInfo.error) {
              mainEvidence = { merged: new Set(), error: headInfo.error };
              this.mainEvidence = { head: "", entries: new Map() };
            } else {
              mainEvidence = await this.evidenceFromMain(cwd, terminals, headInfo.head, sources.machine);
            }
          }
        }

        const coverage = [];
        if (hydration.failures.length) coverage.push(`${hydration.failures.length} epic metadata read(s) failed: ${hydration.failures.slice(0, 3).join("; ")}`);
        if (mainEvidence.error) coverage.push(mainEvidence.error);
        // Final state is complete: apply ancestry and publish once.
        this.mainMerged = mainEvidence.merged;
        this.evidenceError = mainEvidence.error;
        this.ancestryChecked = true;
        this.coverageError = coverage.join("; ");
        this.publishRows(taskCx, {});
        this.hasSettledBoard = true;
        if (full) this.lastFullRefresh = Date.now();
        this.autoSummarize(taskCx);
      } catch (error) {
        this.state = {
          ...this.state, loading: false, error: message(error), stale: this.state.rows.length > 0,
          enriching: false, evidencePending: false,
        };
        this.ancestryChecked = true;
        this.replayPending(taskCx);
        this.notify(taskCx);
      } finally {
        this.refreshing = false;
        this.notify(taskCx);
        this.readQuestions(taskCx);
      }
    });
  }

  // Archive and creation filters apply before the project filter so the strip
  // and chips can still describe every visible project.
  createdRows() {
    return filterArchived(filterRowsByCreated(this.state.rows, this.createdFilter), this.archived, this.workspace(), this.sources?.machine ?? null);
  }
  boardColumns() {
    return buildBoard({ rows: this.createdRows(), attemptIndex: this.state.attemptIndex, liveAgents: this.state.liveAgents ?? [] });
  }
  columns() {
    return filterBoardByProject(this.boardColumns(), this.projectFilter);
  }
  selected(columns = this.columns()) { return selectedCard(columns, this.selectedId); }
  selectedCards(columns = this.columns()) { return selectionCards(columns, this.selectedIds); }
  retainSelection(cx) {
    const columns = this.columns();
    // Keep a multi-selection across refreshes, but only for cards the drawn
    // board still contains. Filters, archives, and deletes prune it here.
    this.selectedIds = pruneSelection(this.selectedIds, columns);
    if (!this.selectedIds.length) {
      const fallback = selectedCard(columns, this.selectedId)?.id ?? moveSelection(columns, "", 1);
      this.selectedIds = fallback ? [fallback] : [];
    }
    if (!this.selectedIds.includes(this.selectedId)) this.selectedId = this.selectedIds.at(-1) ?? "";
    if (this.deleteConfirmId && !selectedCard(columns, this.deleteConfirmId)) this.deleteConfirmId = "";
    this.notify(cx);
  }

  // Generate at most one missing summary at a time, selected card first. The
  // Rust command takes a per-task lock, so a panel-triggered run cannot double
  // the same task; this queue only bounds the board's own launches.
  autoSummarize(cx) {
    if (this.autoBusy || this.closed) return;
    const columns = this.columns();
    const selected = this.selected(columns);
    const cards = flattenBoard(columns);
    const ordered = [selected, ...cards].filter(Boolean);
    const machine = this.sources?.machine ?? this.machine();
    const folder = this.sources?.cwd || this.spaceFolder();
    const requestKey = (ref) => `${machine ?? ""}\u0000${ref}`;
    const card = ordered.find((candidate) => candidate.summaryAuto
      && !this.autoRequests.has(requestKey(candidate.ref))
      && Date.now() - (this.autoAttempts.get(requestKey(candidate.ref)) ?? 0) >= 120000);
    if (!card) return;
    const key = requestKey(card.ref);
    this.autoBusy = true;
    this.autoRequests.add(key);
    this.autoAttempts.set(key, Date.now());
    cx.spawn(async (taskCx) => {
      try {
        const cwd = await this.rootFolder(folder, machine);
        await exec("aven-dispatch", ["describe", card.ref, "--llm", "--auto", "--workspace", this.workspace()], machineOption(machine, cwd ? { cwd } : {}));
      } catch {}
      finally {
        this.autoBusy = false;
        this.autoRequests.delete(key);
        if (!this.closed) this.refresh(taskCx);
      }
    });
  }

  setFilter(id, cx) {
    if (!CREATED_FILTERS.some((filter) => filter.id === id)) return;
    this.createdFilter = id;
    setShared("aven-kanban.created-filter", id);
    this.retainSelection(cx);
  }
  setProject(id, cx) {
    const next = this.projectFilter === id ? "" : id;
    this.projectFilter = next;
    // Every chip press is an explicit choice, including "all" (""), so later
    // automatic resolution must not override it.
    this.projectAuto = false;
    setShared("aven-kanban.project-filter", next);
    setShared("aven-kanban.project-auto", false);
    this.retainSelection(cx);
  }

  select(delta, cx) {
    if (!this.settled()) {
      this.pendingMoves += delta;
      return;
    }
    this.focusSelection(moveSelection(this.columns(), this.selectedId, delta));
    this.dispatchMenuEpicId = null;
    this.deleteConfirmId = "";
    this.notify(cx);
  }

  selectCard(card, cx, additive = false) {
    const next = selectionAfterClick(this.selectedIds, card.id, additive);
    this.selectedIds = next;
    // The last card toggled on owns keyboard focus; removing it falls back to
    // the most recently added remaining card.
    this.selectedId = next.includes(card.id) ? card.id : (next.at(-1) ?? "");
    this.dispatchMenuEpicId = null;
    this.deleteConfirmId = "";
    this.notify(cx);
  }

  // Live app reads leave the JS sandbox, so one render takes one snapshot of
  // agents, terminals, and tab timers. Clearing the related-agent memo with the
  // snapshot keeps a later classification from reusing an old agent.
  snapshotLive() {
    const liveAgents = agents() ?? [];
    this.renderAgents = liveAgents;
    this.renderTerminals = terminals() ?? [];
    this.renderTimes = this.times(liveAgents);
    this.relatedAgentCache = new Map();
  }

  times(liveAgents = agents()) {
    const tabs = new Map();
    for (const space of spaces()) for (const tab of space.tabs ?? []) tabs.set(tab.id, tab);
    const out = new Map();
    for (const agent of liveAgents ?? []) {
      const tab = tabs.get(agent.tab);
      if (tab) out.set(agent.address, { changed: tab.changed_at, working: tab.working_since });
    }
    return out;
  }

  relatedAgent(card) {
    const key = `${card?.column ?? ""}\u0000${card?.id ?? ""}`;
    if (this.relatedAgentCache.has(key)) return this.relatedAgentCache.get(key);
    const agent = this.findRelatedAgent(card);
    this.relatedAgentCache.set(key, agent);
    return agent;
  }

  findRelatedAgent(card) {
    const attempts = card.relatedAttempts?.length ? card.relatedAttempts : (card.attempt ? [card.attempt] : []);
    const addresses = card.column === "needs_you"
      ? [blockedAddress(attempts, this.state.liveAgents)].filter(Boolean)
      // A worktree coordinator records its terminal on the coordinator side,
      // while a single-session builder records the build terminal.
      : attempts.flatMap((attempt) => [attempt.terminal?.address, attempt.coordinatorTerminal?.address]).filter(Boolean);
    // Live lookups leave the JS sandbox; use the snapshot taken at the start of
    // this render instead of asking the app once per card.
    for (const address of addresses) {
      const agent = this.renderAgents.find((candidate) => candidate.address === address);
      if (agent) return agent;
    }
    for (const address of addresses) {
      const terminal = this.renderTerminals.find((candidate) => candidate.address === address && candidate.state === "live");
      if (terminal) {
        return {
          address,
          status: String(terminal.status ?? ""),
          space: String(terminal.labels?.["herdr.space"] ?? ""),
          tab: String(terminal.labels?.["herdr.tab"] ?? ""),
        };
      }
    }
    return null;
  }

  question(card) {
    const entry = this.questions.get(card.id);
    const agent = this.relatedAgent(card);
    return entry && agent?.address === entry.address ? entry.text : "";
  }

  async readQuestions(cx) {
    if (this.asking || this.closed) return;
    this.snapshotLive();
    const cards = this.columns().find((column) => column.id === "needs_you")?.cards ?? [];
    if (!cards.length) {
      if (this.questions.size) { this.questions.clear(); this.notify(cx); }
      return;
    }
    this.asking = true;
    try {
      // One slow terminal must not hold up the other blocked cards. Keep the
      // batch bounded and apply the results in card order, which also keeps the
      // stale-question cleanup deterministic.
      const reads = await mapLimit(cards, QUESTION_WORKERS, async (card) => {
        const address = this.relatedAgent(card)?.address ?? "";
        if (!address) return { card, address, text: "" };
        let text = "";
        try {
          const result = await exec("hc", ["read", address]);
          if (result.code === 0) text = lastQuestion(result.stdout);
        } catch {}
        return { card, address, text };
      });
      let changed = false;
      const alive = new Set();
      for (const { card, address, text } of reads) {
        if (!address) continue;
        alive.add(card.id);
        const current = this.questions.get(card.id);
        if (!current || current.address !== address || current.text !== text) {
          this.questions.set(card.id, { address, text });
          changed = true;
        }
      }
      for (const id of [...this.questions.keys()]) if (!alive.has(id)) { this.questions.delete(id); changed = true; }
      if (changed) this.notify(cx);
    } finally { this.asking = false; }
  }

  focusAgent(agent, typing) {
    if (agent.space) run("space.select", { id: agent.space });
    if (agent.tab) run("tab.select", { id: agent.tab });
    run("agent.focus", { terminal: agent.address });
    if (typing) run("pane.focus", { terminal: agent.address });
    this.close();
  }
  answer(card) {
    const agent = this.relatedAgent(card);
    if (!agent?.address) return false;
    this.focusAgent(agent, true);
    return true;
  }
  jumpToAgent(card) {
    const agent = this.relatedAgent(card);
    if (!agent?.address) return false;
    this.focusAgent(agent, false);
    return true;
  }
  // Enter reaches the card's current agent: focus a live one, reopen a closed
  // worktree from its durable session, or fall back to the epic in Aven.
  go(card, cx) {
    if (this.jumpToAgent(card)) return;
    if (this.reopenAgent(card, cx)) return;
    this.open(card, cx);
  }
  reopenAgent(card, cx) {
    const target = reopenTarget(card);
    if (!target) return false;
    const machine = this.sources?.machine ?? this.machine();
    const identity = `${machine ?? ""}\u0000reopen\u0000${target.attemptId}`;
    if (this.pendingLaunches.has(identity)) return true;
    this.pendingLaunches.add(identity);
    this.reopening = card.ref;
    this.state = { ...this.state, error: "" };
    this.notify(cx);
    cx.spawn(async (taskCx) => {
      try {
        const args = ["reopen", target.ref, "--json"];
        if (target.workflow) args.push("--workflow", target.workflow);
        const result = await exec("aven-dispatch", args, machineOption(machine));
        const payload = parse(result, `Reopen ${target.ref}`);
        const address = String(payload?.terminal ?? "");
        if (!address) throw new Error(`Reopen ${target.ref} returned no terminal`);
        await this.reveal(address, taskCx);
      } catch (error) {
        this.state = { ...this.state, error: message(error) };
        // Reopening failed; the epic's Aven TUI is still the safe fallback.
        this.open(card, taskCx);
      } finally {
        this.pendingLaunches.delete(identity);
        this.reopening = "";
        this.notify(taskCx);
      }
    });
    return true;
  }
  answerSelected(cx) {
    const card = this.selected();
    if (!card) { this.notify(cx); return; }
    if (card.column === "needs_you" && this.answer(card)) return;
    if (card.column === "done") { this.archiveSelected(cx); return; }
    this.notify(cx);
  }
  goSelected(cx) {
    const card = this.selected();
    if (card) this.go(card, cx);
  }
  shipSelected(cx) {
    const cards = this.selectedCards();
    if (cards.length > 1) { this.handoffCards(cards, "ship", cx); return; }
    const card = this.selected();
    if (card) this.ship(card, cx);
  }
  archiveSelected(cx) {
    const cards = this.selectedCards();
    if (cards.length > 1) { this.archiveCards(cards, cx); return; }
    if (!this.settled()) {
      // The moves that precede this press are still queued; archive whatever
      // the authoritative board selects after replaying them.
      this.pendingArchive = "*";
      return;
    }
    const card = this.selected();
    if (card?.column === "done") this.archive(card, cx);
    else this.notify(cx);
  }

  // o is the explicit "open in Aven" action. Enter jumps to the card's agent
  // via goSelected, reopening a closed worktree from its durable attempt, and
  // only falls back to opening the epic when there is no saved agent to reach.
  openSelected(cx) {
    const card = this.selected();
    if (card) this.open(card, cx);
  }
  dispatchSelected(actionId, cx) {
    const card = this.selected();
    const action = DISPATCH_ACTIONS.find((candidate) => candidate.id === actionId);
    if (card && action) this.dispatch(card, action, cx);
  }
  mergeSelected(cx) {
    const cards = this.selectedCards();
    if (cards.length > 1) { this.handoffCards(cards, "merge", cx); return; }
    const card = this.selected();
    if (card) this.merge(card, cx);
  }
  toggleDispatch(cx) {
    const card = this.selected();
    if (!card || card.status === "done" || card.status === "canceled") return;
    this.dispatchMenuEpicId = this.dispatchMenuEpicId === card.id ? null : card.id;
    this.notify(cx);
  }
  toggleSummary(cx) {
    const card = this.selected();
    if (!card || card.summaryLines.length === 0) return;
    this.summaryCardId = this.summaryCardId === card.id ? "" : card.id;
    this.notify(cx);
  }

  async reveal(address, cx) {
    if (!address) return;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline && !this.closed) {
      try {
        const result = await exec("herdr-app", ["do", "terminal.peek", "--terminal", address]);
        if (result.code === 0) {
          this.close();
          run("terminal.peek", { terminal: address });
          return;
        }
      } catch { break; }
      await cx.sleep(READY_POLL_MS);
    }
    this.close();
    run("terminal.peek", { terminal: address });
  }

  open(epic, cx) {
    const workspace = this.workspace();
    const machine = this.sources?.machine ?? this.machine();
    const folder = this.sources?.cwd || this.spaceFolder();
    const identity = `${machine ?? ""}\u0000${terminalName(workspace, epic.id)}`;
    if (this.pendingLaunches.has(identity)) return;
    const existing = terminals().find((terminal) => isLiveEpicTerminal(terminal, workspace, epic.id, machine));
    if (existing) { void this.reveal(existing.address, cx); return; }
    this.pendingLaunches.add(identity);
    cx.spawn(async (taskCx) => {
      try {
        const cwd = await this.rootFolder(folder, machine);
        const name = `${terminalName(workspace, epic.id)}${Date.now().toString(36)}`;
        const result = await hc(openArgs({ workspace, epic, cwd, name, machine }));
        if (result.code !== 0) throw new Error((result.stderr || "").trim() || "could not start Aven");
        await this.reveal(JSON.parse(result.stdout).address, taskCx);
      } catch (error) {
        this.state = { ...this.state, error: message(error) };
      } finally {
        this.pendingLaunches.delete(identity);
        this.notify(taskCx);
      }
    });
  }

  async waitForDetail(address, reference, cx) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let readySince = 0;
    while (Date.now() < deadline) {
      try {
        const result = await hc(["read", address]);
        if (result.code === 0 && result.stdout.includes(reference)) {
          if (!readySince) readySince = Date.now();
          if (Date.now() - readySince >= READY_SETTLE_MS) return;
        } else readySince = 0;
      } catch {}
      await cx.sleep(READY_POLL_MS);
    }
    throw new Error(`Aven did not open ${reference} in time; the dispatcher shortcut was not sent.`);
  }

  dispatch(epic, action, cx) {
    if (epic.status === "done" || epic.status === "canceled") return;
    const workspace = this.workspace();
    const machine = this.sources?.machine ?? this.machine();
    const folder = this.sources?.cwd || this.spaceFolder();
    const identity = `${machine ?? ""}\u0000${terminalName(workspace, epic.id)}\u0000${action.id}`;
    const prefix = dispatchTerminalName(workspace, epic.id, action);
    if (this.pendingLaunches.has(identity)) return;
    const existing = terminals().find((terminal) => terminal.state === "live"
      && onMachine(terminal.address, machine)
      && String(terminal.name ?? "").startsWith(prefix));
    if (existing) { void this.reveal(existing.address, cx); return; }
    this.pendingLaunches.add(identity);
    this.dispatchMenuEpicId = null;
    cx.spawn(async (taskCx) => {
      try {
        const cwd = await this.rootFolder(folder, machine);
        const name = `${prefix}${Date.now().toString(36)}`;
        const started = await hc(openArgs({ workspace, epic, cwd, name, machine }));
        if (started.code !== 0) throw new Error(started.stderr.trim() || `could not open ${epic.ref} in Aven`);
        const address = JSON.parse(started.stdout).address;
        await this.waitForDetail(address, epic.ref, taskCx);
        const sent = await hc(["keys", address, "z", action.detailKey]);
        if (sent.code !== 0) throw new Error(sent.stderr.trim() || `could not send ${action.label}`);
        await this.reveal(address, taskCx);
      } catch (error) {
        this.state = { ...this.state, error: message(error) };
      } finally {
        this.pendingLaunches.delete(identity);
        this.notify(taskCx);
      }
    });
  }

  async handoffAgent(machine = this.sources?.machine ?? this.machine()) {
    const configured = shared("aven-kanban.merge-agent");
    if (Array.isArray(configured) && configured.length > 0 && configured.every((part) => typeof part === "string")) {
      return configured;
    }
    try {
      const installed = (await knownAgents(machineOption(machine)))
        .filter((agent) => agent?.installed && Array.isArray(agent.run) && agent.run.length > 0);
      const preferred = installed.find((agent) =>
        /opencode/i.test(`${agent.key ?? ""} ${agent.name ?? ""} ${agent.run.join(" ")}`));
      const chosen = preferred ?? installed[0];
      if (chosen) return chosen.run;
    } catch {}
    return ["opencode"];
  }

  async exactDetail(workspace, epic, cwd, machine = this.sources?.machine ?? this.machine()) {
    const result = await exec("aven", detailArgs(workspace, epic.ref), machineOption(machine, cwd ? { cwd } : {}));
    const detail = safeDetail(parse(result, `Epic ${epic.ref}`));
    if (detail.task.id !== epic.id || !detail.task.is_epic) {
      throw new Error(`approval identity mismatch for ${epic.ref}`);
    }
    return detail;
  }

  // Merge and Ship PR are handoffs into the session that owns the approved
  // result: the builder for a single-session dispatch or the coordinator for a
  // worktree epic. Re-read approval now, then send the prompt over hc and focus
  // that agent. Only when its terminal is gone does the board open a tab in the
  // task's worktree space. It never starts an agent in the primary checkout and
  // never mutates Git itself.
  //
  // `focus` is false for a bulk batch: the prompts still go to each owning
  // session, but the board stays open instead of jumping to the first one.
  async handoffOne(epic, kind, focus = true) {
    if (!epic?.mergeable) return { ok: false, skipped: true };
    const identity = `${kind}\u0000${epic.id}`;
    if (this.pendingHandoffs.has(identity)) return { ok: false, skipped: true };
    this.pendingHandoffs.add(identity);
    const label = kind === "ship" ? "Ship PR" : "Merge";
    try {
      const workspace = this.workspace();
      const machine = this.sources?.machine ?? this.machine();
      const cwd = epic.attempt?.worktree || await this.rootFolder(this.sources?.cwd || this.spaceFolder(), machine);
      // Re-read the exact task now: a cached or stale approval marker must
      // never deliver a handoff. The dispatcher journal still validates it.
      const detail = await this.exactDetail(workspace, epic, cwd, machine);
      const issue = mergeApprovalIssue(detail.task, detail.metadata);
      if (issue) {
        this.details.delete(detailCacheKey(workspace, epic.id, machine));
        throw new Error(`no complete durable approval (${issue}); rerun /approve`);
      }
      const task = kind === "ship" ? shipPrompt(epic) : mergePrompt(epic);
      const live = liveHandoffTerminal(epic.attempt, agents(), terminals());
      if (live) {
        const sent = await hc(handoffSendArgs(live.address, task));
        if (sent.code !== 0) {
          throw new Error((sent.stderr || "").trim() || `could not send the ${label.toLowerCase()} prompt to the task agent`);
        }
        if (focus) this.focusAgent(live, false);
        return { ok: true };
      }
      // The owning session has stopped. Keep the prompt in the task's own
      // worktree space rather than starting a fresh agent in main.
      const worktree = epic.attempt?.worktree ?? "";
      const activeSpaceId = focused()?.space ?? spaces().find((space) => space.active)?.id ?? "";
      const target = selectWorktreeSpace(spaces(), worktree, activeSpaceId, panes(), machine);
      if (!target?.id) {
        throw new Error("the task agent terminal and its worktree space are unavailable; open the task agent and retry");
      }
      const name = kind === "ship" ? shipTabName(epic) : mergeTabName(epic);
      const existing = (target.tabs ?? []).find((tab) => tab.name === name);
      if (existing) {
        // A prior handoff already owns this tab. Bulk never steals focus or
        // re-sends a possibly running prompt; report it as already open.
        if (!focus) return { ok: false, skipped: true };
        run("tab.select", { id: existing.id });
        const agent = agents().find((candidate) => candidate.tab === existing.id);
        if (agent?.address) run("agent.focus", { terminal: agent.address });
        this.close();
        return { ok: true };
      }
      const argv = await this.handoffAgent(machine);
      const result = await exec("herdr-app", handoffTabArgs({
        name, space: target.id, folder: worktree, argv, task,
      }));
      if (result.code !== 0) throw new Error((result.stderr || "").trim() || `could not open the ${label.toLowerCase()} agent`);
      if (focus) this.close();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: message(error) };
    } finally {
      this.pendingHandoffs.delete(identity);
    }
  }

  handoff(epic, kind, cx, focus = true) {
    if (!epic?.mergeable) return;
    const identity = `${kind}\u0000${epic.id}`;
    if (this.pendingHandoffs.has(identity)) return;
    const label = kind === "ship" ? "Ship PR" : "Merge";
    cx.spawn(async (taskCx) => {
      const result = await this.handoffOne(epic, kind, focus);
      if (result.error) this.state = { ...this.state, error: `${label} handoff failed for ${epic.ref}: ${result.error}` };
      this.notify(taskCx);
    });
  }

  // Bulk merge/ship validates and delivers each card independently. One stale
  // approval or stopped session must not stop the rest of the selection.
  handoffCards(cards, kind, cx) {
    const targets = bulkTargets(cards, kind, this.state);
    if (!targets.length) { this.notify(cx); return; }
    const label = kind === "ship" ? "Ship PR" : "Merge";
    cx.spawn(async (taskCx) => {
      let sent = 0;
      let skipped = 0;
      const errors = [];
      for (const card of targets) {
        const result = await this.handoffOne(card, kind, false);
        if (result.ok) sent += 1;
        else if (result.skipped) skipped += 1;
        else if (result.error) errors.push(`${card.ref}: ${result.error}`);
      }
      const parts = [`Sent ${sent} ${label} handoff${sent === 1 ? "" : "s"}`];
      if (skipped) parts.push(`${skipped} skipped`);
      if (errors.length) parts.push(`${errors.length} failed`);
      this.notice = `${parts.join("; ")}.`;
      if (errors.length) this.state = { ...this.state, error: `${label} handoff: ${errors.slice(0, 2).join("; ")}` };
      this.notify(taskCx);
    });
  }

  merge(epic, cx) { this.handoff(epic, "merge", cx); }
  ship(epic, cx) { this.handoff(epic, "ship", cx); }

  archive(card, cx) {
    // Archive keys are immutable IDs, so a provisional or unhydrated card must
    // never be archived under a classification that enrichment may change.
    // Presses that arrive while the board settles are replayed afterwards.
    if (!this.settled()) {
      if (card?.id) this.pendingArchive = String(card.id);
      return;
    }
    if (!cardArchiveable(card, this.state)) return;
    this.archived.add(archiveKey(this.workspace(), card.id, this.sources?.machine ?? null));
    setShared(ARCHIVE_SHARED, [...this.archived]);
    this.questions.delete(card.id);
    this.retainSelection(cx);
  }
  // Bulk archive reuses the single-card predicate and archive key. A card that
  // is not fully classified Done stays visible instead of disappearing under a
  // provisional classification.
  archiveCards(cards, cx) {
    const targets = bulkTargets(cards, "archive", this.state);
    if (!targets.length) { this.notify(cx); return; }
    for (const card of targets) {
      this.archived.add(archiveKey(this.workspace(), card.id, this.sources?.machine ?? null));
      this.questions.delete(card.id);
    }
    setShared(ARCHIVE_SHARED, [...this.archived]);
    this.notice = `Archived ${plural(targets.length, "card")}.`;
    this.retainSelection(cx);
  }
  archiveAll(cx) {
    if (!this.settled()) {
      this.pendingArchiveAll = true;
      return;
    }
    if (enrichmentPending(this.state)) return;
    const done = this.columns().find((column) => column.id === "done")?.cards ?? [];
    for (const card of done) {
      if (!cardArchiveable(card, this.state)) continue;
      this.archived.add(archiveKey(this.workspace(), card.id, this.sources?.machine ?? null));
      this.questions.delete(card.id);
    }
    setShared(ARCHIVE_SHARED, [...this.archived]);
    this.retainSelection(cx);
  }

  confirmDeleteSelected(cx) {
    const card = this.selected();
    if (!card) { this.notify(cx); return; }
    this.confirmDeleteCard(card, cx);
  }
  // The first deliberate press arms the panel; a second one (or its Confirm
  // button) deletes. Selection changes, Esc, and opening help disarm it.
  confirmDeleteCard(card, cx) {
    if (!card?.id || this.deleting) return;
    this.focusSelection(card.id);
    this.dispatchMenuEpicId = null;
    this.helpOpen = false;
    if (this.deleteConfirmId === card.id) {
      this.deleteEpic(card, cx);
      return;
    }
    this.deleteConfirmId = card.id;
    this.notify(cx);
  }
  // The dispatcher owns the cascade and state cleanup. The board never removes
  // the card or local keys until the command exits successfully.
  deleteEpic(card, cx) {
    if (this.deleting || !card?.ref) return;
    this.deleting = true;
    this.deleteConfirmId = "";
    this.notice = "";
    const workspace = this.workspace();
    const machine = this.sources?.machine ?? this.machine();
    const folder = this.sources?.cwd || this.spaceFolder();
    const fallback = card.taskIds ?? [card.id];
    cx.spawn(async (taskCx) => {
      try {
        const cwd = await this.rootFolder(folder, machine);
        const result = await exec("aven-dispatch", deleteArgs(workspace, card.ref), machineOption(machine, cwd ? { cwd } : {}));
        if (result.code !== 0) throw new Error((result.stderr || "").trim() || `delete exited ${result.code}`);
        let outcome = null;
        try { outcome = safeDeleteOutcome(JSON.parse(result.stdout || "null")); } catch {}
        if (outcome && outcome.applied !== true) throw new Error("the dispatcher reported an inventory-only run");
        const ids = deletedTaskIds(outcome, fallback);
        const removed = new Set(ids);
        this.forgetDeleted(ids);
        this.state = { ...this.state, rows: this.state.rows.filter((row) => !removed.has(row.id)), error: "" };
        this.selectedId = "";
        this.selectedIds = [];
        this.notice = `Deleted ${plural(outcome?.tasks.length || ids.length, "task")}${
          outcome?.attemptsRemoved ? ` and removed ${plural(outcome.attemptsRemoved, "dispatch attempt")}` : ""}.`;
        this.retainSelection(taskCx);
        this.refresh(taskCx);
      } catch (error) {
        this.state = { ...this.state, error: `Delete failed: ${message(error)}` };
      } finally {
        this.deleting = false;
        this.notify(taskCx);
      }
    });
  }
  forgetDeleted(ids) {
    const workspace = this.workspace();
    const machine = this.sources?.machine ?? null;
    let archiveChanged = false;
    for (const id of ids) {
      archiveChanged = this.archived.delete(archiveKey(workspace, id, machine)) || archiveChanged;
      this.details.delete(detailCacheKey(workspace, id, machine));
      this.questions.delete(id);
    }
    const removed = new Set(ids);
    this.selectedIds = this.selectedIds.filter((id) => !removed.has(id));
    if (removed.has(this.selectedId)) this.selectedId = this.selectedIds.at(-1) ?? "";
    if (archiveChanged) setShared(ARCHIVE_SHARED, [...this.archived]);
    if (this.summaryCardId && ids.includes(this.summaryCardId)) this.summaryCardId = "";
    if (this.dispatchMenuEpicId && ids.includes(this.dispatchMenuEpicId)) this.dispatchMenuEpicId = null;
  }

  // Keep the refresh control's measured content constant. The spinner slot is
  // always present; only its visibility and pulse change while a read is in
  // flight, so the top bar never reflows on a timer or manual refresh.
  refreshButton(cx) {
    return h_flex().id("aven-kanban-refresh").flex_none().gap(6).px(9).py(3).rounded(5).items_center()
      .bg(C.raised).border(1).border_color(C.line2).text_color(C.text)
      .font_family(SANS).text_size(12).cursor_pointer().hover((style) => style.opacity(0.85))
      .on_mouse_down("left", (_event, clickCx) => clickCx.stop_propagation())
      .on_click((_event, clickCx) => { clickCx.stop_propagation(); this.refresh(clickCx); })
      .child("Refresh")
      .child(div().id("aven-kanban-refresh-spinner").w(8).h(8).flex_none().rounded(4)
        .when(this.refreshing, (spinner) => spinner.bg(C.accent)
          .loop("opacity", { from: 0.3, to: 1, period: 800 })));
  }

  btn(id, label, kind, onClick) {
    const [bg, fg, border] = kind === "you" ? [C.you, "#1a1300", C.you]
      : kind === "land" ? [C.land, "#08180f", C.land]
        : kind === "on" ? [C.you, "#1a1300", C.you]
          : kind === "danger" ? [C.red, "#1a0d10", C.red]
            : [C.raised, C.text, C.line2];
    return div().id(id).flex_none().px(9).py(3).rounded(5).bg(bg).border(1).border_color(border).text_color(fg)
      .font_family(SANS).text_size(12).cursor_pointer().hover((style) => style.opacity(0.85))
      .on_mouse_down("left", (_event, clickCx) => clickCx.stop_propagation())
      .on_click((_event, clickCx) => { clickCx.stop_propagation(); onClick(clickCx); }).child(label);
  }

  glyph(card) {
    const agent = this.relatedAgent(card);
    const program = agent?.program ?? this.programs[agent?.app] ?? null;
    if (program?.icon) {
      return program.tint
        ? svg(program.icon).size(14).flex_none().text_color(C.muted)
        : image(program.icon).w(14).h(14).flex_none();
    }
    const letter = String(program?.key ?? agent?.app ?? card.attempt?.workflow ?? "A").slice(0, 1).toUpperCase();
    return div().w(14).h(14).flex_none().rounded(3).bg(C.raised).flex().items_center().justify_center()
      .font_family(MONO).text_size(9).text_color(C.muted).child(letter);
  }

  projectChip(name) {
    const label = String(name ?? "").trim() || "unknown";
    const toneValue = tone(label);
    return div().flex_none().px(5).rounded(3).bg(toneValue.bg).text_color(toneValue.fg)
      .font_family(SANS).text_size(11).child(label);
  }

  cardWhen(card) {
    const agent = this.relatedAgent(card);
    const tab = agent ? this.renderTimes?.get(agent.address) : null;
    if (card.column === "needs_you") return tab?.changed ? `waiting ${dur(this.now - tab.changed)}` : "waiting";
    if (card.column === "working") return card.agentActive ? (tab?.working ? dur(this.now - tab.working) : "working") : card.status;
    if (card.column === "ready") return "ready";
    if (card.column === "done") return card.mergedOnMain ? "merged into main" : card.status;
    return card.planWorkedOut ? "planned out" : card.status;
  }

  cardFacts(card) {
    const facts = [];
    if (card.phases.total > 0) facts.push([`${card.phases.complete}/${card.phases.total} phases`, C.muted]);
    if (card.planWorkedOut) facts.push(["planned out", C.muted]);
    if (card.mergedOnMain) facts.push(["on main", C.land]);
    if (card.executionState) facts.push([card.executionState, C.muted]);
    if (card.deliveryState) facts.push([`delivery ${card.deliveryState}`, C.muted]);
    if (card.approved) facts.push(["✓ approved", C.land]);
    return facts;
  }

  dispatchMenu(card, cx) {
    return v_flex().id(`aven-kanban-actions-${card.id}`).pt(4).gap(2).children(DISPATCH_ACTIONS.map((action) =>
      h_flex().id(`aven-kanban-action-${action.id}-${card.id}`).px(5).py(4).gap(6).items_center().rounded(4)
        .cursor_pointer().hover((style) => style.bg(C.hover))
        .on_mouse_down("left", (_event, clickCx) => clickCx.stop_propagation())
        .on_click((_event, clickCx) => { clickCx.stop_propagation(); this.dispatch(card, action, clickCx ?? cx); })
        .child(div().w(28).flex_none().text_size(9).font_semibold().text_color(C.accent).child(action.label))
        .child(div().flex_1().min_w(0).text_size(9.5).text_color(C.text).child(action.description))));
  }

  deleteButton(card) {
    return this.btn(`aven-kanban-delete-${card.id}`, "Delete", "danger",
      (clickCx) => this.confirmDeleteCard(card, clickCx));
  }

  cardActions(card, cx) {
    const open = card.status !== "done" && card.status !== "canceled";
    const menuOpen = this.dispatchMenuEpicId === card.id;
    if (card.column === "needs_you") {
      return h_flex().flex_wrap().gap(6)
        .child(this.btn(`aven-kanban-answer-${card.id}`, "Answer", "you", () => this.answer(card)))
        .child(this.btn(`aven-kanban-go-${card.id}`, "Go to agent", "plain", (clickCx) => this.go(card, clickCx)))
        .child(this.deleteButton(card));
    }
    if (card.column === "done") {
      return h_flex().flex_wrap().gap(6)
        .when(cardArchiveable(card, this.state), (el) => el.child(
          this.btn(`aven-kanban-archive-${card.id}`, "Archive", "plain", (clickCx) => this.archive(card, clickCx))))
        .child(this.deleteButton(card));
    }
    const actions = [];
    if (card.mergeable) {
      actions.push(this.btn(`aven-kanban-merge-${card.id}`, "Merge", "land", (clickCx) => this.merge(card, clickCx)));
      actions.push(this.btn(`aven-kanban-ship-${card.id}`, "Ship PR", "plain", (clickCx) => this.ship(card, clickCx)));
    }
    if (this.relatedAgent(card)?.address || reopenTarget(card)) {
      actions.push(this.btn(`aven-kanban-go-${card.id}`, "Go to agent", "plain", (clickCx) => this.go(card, clickCx)));
    }
    if (open) {
      actions.push(this.btn(`aven-kanban-dispatch-${card.id}`, menuOpen ? "Dispatch ⌃" : "Dispatch ⌄", "plain", (clickCx) => {
        this.focusSelection(card.id);
        this.dispatchMenuEpicId = this.dispatchMenuEpicId === card.id ? null : card.id;
        this.notify(clickCx);
      }));
    }
    actions.push(this.btn(`aven-kanban-open-${card.id}`, "Open", "plain", (clickCx) => this.open(card, clickCx)));
    actions.push(this.deleteButton(card));
    return h_flex().flex_wrap().gap(6).children(actions);
  }

  card(card, cx) {
    const selected = this.selectedIds.includes(card.id) || card.id === this.selectedId;
    const multiSelected = this.selectedIds.length > 1 && this.selectedIds.includes(card.id);
    const summaryOpen = this.summaryCardId === card.id;
    const stop = (_event, clickCx) => clickCx.stop_propagation();
    const columnTone = TONES[BOARD_COLUMNS.find((column) => column.id === card.column)?.tone ?? "dim"] ?? C.dim;
    const whenColor = card.column === "needs_you" ? C.you : card.column === "ready" ? C.land : C.dim;
    return div().id(`aven-kanban-card-${card.id}`).w_full().flex_none().flex().flex_row().rounded(6).overflow_hidden()
      .bg(card.column === "needs_you" ? C.youCard : C.card).border(1).border_color(selected ? C.accent : C.line)
      .cursor_pointer().hover((style) => style.bg(C.hover))
      .on_click((event, clickCx) => this.selectCard(
        card,
        clickCx ?? cx,
        Boolean(event?.modifiers?.control || event?.modifiers?.platform),
      ))
      .child(div().w(3).flex_none().bg(columnTone))
      .child(v_flex().flex_1().min_w(0).px(10).py(8).gap(4)
        .child(h_flex().w_full().gap(6).items_center()
          .child(this.glyph(card))
          .child(this.projectChip(card.project))
          .when(multiSelected, (el) => el.child(mono(10, C.accent, "✓")))
          .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(10.5).text_color(C.dim).child(card.ref))
          .child(mono(10, whenColor, this.cardWhen(card))))
        .child(div().font_family(SANS).text_size(12.5).text_color(C.text).child(card.title))
        .when(card.summaryLines.length > 0, (el) => el.child(h_flex().id(`aven-kanban-summary-${card.id}`)
          .flex_none().gap(5).items_center().px(5).py(2).rounded(4).cursor_pointer()
          .hover((style) => style.bg(C.hover))
          .on_mouse_down("left", stop)
          .on_click((_event, clickCx) => {
            clickCx.stop_propagation();
            this.summaryCardId = summaryOpen ? "" : card.id;
            this.notify(clickCx);
          })
          .child(mono(9, C.accent, SUMMARY_LABEL))
          .when(card.summaryStale, (row) => row.child(mono(9, C.muted, "stale")))
          .when(card.summaryGenerating, (row) => row.child(mono(9, C.muted, "generating…")))
          .child(div().text_size(9).text_color(C.dim).child(summaryOpen ? "⌃" : "⌄"))))
        .when(summaryOpen && card.summaryLines.length > 0, (el) => el.child(v_flex().gap(1).pt(1)
          .children(card.summaryLines.map((line) => h_flex().w_full().min_w(0).gap(4).items_start()
            .child(mono(9, C.accent, "•"))
            .child(div().flex_1().min_w(0).whitespace_normal().font_family(SANS).text_size(10.5).text_color(C.text).child(line))))))
        .when(card.summaryLines.length === 0 && card.summaryGenerating, (el) => el.child(h_flex().gap(5).items_center().pt(1)
          .child(mono(9, C.accent, SUMMARY_LABEL))
          .child(mono(9, C.muted, "generating…"))))
        .when(card.column === "needs_you", (el) => el.child(v_flex().px(8).py(6).rounded(4).bg(C.youAsk)
          .child(mono(9.5, C.you, "ASKS YOU"))
          .child(div().font_family(SANS).text_size(11.5).text_color(C.soft)
            .child(this.question(card) || "The agent is waiting for you."))))
        .child(h_flex().flex_wrap().gap(9).children(this.cardFacts(card).map(([text, color]) => mono(10, color, text))))
        .when((card.openTasks?.length ?? 0) > 0 && card.column === "ready", (el) => el.child(v_flex()
          .id(`aven-kanban-open-tasks-${card.id}`).gap(1).pt(1)
          .child(mono(9, C.dim, "STILL OPEN"))
          .children(card.openTasks.map((task) => h_flex().w_full().min_w(0).gap(5).items_center()
            .child(mono(9, C.accent, task.ref))
            .child(div().flex_1().min_w(0).truncate().font_family(SANS).text_size(9.5).text_color(C.muted)
              .child(task.title || task.status || "open task"))))))
        .when(card.readyToMerge, (el) => el.child(h_flex().gap(5).items_center()
          .child(div().font_family(SANS).text_size(10.5).font_semibold().text_color(C.land).child("✓ ready to merge"))
          .child(div().font_family(SANS).text_size(9.5).text_color(C.dim).child("approved"))))
        .when(card.column === "ready" && !card.approved, (el) => el.child(div().font_family(SANS).text_size(9.5).text_color(C.dim)
          .child(card.approvalInvalid ? "approval incomplete or invalid; rerun /approve" : "awaiting approval")))
        .when(card.warnings.length > 0, (el) => el.child(mono(9.5, C.red, card.warnings.join(" "))))
        .child(this.cardActions(card, cx))
        .when(this.dispatchMenuEpicId === card.id, (el) => el.child(this.dispatchMenu(card, cx))));
  }

  // Multi-select is a board mode, not a hidden modifier: the bar names the
  // selection and shows only the actions that the existing per-card rules make
  // applicable. It stays absent for the ordinary single-card workflow.
  bulkBar(cx) {
    const cards = this.selectedCards();
    if (cards.length < 2) return null;
    const merge = bulkTargets(cards, "merge", this.state);
    const ship = bulkTargets(cards, "ship", this.state);
    const archive = bulkTargets(cards, "archive", this.state);
    return h_flex().id("aven-kanban-bulk").w_full().flex_none().gap(8).items_center().px(10).py(6).rounded(6)
      .bg(C.raised).border(1).border_color(C.accentDim)
      .child(mono(10.5, C.accent, `${cards.length} selected`))
      .when(merge.length > 0, (el) => el.child(this.btn(
        "aven-kanban-bulk-merge", `Merge ${merge.length}`, "land",
        (clickCx) => this.handoffCards(this.selectedCards(), "merge", clickCx))))
      .when(ship.length > 0, (el) => el.child(this.btn(
        "aven-kanban-bulk-ship", `Ship ${ship.length} PR${ship.length === 1 ? "" : "s"}`, "plain",
        (clickCx) => this.handoffCards(this.selectedCards(), "ship", clickCx))))
      .when(archive.length > 0, (el) => el.child(this.btn(
        "aven-kanban-bulk-archive", `Archive ${archive.length}`, "plain",
        (clickCx) => this.archiveCards(this.selectedCards(), clickCx))))
      .child(div().flex_1())
      .child(this.btn("aven-kanban-bulk-clear", "Clear", "plain", (clickCx) => this.clearSelection(clickCx)));
  }

  column(column, cx, focused = false) {
    const columnTone = TONES[column.tone] ?? C.dim;
    const empty = {
      backlog: "No unstarted epics.",
      needs_you: "Nothing needs you.",
      working: "Nothing running.",
      ready: "Nothing to land.",
      done: "All archived. Nice.",
    }[column.id] ?? "No epics.";
    return v_flex().id(`aven-kanban-column-${column.id}`).flex_1().min_w(0).min_h(0).gap(8)
      .child(h_flex().w_full().h(24).flex_none().gap(7).items_center().border_b(1)
        .border_color(focused ? C.accent : C.line)
        .child(column.id === "needs_you"
          ? div().w(7).h(7).rounded(4).bg(columnTone).loop("opacity", { from: 0.35, to: 1, period: 1200 })
          : div().w(7).h(7).rounded(4).bg(columnTone))
        .child(mono(11, focused ? C.text : C.muted, column.title))
        .child(div().px(5).rounded(8).bg(focused ? C.accentDim : C.raised)
          .font_family(MONO).text_size(10).text_color(focused ? C.text : C.muted).child(String(column.cards.length)))
        .child(div().flex_1())
        .when(column.id === "done" && column.cards.some((card) => cardArchiveable(card, this.state)), (el) => el.child(
          this.btn("aven-kanban-archive-all", "Archive all", "plain", (clickCx) => this.archiveAll(clickCx)))))
      .child(v_flex().id(`aven-kanban-list-${column.id}`).w_full().flex_1().min_h(0).gap(8).overflow_y_scrollbar()
        .children(column.cards.map((card) => this.card(card, cx)))
        .when(column.cards.length === 0, (el) => el.child(div().py(16).w_full().flex().justify_center()
          .font_family(SANS).text_size(12).text_color(C.dim).child(empty))));
  }

  stat(label, value, color, extra, windowed) {
    return v_flex().flex_1().min_w(0).px(12).py(8).rounded(8).border(1)
      .bg(windowed ? C.landBg : C.card).border_color(windowed ? C.landLine : C.line)
      .child(mono(10, C.dim, label))
      .child(div().font_family(SANS).text_size(22).text_color(color).child(String(value)))
      .children(extra ? [extra] : []);
  }

  topBar(stats, cx) {
    return h_flex().id("aven-kanban-top").h(38).flex_none().px(14).gap(10).items_center()
      .bg(C.top).border_b(1).border_color(C.line)
      .child(div().font_family(MONO).text_size(12).font_weight(700).text_color(C.accent).child("A V E N"))
      .child(h_flex().h_full().px(11).items_center().gap(7).relative()
        .child(div().font_family(MONO).text_size(12).text_color(C.text).child("▦ Board"))
        .when(stats.needsYou > 0, (el) => el.child(div().px(5).rounded(8).bg(C.you).text_color("#1a1300")
          .text_size(10).font_weight(700).child(String(stats.needsYou))))
        .child(div().absolute().bottom(0).left(8).right(8).h(2).rounded(1).bg(C.accent)))
      .child(div().w(1).h(16).mx(4).bg(C.line2))
      .child(mono(10, C.dim, `${plural(stats.total, "epic")}`))
      .when(Boolean(this.sources?.machine), (el) => el.child(mono(10, C.accentDim, `on ${this.sources.machine}`)))
      .child(div().flex_1())
      .child(this.btn("aven-kanban-help-toggle", "? Keys", "plain", (clickCx) => this.toggleHelp(clickCx)))
      .child(this.refreshButton(cx))
      .child(mono(10, C.dim, "Esc"));
  }

  strip(stats) {
    const week = landedWeek(this.state.rows, this.now);
    const max = Math.max(1, ...week);
    return div().w_full().flex_none().flex().flex_row().gap(10)
      .child(this.stat("LANDED THIS WEEK", landedWeekTotal(this.state.rows, this.now), C.land,
        v_flex().mt(4).gap(2)
          .child(h_flex().h(20).gap(4).items_end().children(week.map((count, index) =>
            div().flex_1().h(Math.max(2, Math.round(18 * count / max))).rounded(2).bg(C.land).opacity(index === 6 ? 1 : 0.3))))
          .child(h_flex().w_full().justify_between().children(LANDED_AXIS.map((index) =>
            mono(8, C.dim, String(index))))), true))
      .child(this.stat("NEEDS YOU", stats.needsYou, C.you))
      .child(this.stat("WORKING", stats.working, C.work))
      .child(this.stat("READY TO LAND", stats.ready, C.land))
      .child(this.stat("OPEN", stats.open, C.text, mono(10, C.dim, `${plural(stats.total, "epic")} total`)));
  }

  banner(card, cx) {
    if (!card) return null;
    const question = this.question(card);
    return h_flex().w_full().flex_none().gap(14).px(14).py(9).rounded(8).items_center()
      .bg(C.youBg).border(1).border_color(C.youLine)
      .child(mono(10, C.you, "NEXT MOVE"))
      .child(v_flex().flex_1().min_w(0)
        .child(div().font_family(SANS).text_size(14).text_color(C.text).truncate()
          .child(question ? `${card.ref} asks: “${question}”` : `${card.ref} needs you: ${card.title}`))
        .child(mono(10, C.muted, [card.project, this.cardWhen(card)].filter(Boolean).join(" · "))))
      .child(this.btn("aven-kanban-next-answer", "Answer  ⏎", "you", () => this.answer(card)))
      .child(this.btn("aven-kanban-next-go", "Go to agent", "plain", (clickCx) => this.go(card, clickCx)));
  }

  filterChip(id, label, count, alert, cx) {
    const on = id ? this.projectFilter === id : !this.projectFilter;
    return h_flex().id(`aven-kanban-chip-${id || "all"}`).flex_none().gap(6).px(8).py(2).rounded(5).items_center()
      .cursor_pointer().border(1).border_color(on ? C.accentDim : C.line2).bg(on ? "#1c1926" : "#00000000")
      .hover((style) => style.bg(C.hover))
      .on_click((_event, clickCx) => { clickCx.stop_propagation(); this.setProject(id, clickCx); })
      .when(Boolean(id), (el) => el.child(div().w(7).h(7).rounded(4).bg(tone(id).fg)))
      .child(mono(11, on ? C.text : C.soft, label))
      .child(mono(11, C.dim, String(count)))
      .when(alert, (el) => el.child(div().w(6).h(6).rounded(3).bg(C.you)));
  }

  chips(board, stats, cx) {
    const projects = projectChips(flattenBoard(board));
    return h_flex().w_full().flex_none().flex_wrap().gap(6).items_center()
      .child(this.filterChip("", "all", stats.total, stats.needsYou > 0, cx))
      .children(projects.map((project) => this.filterChip(project.id, project.label, project.count, project.needsYou, cx)))
      .child(div().flex_1())
      .child(mono(10, C.dim, "Created"))
      .children(CREATED_FILTERS.map((filter) => this.btn(
        `aven-kanban-filter-${filter.id}`, filter.label,
        this.createdFilter === filter.id ? "on" : "plain",
        (clickCx) => this.setFilter(filter.id, clickCx),
      )));
  }

  render(cx) {
    this.snapshotLive();
    // Build the board once; the project filter only narrows the cards, and the
    // same columns drive selection, stats, chips, and the banner.
    const board = this.boardColumns();
    const columns = filterBoardByProject(board, this.projectFilter);
    const stats = boardStats(columns);
    const allStats = boardStats(board);
    const next = nextMove(columns);
    const focusedColumn = this.selected(columns)?.column ?? "";
    const bulk = this.bulkBar(cx);
    const keyCommands = {
      escape: "close", j: "next", down: "next", k: "previous", up: "previous",
      h: "column-previous", left: "column-previous", l: "column-next", right: "column-next",
      tab: "column-next", "shift-tab": "column-previous",
      g: "first", "shift-g": "last", G: "last", home: "first", end: "last",
      1: "column-1", 2: "column-2", 3: "column-3", 4: "column-4", 5: "column-5",
      enter: "go", o: "open", a: "answer", "shift-a": "archive-all", A: "archive-all",
      "shift-s": "ship", S: "ship", x: "archive", "shift-d": "delete", delete: "delete",
      d: "dispatch", s: "plan-implement", p: "plan", i: "implement", m: "merge", r: "refresh",
      u: "summary", "?": "help", "shift-/": "help",
    };
    const pendingDelete = this.deleteConfirmId ? this.deletePanel(cx) : null;
    return v_flex().id("aven-kanban").relative().size_full().min_h(0).bg(C.main).text_color(C.text)
      .track_focus(this.handle)
      .on_size_change((_size, sizeCx) => { if (!this.closed) { this.handle.focus(); this.notify(sizeCx); } })
      .on_key_down((event, keyCx) => {
        const name = keyCommands[event.key];
        if (!name) return;
        this.command(name, keyCx);
        keyCx.stop_propagation();
        keyCx.notify();
      })
      .child(this.topBar(stats, cx))
      .child(v_flex().flex_1().min_h(0).px(16).pt(10).pb(10).gap(10)
        .child(this.strip(stats))
        .children(next ? [this.banner(next, cx)] : [])
        .when(Boolean(this.state.error), (el) => el.child(mono(10, C.red, `Aven: ${this.state.error}`)))
        .when(Boolean(this.notice), (el) => el.child(mono(10, C.land, this.notice)))
        .when(Boolean(this.state.coverageError), (el) => el.child(mono(10, C.red, `Incomplete metadata: ${this.state.coverageError}`)))
        .when(Boolean(this.reopening), (el) => el.child(mono(9.5, C.dim, `Reopening ${this.reopening}'s agent session…`)))
        .when(this.state.enriching, (el) => el.child(mono(9.5, C.dim, "Cards are visible now; loading epic metadata and plan badges…")))
        .when(this.state.evidencePending, (el) => el.child(mono(9.5, C.dim, "Checking local main for delivered work…")))
        .when(this.state.stale, (el) => el.child(mono(9.5, C.dim, "Showing last successful results (stale).")))
        .child(this.chips(board, allStats, cx))
        .children(bulk ? [bulk] : [])
        .child(h_flex().w_full().flex_none().gap(8).items_center()
          .child(mono(10, C.dim, "j/k card · h/l column · 1–5 column · ⏎ agent · o open · a answer · u summary · S ship · m merge · D delete · d dispatch · ctrl-click multi-select · ? keys"))
          .child(div().flex_1())
          .child(mono(10, C.dim, `${stats.total} of ${allStats.total} epics`)))
        .child(div().w_full().flex_1().min_h(0).flex().flex_row().gap(12)
          .when(this.state.loading, (el) => el.child(div().p(16).font_family(SANS).text_size(12).text_color(C.dim).child("Loading epics…")))
          .when(!this.state.loading && columns.every((column) => column.cards.length === 0), (el) => el.child(div().p(16)
            .font_family(SANS).text_size(12).text_color(C.dim)
            .child(allStats.total ? "No epics match this filter." : "No epics in this workspace.")))
          .when(!this.state.loading && columns.some((column) => column.cards.length > 0),
            (el) => el.children(columns.map((column) => this.column(column, cx, column.id === focusedColumn))))))
      .children(pendingDelete ? [pendingDelete] : [])
      .when(this.helpOpen, (el) => el.child(this.helpPanel(cx)));
  }

  deletePanel(cx) {
    const card = selectedCard(this.columns(), this.deleteConfirmId);
    if (!card) return null;
    const children = card.phases?.total ?? 0;
    return v_flex().id("aven-kanban-delete-confirm").absolute().top(50).right(16).w(520).p(16).gap(10).rounded(8)
      .bg(C.card).border(1).border_color(C.red)
      .child(h_flex().w_full().items_center()
        .child(div().flex_1().min_w(0).font_family(SANS).text_size(14).font_semibold().text_color(C.text)
          .child(`Delete ${card.ref}?`))
        .child(this.btn("aven-kanban-delete-cancel", "Cancel  Esc", "plain", (clickCx) => {
          this.deleteConfirmId = "";
          this.notify(clickCx);
        })))
      .child(div().whitespace_normal().font_family(SANS).text_size(12).text_color(C.soft)
        .child(`“${card.title}”${children > 0 ? ` and its ${plural(children, "child task")}` : " and any child tasks"} will be deleted.`))
      .child(mono(10, C.muted, "Dispatcher attempt/effect records are removed. Branches, worktrees, commits, sessions, and notes are kept."))
      .when(card.agentActive, (el) => el.child(mono(10, C.you, "A live agent is still working; its session is not stopped.")))
      .child(h_flex().gap(8).items_center()
        .child(this.btn("aven-kanban-delete-confirm", this.deleting ? "Deleting…" : "Delete permanently", "danger",
          (clickCx) => this.deleteEpic(card, clickCx)))
        .child(mono(10, C.dim, "Not restorable as a tree from the board.")));
  }

  helpPanel(cx) {
    const groups = [
      ["Navigation", [
        ["j / k  ↓ / ↑", "next / previous card in the focused column"],
        ["h / l  ← / →", "previous / next non-empty column"],
        ["Ctrl/⌘-click", "add or remove a card from the multi-selection"],
        ["g  Home", "jump to the top of the focused column"],
        ["Shift-G  End", "jump to the bottom of the focused column"],
        ["Tab / Shift-Tab", "next / previous column"],
        ["1 – 5", "jump to a column"],
      ]],
      ["Actions", [
        ["Enter", "focus, reopen, or open the epic's agent"],
        ["o", "open the epic in Aven"],
        ["a", "answer a Needs you card / archive a Done card"],
        ["Shift-A", "archive all visible Done cards"],
        ["Shift-S", "ship a PR from the approved card's task agent"],
        ["Shift-D  Del", "delete the selected epic, its child tasks, and their dispatch state"],
        ["m", "merge an approved card in its task agent"],
        ["m / Shift-S / x", "bulk merge / ship / archive when several cards are selected"],
        ["d", "toggle Dispatch"],
        ["u", "expand or collapse the LLM summary"],
        ["s / p / i", "plan-and-implement / plan / implement"],
        ["r", "refresh"],
        ["Esc", "clear a multi-selection, close help or Dispatch, then the board"],
      ]],
    ];
    return v_flex().id("aven-kanban-help").absolute().top(50).right(16).w(520).p(16).gap(10).rounded(8)
      .bg(C.card).border(1).border_color(C.accentDim)
      .child(h_flex().w_full().items_center()
        .child(div().flex_1().font_family(SANS).text_size(14).font_semibold().text_color(C.text).child("Keyboard"))
        .child(this.btn("aven-kanban-help-close", "Close  ?", "plain", (clickCx) => this.toggleHelp(clickCx))))
      .children(groups.map(([title, rows]) => v_flex().gap(4)
        .child(mono(10, C.muted, title.toUpperCase()))
        .children(rows.map(([keys, description]) => h_flex().gap(10).items_start()
          .child(div().w(140).flex_none().child(mono(10.5, C.accent, keys)))
          .child(div().flex_1().min_w(0).font_family(SANS).text_size(11.5).text_color(C.soft).child(description))))));
  }
}
