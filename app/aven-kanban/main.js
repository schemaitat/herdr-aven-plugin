import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, closeOverlay, exec, focused, hc, knownAgents, nextCommand, panes, props, run, setShared, shared, spaces, terminals } from "herdr";
import {
  ATTEMPT_LIMIT, BOARD_COLUMNS, CREATED_FILTERS, DISPATCH_ACTIONS, archiveKey, assertBoardCoverage, blockedAddress, boardStats,
  buildBoard, cardArchiveable, detailArgs, detailCacheKey, detailIsCurrent, detailNeedsRefresh, dispatchTerminalName,
  enrichmentPending, epicArgs, filterArchived, filterRowsByCreated, hydrateDetails, indexAttempts, isLiveEpicTerminal,
  landedWeek, lastQuestion, mapLimit, markMergedOnMain, mergeApprovalIssue, mergeEpicRows, mergePrompt, mergeTabArgs,
  mergeTabName, moveSelection, nextMove, openArgs, projectChips, safeDetail, selectAttempt, selectedCard, selectMainSpace,
  shipPrompt, shipTabName, terminalName, upcomingArgs,
} from "./logic.js";

const REFRESH_MS = 10000;
const QUESTION_MS = 5000;
const READ_WORKERS = 4;
const EVIDENCE_WORKERS = 4;
const READY_TIMEOUT_MS = 3000;
const READY_POLL_MS = 50;
const READY_SETTLE_MS = 700;
const ARCHIVE_SHARED = "aven-kanban.archived";
// Shared readiness marker: `{ seq, pending }` lets other mods (and the native
// E2E) distinguish a provisional frame from the authoritative one.
const ENRICHMENT_SHARED = "aven-kanban.enrichment";

