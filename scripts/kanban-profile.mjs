#!/usr/bin/env node
// Read-only replay of the Aven Kanban board's bounded reads.
//
// The board's cost is process spawns, not raw table scans: one bounded list
// read per source, one `aven show --full` per epic that needs metadata, and a
// small git probe per terminal attempt. This profiler performs the same reads
// against a chosen checkout/workspace and prints counts, bytes, elapsed time,
// and spawned-process counts so an optimization can be measured. It never
// writes to Aven, Git, or the dispatcher store.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ATTEMPT_LIMIT, LIMIT, detailArgs, epicArgs, mapLimit, obligationListArgs,
  upcomingArgs,
} from "../app/aven-kanban/logic.js";

const run = promisify(execFile);
const WORKERS = 4;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const workspace = option("--workspace", "default");
const requestedCwd = option("--cwd", process.cwd());
// `cheap` models a steady-state refresh with nothing changed; `full` models
// the periodic revalidation tier (or the first paint).
const tier = option("--tier", "full");
const maxBuffer = 64 * 1024 * 1024;

let processes = 0;
async function spawn(command, args, cwd) {
  processes += 1;
  const started = performance.now();
  try {
    const { stdout, stderr } = await run(command, args, { cwd, maxBuffer });
    return { code: 0, stdout, stderr, ms: performance.now() - started };
  } catch (error) {
    // A branch from another project never resolves in this checkout. The board
    // treats that as an evidence miss, so the profiler does too.
    return {
      code: typeof error?.code === "number" ? error.code : 1,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? ""),
      ms: performance.now() - started,
    };
  }
}

async function gitFolder(folder) {
  if (!folder) return "";
  const result = await spawn("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"], folder);
  if (result.code !== 0) return "";
  const common = result.stdout.trim().replace(/\/+$/, "");
  return common.endsWith("/.git") ? common.slice(0, -5) : folder;
}

function parseList(result, label) {
  if (result.code !== 0) throw new Error(`${label}: ${result.stderr.trim() || `exit ${result.code}`}`);
  const value = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(value)) throw new Error(`${label}: expected a JSON list`);
  return value;
}

const cwd = await gitFolder(requestedCwd);
const scope = cwd ? { cwd } : undefined;

const started = performance.now();
const listProcessesBefore = processes;
const [epicsResult, upcomingResult, obligationsResult, attemptsResult] = await Promise.all([
  spawn("aven", epicArgs(workspace), cwd || undefined),
  spawn("aven", upcomingArgs(workspace), cwd || undefined),
  spawn("aven", obligationListArgs(workspace), cwd || undefined),
  spawn("aven-dispatch", ["list", "--summary", "--limit", String(ATTEMPT_LIMIT)], cwd || undefined),
]);
const listMs = performance.now() - started;
const listProcesses = processes - listProcessesBefore;

const epics = parseList(epicsResult, "Epics");
const upcoming = parseList(upcomingResult, "Upcoming epics");
const obligations = parseList(obligationsResult, "Delivery obligations");
const attempts = parseList(attemptsResult, "Dispatcher attempts");

// The board always revalidates terminal epics; include only that set here so
// the number is comparable with the pre-optimization refresh.
const details = epics.filter((row) => row.status === "done" || row.status === "canceled");
const terminalIds = new Set(details.map((row) => row.id));
const evidenceAttempts = attempts.filter((attempt) => terminalIds.has(attempt.task_id));

let detailMs = 0;
let detailProcesses = 0;
let evidenceMs = 0;
let evidenceProcesses = 0;
if (tier === "full") {
  const detailStarted = performance.now();
  const detailProcessesBefore = processes;
  await mapLimit(details, WORKERS, async (row) => {
    await spawn("aven", detailArgs(workspace, row.ref), scope?.cwd);
  });
  detailMs = performance.now() - detailStarted;
  detailProcesses = processes - detailProcessesBefore;

  const evidenceStarted = performance.now();
  const evidenceProcessesBefore = processes;
  await mapLimit(evidenceAttempts, WORKERS, async (attempt) => {
    if (attempt.branch) await spawn("git", ["-C", cwd, "rev-parse", "--verify", `${attempt.branch}^{commit}`], cwd);
    if (attempt.worktree) await spawn("git", ["-C", attempt.worktree, "rev-parse", "HEAD"], cwd);
  });
  evidenceMs = performance.now() - evidenceStarted;
  evidenceProcesses = processes - evidenceProcessesBefore;
} else if (tier === "cheap") {
  // The board still probes the main head when terminal attempts exist so a
  // merge is noticed on the next tick; nothing else is re-read.
  const cheapEvidenceBefore = processes;
  if (cwd && evidenceAttempts.length) await spawn("git", ["-C", cwd, "rev-parse", "--verify", "main"], cwd);
  evidenceProcesses = processes - cheapEvidenceBefore;
  evidenceMs = 0;
}

const report = {
  tier,
  workspace,
  cwd: cwd || null,
  limits: { epics: LIMIT, attempts: ATTEMPT_LIMIT, workers: WORKERS },
  counts: {
    epics: epics.length,
    upcoming: upcoming.length,
    obligations: obligations.length,
    attempts: attempts.length,
    detailEpics: details.length,
    evidenceAttempts: evidenceAttempts.length,
  },
  bytes: {
    epics: epicsResult.stdout.length,
    upcoming: upcomingResult.stdout.length,
    obligations: obligationsResult.stdout.length,
    attempts: attemptsResult.stdout.length,
  },
  stages: {
    listMs: Math.round(listMs),
    detailMs: Math.round(detailMs),
    evidenceMs: Math.round(evidenceMs),
    totalMs: Math.round(performance.now() - started),
  },
  processes: {
    list: listProcesses,
    detail: detailProcesses,
    evidence: evidenceProcesses,
    total: processes,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