// The reference Board palette. The overlay keeps its own look instead of
// depending on the app theme, as the layout does.
const C = {
  top: "#101012", side: "#0f0f11", main: "#121214", card: "#1a1a1d", raised: "#242328", hover: "#1f1f23",
  line: "#1e1e20", line2: "#2a2a30", text: "#e4e4e7", soft: "#c8c8cc", muted: "#8a898e", dim: "#56555b",
  accent: "#b4a0db", accentDim: "#625187",
  you: "#ffb406", youBg: "#1f1a10", youCard: "#1b1912", youAsk: "#241f12", youLine: "#4a3a12",
  work: "#8f7fd1", land: "#53cf91", landBg: "#12201a", landLine: "#1d3a2c", done: "#6fb3f2", red: "#e0707f",
};
const TONES = { dim: C.dim, attention: C.you, working: C.work, land: C.land, done: C.done };
const MONO = "JetBrains Mono";
const SANS = "Geist";
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
    this.sources = null;
    this.mainMerged = new Set();
    this.coverageError = "";
    this.enrichmentSeq = Number(shared(ENRICHMENT_SHARED)?.seq) || 0;
    this.pendingLaunches = new Set();
    this.pendingHandoffs = new Set();
    this.mainEvidence = { head: "", entries: new Map() };
    this.questions = new Map();
    this.programs = {};
    this.renderTimes = new Map();
    this.renderAgents = [];
    this.renderTerminals = [];
    const storedFilter = String(shared("aven-kanban.created-filter") ?? "");
    this.createdFilter = CREATED_FILTERS.some((filter) => filter.id === storedFilter) ? storedFilter : "all";
    this.projectFilter = String(shared("aven-kanban.project-filter") ?? "");
    const storedArchive = shared(ARCHIVE_SHARED);
    this.archived = new Set(Array.isArray(storedArchive) ? storedArchive.filter((value) => typeof value === "string") : []);
    this.selectedId = "";
    this.dispatchMenuEpicId = null;
    this.folder = String(props()?.cwd ?? "");
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (timerCx) => this.refresh(timerCx));
    cx.timer.every(QUESTION_MS, (timerCx) => this.readQuestions(timerCx));
    cx.timer.every(30000, (timerCx) => { this.now = Date.now(); this.notify(timerCx); });
    cx.spawn(async () => {
      try { for (const program of await knownAgents()) this.programs[program.key] = program; } catch {}
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
  spaceFolder() {
    const space = this.space();
    const focus = focused();
    return focus?.space === space?.id && focus.cwd
      ? focus.cwd
      : (space?.folder || this.folder || String(props()?.cwd ?? ""));
  }
  notify(cx) { if (!this.closed) { try { (cx ?? this.cx).notify(); } catch {} } }

  commands(cx) {
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (this.closed) return;
        const name = String(command).split(".").pop();
        if (name === "close") this.close();
        else if (name === "refresh") this.refresh(cx);
        else if (name === "next") this.select(1, cx);
        else if (name === "previous") this.select(-1, cx);
        else if (name === "open") this.openSelected(cx);
        else if (name === "go") this.goSelected(cx);
        else if (name === "answer") this.answerSelected(cx);
        else if (name === "ship") this.shipSelected(cx);
        else if (name === "archive") this.archiveSelected(cx);
        else if (name === "archive-all") this.archiveAll(cx);
        else if (name === "dispatch") this.toggleDispatch(cx);
        else if (name === "plan" || name === "plan-implement" || name === "implement") this.dispatchSelected(name, cx);
        else if (name === "merge") this.mergeSelected(cx);
        else cx.notify();
      }
    });
  }

  async rootFolder(folder) {
    if (!folder) {
      try {
        const current = await exec("pwd", []);
        folder = current.code === 0 ? current.stdout.trim() : "";
      } catch {}
    }
    if (!folder) return "";
    try {
      const result = await exec("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const common = result.code === 0 ? result.stdout.trim().replace(/\/+$/, "") : "";
      return common.endsWith("/.git") ? common.slice(0, -5) : folder;
    } catch { return folder; }
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
    const cwd = await this.rootFolder(this.spaceFolder());
    const [availableResult, upcomingResult, attemptsResult] = await Promise.all([
      exec("aven", epicArgs(workspace), cwd ? { cwd } : undefined),
      exec("aven", upcomingArgs(workspace), cwd ? { cwd } : undefined),
      exec("aven-dispatch", ["list", "--summary", "--limit", String(ATTEMPT_LIMIT)], cwd ? { cwd } : undefined),
    ]);
    const available = parseList(availableResult, "Epics");
    const upcoming = parseList(upcomingResult, "Upcoming epics");
    assertBoardCoverage({ available: available.length, upcoming: upcoming.length });
    const rawAttempts = parseList(attemptsResult, "Dispatcher attempts");
    assertBoardCoverage({ attempts: rawAttempts.length });
    const baseRows = mergeEpicRows({ available, upcoming });
    assertBoardCoverage({ epics: baseRows.length });
    const currentKeys = new Set(baseRows.map((row) => detailCacheKey(workspace, row.id)));
    for (const key of this.details.keys()) if (!currentKeys.has(key)) this.details.delete(key);
    const attemptIndex = indexAttempts(rawAttempts);
    return { workspace, cwd, available, upcoming, baseRows, attemptIndex, attempts: [...attemptIndex.values()].flat() };
  }

  mergedRows() {
    const sources = this.sources;
    if (!sources) return [];
    const details = {};
    for (const row of sources.baseRows) {
      const cached = this.details.get(detailCacheKey(sources.workspace, row.id));
      if (detailIsCurrent(cached, sources.workspace, row)) details[row.id] = cached.detail;
    }
    return markMergedOnMain(
      mergeEpicRows({ available: sources.available, upcoming: sources.upcoming, details }),
      this.mainMerged,
    );
  }

  publishRows(cx, flags = {}) {
    if (!this.sources || this.closed) return;
    const rows = this.mergedRows();
    // A project filter that no longer matches any epic is cleared rather than
    // presenting an unexplained empty board.
    if (this.projectFilter && !rows.some((row) => row.project === this.projectFilter)) {
      this.projectFilter = "";
      setShared("aven-kanban.project-filter", "");
    }
    this.state = {
      loading: false, rows, attempts: this.sources.attempts, attemptIndex: this.sources.attemptIndex,
      liveAgents: this.liveAgentsSnapshot(), error: "", stale: false,
      coverageError: this.coverageError,
      enriching: flags.enriching === true, evidencePending: flags.evidencePending === true,
    };
    this.publishEnrichment();
    this.retainSelection(cx);
  }

  publishEnrichment() {
    setShared(ENRICHMENT_SHARED, {
      seq: this.enrichmentSeq,
      pending: enrichmentPending(this.state),
    });
  }

  // Read-only delivery evidence for terminal cards. Exact attempt commits are
  // checked against one resolved local main head; this never mutates Aven or Git.
  // The checks run in the same small bounded pool as metadata reads, and each
  // commit's ancestry is cached for the current main head.
  async evidenceFromMain(cwd, rows, attemptIndex) {
    if (!cwd) return { merged: new Set(), error: "Local main is unavailable; delivery ancestry was not checked." };
    const terminal = [];
    for (const row of rows) {
      if (row.status !== "done" && row.status !== "canceled") continue;
      const attempt = selectAttempt(attemptIndex.get(row.id) ?? [], row.id).attempt;
      if (attempt) terminal.push({ row, attempt });
    }
    if (!terminal.length) return { merged: new Set(), error: "" };
    const headResult = await exec("git", ["-C", cwd, "rev-parse", "--verify", "main"]);
    if (headResult.code !== 0) {
      const detail = String(headResult.stderr ?? "").trim();
      return { merged: new Set(), error: `Local main is unavailable at ${cwd}; delivery ancestry was not checked${detail ? `: ${detail}` : "."}` };
    }
    const head = headResult.stdout.trim();
    if (this.mainEvidence.head !== head) this.mainEvidence = { head, entries: new Map() };
    const merged = new Set();
    await mapLimit(terminal, EVIDENCE_WORKERS, async ({ row, attempt }) => {
      const commits = new Set();
      if (attempt.branch) {
        const branch = await exec("git", ["-C", cwd, "rev-parse", "--verify", `${attempt.branch}^{commit}`]);
        if (branch.code === 0 && branch.stdout.trim()) commits.add(branch.stdout.trim());
      }
      if (attempt.worktree) {
        const worktree = await exec("git", ["-C", attempt.worktree, "rev-parse", "HEAD"]);
        if (worktree.code === 0 && worktree.stdout.trim()) commits.add(worktree.stdout.trim());
      }
      for (const commit of commits) {
        let contained = this.mainEvidence.entries.get(commit);
        if (contained === undefined) {
          const ancestry = await exec("git", ["-C", cwd, "merge-base", "--is-ancestor", commit, head]);
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
    this.refreshing = true;
    this.enrichmentSeq += 1;
    setShared(ENRICHMENT_SHARED, { seq: this.enrichmentSeq, pending: true });
    this.state = { ...this.state, loading: !this.state.rows.length, error: "" };
    this.notify(cx);
    cx.spawn(async (taskCx) => {
      try {
        const sources = await this.readSources();
        this.sources = sources;
        this.mainMerged = new Set();
        this.coverageError = "";
        const needed = sources.baseRows.filter((row) =>
          detailNeedsRefresh(this.details.get(detailCacheKey(sources.workspace, row.id)), sources.workspace, row)).length;
        // Publish provisional cards now; enrichment continues below.
        this.publishRows(taskCx, { enriching: needed > 0 });
        const hydration = await hydrateDetails({
          rows: sources.baseRows,
          workspace: sources.workspace,
          limit: READ_WORKERS,
          cached: (row) => this.details.get(detailCacheKey(sources.workspace, row.id)),
          read: async (row) => parse(
            await exec("aven", detailArgs(sources.workspace, row.ref), sources.cwd ? { cwd: sources.cwd } : undefined),
            `Epic ${row.ref}`,
          ),
          publish: (row, snapshot) => {
            const key = detailCacheKey(sources.workspace, row.id);
            // A failed read must not leave an older approval marker usable.
            if (snapshot) this.details.set(key, snapshot);
            else this.details.delete(key);
            this.publishRows(taskCx, { enriching: true });
          },
        });
        this.publishRows(taskCx, { evidencePending: true });
        const mainEvidence = await this.evidenceFromMain(sources.cwd, this.mergedRows(), sources.attemptIndex);
        this.mainMerged = mainEvidence.merged;
        const coverage = [];
        if (hydration.failures.length) coverage.push(`${hydration.failures.length} epic metadata read(s) failed: ${hydration.failures.slice(0, 3).join("; ")}`);
        if (mainEvidence.error) coverage.push(mainEvidence.error);
        this.coverageError = coverage.join("; ");
        this.publishRows(taskCx, {});
      } catch (error) {
        this.state = {
          ...this.state, loading: false, error: message(error), stale: this.state.rows.length > 0,
          enriching: false, evidencePending: false,
        };
        this.publishEnrichment();
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
    return filterArchived(filterRowsByCreated(this.state.rows, this.createdFilter), this.archived, this.workspace());
  }
  visibleRows() {
    const rows = this.createdRows();
    return this.projectFilter ? rows.filter((row) => row.project === this.projectFilter) : rows;
  }
  boardColumns() {
    return buildBoard({ rows: this.createdRows(), attemptIndex: this.state.attemptIndex, liveAgents: this.state.liveAgents ?? [] });
  }
  columns() {
    return buildBoard({ rows: this.visibleRows(), attemptIndex: this.state.attemptIndex, liveAgents: this.state.liveAgents ?? [] });
  }
  selected() { return selectedCard(this.columns(), this.selectedId); }
  retainSelection(cx) {
    const columns = this.columns();
    this.selectedId = selectedCard(columns, this.selectedId)?.id ?? moveSelection(columns, "", 1);
    this.notify(cx);
  }

  setFilter(id, cx) {
    if (!CREATED_FILTERS.some((filter) => filter.id === id)) return;
    this.createdFilter = id;
    setShared("aven-kanban.created-filter", id);
    this.retainSelection(cx);
  }
  setProject(id, cx) {
    this.projectFilter = this.projectFilter === id ? "" : id;
    setShared("aven-kanban.project-filter", this.projectFilter);
    this.retainSelection(cx);
  }

  select(delta, cx) {
    this.selectedId = moveSelection(this.columns(), this.selectedId, delta);
    this.dispatchMenuEpicId = null;
    this.notify(cx);
  }

  selectCard(card, cx) {
    this.selectedId = card.id;
    this.dispatchMenuEpicId = null;
    this.notify(cx);
  }

  times() {
    const tabs = new Map();
    for (const space of spaces()) for (const tab of space.tabs ?? []) tabs.set(tab.id, tab);
    const out = new Map();
    for (const agent of agents()) {
      const tab = tabs.get(agent.tab);
      if (tab) out.set(agent.address, { changed: tab.changed_at, working: tab.working_since });
    }
    return out;
  }

  relatedAgent(card) {
    const attempts = card.relatedAttempts?.length ? card.relatedAttempts : (card.attempt ? [card.attempt] : []);
    const addresses = card.column === "needs_you"
      ? [blockedAddress(attempts, this.state.liveAgents)].filter(Boolean)
      : attempts.map((attempt) => attempt.terminal?.address).filter(Boolean);
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
    this.renderAgents = agents();
    this.renderTerminals = terminals();
    const cards = this.columns().find((column) => column.id === "needs_you")?.cards ?? [];
    if (!cards.length) {
      if (this.questions.size) { this.questions.clear(); this.notify(cx); }
      return;
    }
    this.asking = true;
    try {
      let changed = false;
      const alive = new Set();
      for (const card of cards) {
        const agent = this.relatedAgent(card);
        if (!agent?.address) continue;
        alive.add(card.id);
        let text = "";
        try {
          const result = await exec("hc", ["read", agent.address]);
          if (result.code === 0) text = lastQuestion(result.stdout);
        } catch {}
        const current = this.questions.get(card.id);
        if (!current || current.address !== agent.address || current.text !== text) {
          this.questions.set(card.id, { address: agent.address, text });
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
  answerSelected(cx) {
    const card = this.selected();
    if (card && this.answer(card)) return;
    this.notify(cx);
  }
  goSelected(cx) {
    const card = this.selected();
    if (card && this.jumpToAgent(card)) return;
    this.openSelected(cx);
  }
  shipSelected(cx) { const card = this.selected(); if (card) this.ship(card, cx); }
  archiveSelected(cx) {
    const card = this.selected();
    if (card?.column === "done") this.archive(card, cx);
    else this.notify(cx);
  }

  openSelected(cx) {
    const card = this.selected();
    if (!card) return;
    if (this.jumpToAgent(card)) return;
    this.open(card, cx);
  }
  dispatchSelected(actionId, cx) {
    const card = this.selected();
    const action = DISPATCH_ACTIONS.find((candidate) => candidate.id === actionId);
    if (card && action) this.dispatch(card, action, cx);
  }
  mergeSelected(cx) { const card = this.selected(); if (card) this.merge(card, cx); }
  toggleDispatch(cx) {
    const card = this.selected();
    if (!card || card.status === "done" || card.status === "canceled") return;
    this.dispatchMenuEpicId = this.dispatchMenuEpicId === card.id ? null : card.id;
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
    const identity = terminalName(workspace, epic.id);
    if (this.pendingLaunches.has(identity)) return;
    const existing = terminals().find((terminal) => isLiveEpicTerminal(terminal, workspace, epic.id));
    if (existing) { void this.reveal(existing.address, cx); return; }
    this.pendingLaunches.add(identity);
    cx.spawn(async (taskCx) => {
      try {
        const cwd = await this.rootFolder(this.spaceFolder());
        const name = `${identity}${Date.now().toString(36)}`;
        const result = await hc(openArgs({ workspace, epic, cwd, name }));
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
    const identity = `${terminalName(workspace, epic.id)}\u0000${action.id}`;
    const prefix = dispatchTerminalName(workspace, epic.id, action);
    if (this.pendingLaunches.has(identity)) return;
    const existing = terminals().find((terminal) => terminal.state === "live" && String(terminal.name ?? "").startsWith(prefix));
    if (existing) { void this.reveal(existing.address, cx); return; }
    this.pendingLaunches.add(identity);
    this.dispatchMenuEpicId = null;
    cx.spawn(async (taskCx) => {
      try {
        const cwd = await this.rootFolder(this.spaceFolder());
        const name = `${prefix}${Date.now().toString(36)}`;
        const started = await hc(openArgs({ workspace, epic, cwd, name }));
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

  async handoffAgent() {
    const configured = shared("aven-kanban.merge-agent");
    if (Array.isArray(configured) && configured.length > 0 && configured.every((part) => typeof part === "string")) {
      return configured;
    }
    try {
      const installed = (await knownAgents())
        .filter((agent) => agent?.installed && Array.isArray(agent.run) && agent.run.length > 0);
      const preferred = installed.find((agent) =>
        /opencode/i.test(`${agent.key ?? ""} ${agent.name ?? ""} ${agent.run.join(" ")}`));
      const chosen = preferred ?? installed[0];
      if (chosen) return chosen.run;
    } catch {}
    return ["opencode"];
  }

  async exactDetail(workspace, epic, cwd) {
    const result = await exec("aven", detailArgs(workspace, epic.ref), cwd ? { cwd } : undefined);
    const detail = safeDetail(parse(result, `Epic ${epic.ref}`));
    if (detail.task.id !== epic.id || !detail.task.is_epic) {
      throw new Error(`approval identity mismatch for ${epic.ref}`);
    }
    return detail;
  }

  // Merge and Ship PR are handoffs: re-read approval now, then open a
  // task-named tab in the main space. The board never mutates Git itself.
  handoff(epic, kind, cx) {
    const identity = `${kind}\u0000${epic.id}`;
    if (!epic.mergeable || this.pendingHandoffs.has(identity)) return;
    this.pendingHandoffs.add(identity);
    cx.spawn(async (taskCx) => {
      const label = kind === "ship" ? "Ship PR" : "Merge";
      try {
        const root = await this.rootFolder(this.spaceFolder());
        if (!root) throw new Error("the primary checkout is unavailable");
        const workspace = this.workspace();
        // Re-read the exact task now: a cached or stale approval marker must
        // never open a handoff. The dispatcher journal still validates it.
        const detail = await this.exactDetail(workspace, epic, root);
        const issue = mergeApprovalIssue(detail.task, detail.metadata);
        if (issue) {
          this.details.delete(detailCacheKey(workspace, epic.id));
          throw new Error(`${epic.ref} has no complete durable approval (${issue}); rerun /approve.`);
        }
        const activeSpaceId = focused()?.space ?? spaces().find((space) => space.active)?.id ?? "";
        const target = selectMainSpace(spaces(), root, activeSpaceId, panes());
        if (!target?.id) throw new Error("no main app space is available");
        const name = kind === "ship" ? shipTabName(epic) : mergeTabName(epic);
        const existing = (target.tabs ?? []).find((tab) => tab.name === name);
        if (existing) {
          run("tab.select", { id: existing.id });
          const agent = agents().find((candidate) => candidate.tab === existing.id);
          if (agent?.address) run("agent.focus", { terminal: agent.address });
          this.close();
          return;
        }
        const argv = await this.handoffAgent();
        const task = kind === "ship" ? shipPrompt(epic) : mergePrompt(epic);
        const result = await exec("herdr-app", mergeTabArgs({
          name, space: target.id, folder: root, argv, task,
        }));
        if (result.code !== 0) throw new Error((result.stderr || "").trim() || `could not open the ${label.toLowerCase()} agent`);
        this.close();
      } catch (error) {
        this.state = { ...this.state, error: `${label} handoff failed: ${message(error)}` };
      } finally {
        this.pendingHandoffs.delete(identity);
        this.notify(taskCx);
      }
    });
  }
  merge(epic, cx) { this.handoff(epic, "merge", cx); }
  ship(epic, cx) { this.handoff(epic, "ship", cx); }

  archive(card, cx) {
    // Archive keys are immutable IDs, so a provisional or unhydrated card must
    // never be archived under a classification that enrichment may change.
    if (!cardArchiveable(card, this.state)) return;
    this.archived.add(archiveKey(this.workspace(), card.id));
    setShared(ARCHIVE_SHARED, [...this.archived]);
    this.questions.delete(card.id);
    this.retainSelection(cx);
  }
  archiveAll(cx) {
    if (enrichmentPending(this.state)) return;
    const done = this.columns().find((column) => column.id === "done")?.cards ?? [];
    for (const card of done) {
      if (!cardArchiveable(card, this.state)) continue;
      this.archived.add(archiveKey(this.workspace(), card.id));
      this.questions.delete(card.id);
    }
    setShared(ARCHIVE_SHARED, [...this.archived]);
    this.retainSelection(cx);
  }

  btn(id, label, kind, onClick) {
    const [bg, fg, border] = kind === "you" ? [C.you, "#1a1300", C.you]
      : kind === "land" ? [C.land, "#08180f", C.land]
        : kind === "on" ? [C.you, "#1a1300", C.you]
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
    const tab = agent ? (this.renderTimes.get(agent.address) ?? this.times().get(agent.address)) : null;
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

  cardActions(card, cx) {
    const open = card.status !== "done" && card.status !== "canceled";
    const menuOpen = this.dispatchMenuEpicId === card.id;
    if (card.column === "needs_you") {
      return h_flex().flex_wrap().gap(6)
        .child(this.btn(`aven-kanban-answer-${card.id}`, "Answer", "you", () => this.answer(card)))
        .child(this.btn(`aven-kanban-go-${card.id}`, "Go to agent", "plain", () => this.jumpToAgent(card)));
    }
    if (card.column === "done") {
      return h_flex().flex_wrap().gap(6)
        .when(cardArchiveable(card, this.state), (el) => el.child(
          this.btn(`aven-kanban-archive-${card.id}`, "Archive", "plain", (clickCx) => this.archive(card, clickCx))));
    }
    const actions = [];
    if (card.mergeable) {
      actions.push(this.btn(`aven-kanban-merge-${card.id}`, "Merge", "land", (clickCx) => this.merge(card, clickCx)));
      actions.push(this.btn(`aven-kanban-ship-${card.id}`, "Ship PR", "plain", (clickCx) => this.ship(card, clickCx)));
    }
    if (this.relatedAgent(card)?.address) {
      actions.push(this.btn(`aven-kanban-go-${card.id}`, "Go to agent", "plain", () => this.jumpToAgent(card)));
    }
    if (open) {
      actions.push(this.btn(`aven-kanban-dispatch-${card.id}`, menuOpen ? "Dispatch ⌃" : "Dispatch ⌄", "plain", (clickCx) => {
        this.selectedId = card.id;
        this.dispatchMenuEpicId = this.dispatchMenuEpicId === card.id ? null : card.id;
        this.notify(clickCx);
      }));
    }
    actions.push(this.btn(`aven-kanban-open-${card.id}`, "Open", "plain", (clickCx) => this.open(card, clickCx)));
    return h_flex().flex_wrap().gap(6).children(actions);
  }

  card(card, cx) {
    const selected = card.id === this.selectedId;
    const columnTone = TONES[BOARD_COLUMNS.find((column) => column.id === card.column)?.tone ?? "dim"] ?? C.dim;
    const whenColor = card.column === "needs_you" ? C.you : card.column === "ready" ? C.land : C.dim;
    return div().id(`aven-kanban-card-${card.id}`).w_full().flex_none().flex().flex_row().rounded(6).overflow_hidden()
      .bg(card.column === "needs_you" ? C.youCard : C.card).border(1).border_color(selected ? C.accentDim : C.line)
      .cursor_pointer().hover((style) => style.bg(C.hover))
      .on_click((_event, clickCx) => this.selectCard(card, clickCx ?? cx))
      .child(div().w(3).flex_none().bg(columnTone))
      .child(v_flex().flex_1().min_w(0).px(10).py(8).gap(4)
        .child(h_flex().w_full().gap(6).items_center()
          .child(this.glyph(card))
          .child(this.projectChip(card.project))
          .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(10.5).text_color(C.dim).child(card.ref))
          .child(mono(10, whenColor, this.cardWhen(card))))
        .child(div().font_family(SANS).text_size(12.5).text_color(C.text).child(card.title))
        .when(card.column === "needs_you", (el) => el.child(v_flex().px(8).py(6).rounded(4).bg(C.youAsk)
          .child(mono(9.5, C.you, "ASKS YOU"))
          .child(div().font_family(SANS).text_size(11.5).text_color(C.soft)
            .child(this.question(card) || "The agent is waiting for you."))))
        .child(h_flex().flex_wrap().gap(9).children(this.cardFacts(card).map(([text, color]) => mono(10, color, text))))
        .when(card.readyToMerge, (el) => el.child(h_flex().gap(5).items_center()
          .child(div().font_family(SANS).text_size(10.5).font_semibold().text_color(C.land).child("✓ ready to merge"))
          .child(div().font_family(SANS).text_size(9.5).text_color(C.dim).child("approved"))))
        .when(card.column === "ready" && !card.approved, (el) => el.child(div().font_family(SANS).text_size(9.5).text_color(C.dim)
          .child(card.approvalInvalid ? "approval incomplete or invalid; rerun /approve" : "awaiting approval")))
        .when(card.warnings.length > 0, (el) => el.child(mono(9.5, C.red, card.warnings.join(" "))))
        .child(this.cardActions(card, cx))
        .when(this.dispatchMenuEpicId === card.id, (el) => el.child(this.dispatchMenu(card, cx))));
  }

  column(column, cx) {
    const columnTone = TONES[column.tone] ?? C.dim;
    const empty = {
      backlog: "No unstarted epics.",
      needs_you: "Nothing needs you.",
      working: "Nothing running.",
      ready: "Nothing to land.",
      done: "All archived. Nice.",
    }[column.id] ?? "No epics.";
    return v_flex().id(`aven-kanban-column-${column.id}`).flex_1().min_w(0).min_h(0).gap(8)
      .child(h_flex().w_full().h(22).flex_none().gap(7).items_center()
        .child(column.id === "needs_you"
          ? div().w(7).h(7).rounded(4).bg(columnTone).loop("opacity", { from: 0.35, to: 1, period: 1200 })
          : div().w(7).h(7).rounded(4).bg(columnTone))
        .child(mono(11, C.dim, column.title))
        .child(div().px(5).rounded(8).bg(C.raised).font_family(MONO).text_size(10).text_color(C.muted).child(String(column.cards.length)))
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
      .child(div().flex_1())
      .child(this.btn("aven-kanban-refresh", this.refreshing ? "Refreshing…" : "Refresh", "plain", (clickCx) => this.refresh(clickCx)))
      .child(mono(10, C.dim, "Esc"));
  }

  strip(stats) {
    const week = landedWeek(this.state.rows, this.now);
    const max = Math.max(1, ...week);
    return div().w_full().flex_none().flex().flex_row().gap(10)
      .child(this.stat("LANDED TODAY", week[6], C.land,
        h_flex().h(20).mt(4).gap(4).items_end().children(week.map((count, index) =>
          div().flex_1().h(Math.max(2, Math.round(18 * count / max))).rounded(2).bg(C.land).opacity(index === 6 ? 1 : 0.3))), true))
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
      .child(this.btn("aven-kanban-next-go", "Go to agent", "plain", () => this.jumpToAgent(card)));
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

  chips(board, cx) {
    const cards = board.flatMap((column) => column.cards);
    const projects = projectChips(cards);
    const stats = boardStats(board);
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
    this.renderAgents = agents();
    this.renderTerminals = terminals();
    this.renderTimes = this.times();
    // Build the board once; the project filter only narrows the cards, it does
    // not need a second pass over every epic and live agent.
    const board = this.boardColumns();
    const columns = this.projectFilter
      ? board.map((column) => ({ ...column, cards: column.cards.filter((card) => card.project === this.projectFilter) }))
      : board;
    const stats = boardStats(columns);
    const allStats = boardStats(board);
    const next = nextMove(columns);
    return v_flex().id("aven-kanban").size_full().min_h(0).bg(C.main).text_color(C.text)
      .track_focus(this.handle)
      .on_size_change((_size, sizeCx) => { if (!this.closed) { this.handle.focus(); this.notify(sizeCx); } })
      .on_key_down((event, keyCx) => {
        const key = event.key;
        const card = this.selected();
        if (key === "escape") {
          if (this.dispatchMenuEpicId) { this.dispatchMenuEpicId = null; this.notify(keyCx); }
          else this.close();
        } else if (key === "j" || key === "down") this.select(1, keyCx);
        else if (key === "k" || key === "up") this.select(-1, keyCx);
        else if (key === "enter" || key === "o") this.openSelected(keyCx);
        else if (key === "g") this.goSelected(keyCx);
        else if (key === "a") {
          if (card?.column === "needs_you") this.answer(card);
          else if (card?.column === "done") this.archive(card, keyCx);
        }
        else if (key === "A") this.archiveAll(keyCx);
        else if (key === "h") this.shipSelected(keyCx);
        else if (key === "d") this.toggleDispatch(keyCx);
        else if (key === "s") this.dispatchSelected("plan-implement", keyCx);
        else if (key === "p") this.dispatchSelected("plan", keyCx);
        else if (key === "i") this.dispatchSelected("implement", keyCx);
        else if (key === "m") this.mergeSelected(keyCx);
        else if (key === "r") this.refresh(keyCx);
        else return;
        keyCx.stop_propagation();
        keyCx.notify();
      })
      .child(this.topBar(stats, cx))
      .child(v_flex().flex_1().min_h(0).px(16).pt(10).pb(10).gap(10)
        .child(this.strip(stats))
        .children(next ? [this.banner(next, cx)] : [])
        .when(Boolean(this.state.error), (el) => el.child(mono(10, C.red, `Aven: ${this.state.error}`)))
        .when(Boolean(this.state.coverageError), (el) => el.child(mono(10, C.red, `Incomplete metadata: ${this.state.coverageError}`)))
        .when(this.state.enriching, (el) => el.child(mono(9.5, C.dim, "Cards are visible now; loading epic metadata and plan badges…")))
        .when(this.state.evidencePending, (el) => el.child(mono(9.5, C.dim, "Checking local main for delivered work…")))
        .when(this.state.stale, (el) => el.child(mono(9.5, C.dim, "Showing last successful results (stale).")))
        .child(this.chips(board, cx))
        .child(h_flex().w_full().flex_none().gap(8).items_center()
          .child(mono(10, C.dim, "j/k move · ⏎ go to agent · a answer/archive · g go · h ship · m merge · d dispatch · r refresh"))
          .child(div().flex_1())
          .child(mono(10, C.dim, `${stats.total} of ${allStats.total} epics`)))
        .child(div().w_full().flex_1().min_h(0).flex().flex_row().gap(12)
          .when(this.state.loading, (el) => el.child(div().p(16).font_family(SANS).text_size(12).text_color(C.dim).child("Loading epics…")))
          .when(!this.state.loading && columns.every((column) => column.cards.length === 0), (el) => el.child(div().p(16)
            .font_family(SANS).text_size(12).text_color(C.dim)
            .child(allStats.total ? "No epics match this filter." : "No epics in this project.")))
          .when(!this.state.loading && columns.some((column) => column.cards.length > 0),
            (el) => el.children(columns.map((column) => this.column(column, cx))))));
  }
}
