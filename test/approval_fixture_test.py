"""Process-level approval and isolated integration contracts (no LLM calls)."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

plugin, scratch = map(Path, sys.argv[1:])
binary = plugin / "target/debug/aven-dispatch"
assert binary.is_file(), "cargo build first"


class Case:
    def __init__(self, name):
        self.root = scratch / name
        self.repo = self.root / "repo"
        self.repo.mkdir(parents=True)
        self.state = self.root / "aven.json"
        self.store = self.root / "dispatch.sqlite"
        self.fail = self.root / "fail-publication"
        fake = self.root / "bin"
        fake.mkdir()
        aven = fake / "aven"
        aven.write_text(
            f'#!/bin/sh\nif [ -e "{self.fail}" ]; then\n'
            '  for arg in "$@"; do case "$arg" in delivery.state=*) '
            'echo "fixture publication unavailable" >&2; exit 1;; esac; done\nfi\n'
            f'exec python3 "{plugin / "test/aven_fixture.py"}" "$@"\n'
        )
        opencode = fake / "opencode"
        opencode.write_text(f'#!/bin/sh\nexec python3 "{plugin / "test/opencode_fixture.py"}" "$@"\n')
        aven.chmod(0o755)
        opencode.chmod(0o755)
        self.env = dict(os.environ, AVEN_BIN=str(aven), OPENCODE_BIN=str(opencode),
                        PATH=str(fake) + os.pathsep + os.environ.get("PATH", ""),
                        AVEN_FIXTURE_STATE=str(self.state), HC_BIN=str(plugin / "test/hc_fixture.py"),
                        HC_FIXTURE_STATE=str(self.root / "hc"), HC_SESSION="approval-fixture",
                        AVEN_WORKTREE_ROOT=str(self.root / "worktrees"),
                        OPENCODE_FIXTURE_OUTCOME="succeeded", HERDR_APP_BIN="/bin/false")
        # Never inherit routing/isolation settings from the user's dispatch.
        for key in ("AVEN_DB", "AVEN_DISPATCH_STORE", "AVEN_FIXTURE_LOG", "OPENCODE_FIXTURE_STATE",
                    "OPENCODE_FIXTURE_LOG", "HC_FIXTURE_LOG", "HC_FIXTURE_EVENTS"):
            self.env.pop(key, None)
        self.write({"tasks": {}, "projects": {}, "next": 100})
        self.git(self.repo, "init", "-q", "--initial-branch=main")
        self.git(self.repo, "config", "user.name", "Fixture")
        self.git(self.repo, "config", "user.email", "fixture@example.com")
        (self.repo / "base.txt").write_text("base\n")
        self.commit(self.repo, "base.txt")
        self.base = self.head()
        self.cli(self.repo, "list")

    def write(self, value):
        self.state.write_text(json.dumps(value))

    def read(self):
        return json.loads(self.state.read_text())

    def git(self, cwd, *args, ok=True):
        result = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
        if ok:
            assert result.returncode == 0, (args, result.stdout, result.stderr)
        return result.stdout.strip() if ok else result

    def head(self, cwd=None):
        return self.git(cwd or self.repo, "rev-parse", "HEAD")

    def commit(self, cwd, filename):
        self.git(cwd, "add", "--", filename)
        self.git(cwd, "commit", "-qm", "test: fixture change")

    def cli(self, cwd, *args, ok=True, contains=None):
        result = subprocess.run([str(binary), "--store", str(self.store), *args], cwd=cwd,
                                env=self.env, capture_output=True, text=True, timeout=90)
        assert (result.returncode == 0) == ok, (args, result.stdout, result.stderr)
        if contains:
            assert contains in result.stdout + result.stderr, (args, result.stdout, result.stderr)
        return result

    def task(self, ref, status="active", parent=None):
        value = self.read()
        value["tasks"][ref] = {"id": "id-" + ref, "ref": ref, "title": ref, "status": status,
                               "deleted": False, "is_epic": False, "project": "app",
                               "description": "Preserve the tested feature behavior.", "metadata": {},
                               "notes": [], "related": [], "depends_on": []}
        if parent:
            value["tasks"][ref]["epic_parent"] = parent
            value["tasks"][parent]["is_epic"] = True
        self.write(value)

    def attempt(self, ref, worktree, **extra):
        payload = dict(task_id="id-" + ref, task_ref=ref, workflow="implementation",
                       attempt_id="att-" + ref, branch=self.git(worktree, "branch", "--show-current"),
                       worktree=str(worktree), session_id="ses_fixture", prompt_id="msg_fixture",
                       state="running", aven={"aven_exe": self.env["AVEN_BIN"], "db_path": None,
                                              "workspace": "default", "origin_cwd": str(self.repo)},
                       created_at=1, generation=0, **extra)
        with sqlite3.connect(self.store) as db:
            db.execute("INSERT OR REPLACE INTO attempts VALUES (?,?,?,?,?,?,?,?,?,?)",
                       (payload["task_id"], payload["workflow"], payload["attempt_id"], ref,
                        payload["state"], payload["generation"], payload["session_id"], 1, 1, json.dumps(payload)))

    def feature(self, ref="APP-A", filename="feature.txt", text="feature\n"):
        self.task(ref)
        directory = self.root / ref
        self.git(self.repo, "worktree", "add", "-q", "-b", "feature/" + ref, str(directory), self.base)
        (directory / filename).write_text(text)
        self.commit(directory, filename)
        self.attempt(ref, directory)
        return directory

    def approve(self, worktree, ref="APP-A", check="test -f feature.txt", **kwargs):
        return self.cli(worktree, "approve", ref, "--check", check, "--review", "Acceptance and diff reviewed.", **kwargs)

    def prepare(self, *refs, **kwargs):
        result = self.cli(self.repo, "merge", *refs, "--yes", **kwargs)
        return json.loads(result.stdout) if kwargs.get("ok", True) else result

    def resume(self, operation, **kwargs):
        result = self.cli(self.repo, "merge", "--operation", operation["operation"], **kwargs)
        return json.loads(result.stdout) if kwargs.get("ok", True) else result

    def publish(self, operation, **kwargs):
        result = self.cli(self.repo, "merge", "--operation", operation["operation"], "--publish",
                          "--review-commit", operation["commit"], "--review", "Combined requirements reviewed.", **kwargs)
        # Closeout writes its human-readable evidence before the final JSON.
        return result


# Approval does not depend on a settled session, and accepts roots before delivery.
c = Case("acceptance")
source = c.feature()
assert json.loads(c.cli(c.repo, "merge", "--list").stdout) == []
c.task("APP-CHILD", "done", parent="APP-A")
c.approve(source)
tasks = c.read()["tasks"]
assert tasks["APP-A"]["status"] == "done"
assert tasks["APP-A"]["metadata"]["approval.commit"] == c.head(source)
assert tasks["APP-A"]["metadata"]["delivery.state"] == "committed"
assert tasks["APP-CHILD"]["metadata"]["delivery.state"] == "committed"
assert len([task for task in tasks.values() if task["metadata"].get("delivery.obligation-for") == "APP-CHILD"]) == 1
assert c.head() == c.base
c.cli(c.repo, "watch", "--once")
audit = c.cli(c.repo, "audit", "--project", "app", "--repository", str(c.repo), "--json")
assert "root_delivery_pending" in audit.stdout
assert "root_closed_with_obligations" not in audit.stdout
operation = c.prepare("id-APP-A")  # Immutable IDs work from main.
inventory = json.loads(c.cli(c.repo, "merge", "--list").stdout)
assert inventory[0]["operation"] == operation["operation"] and inventory[0]["state"] == "prepared"
assert operation["state"] == "prepared" and c.head() == c.base
c.publish(operation)
tasks = c.read()["tasks"]
assert tasks["APP-CHILD"]["metadata"]["delivery.state"] == "merged"
assert tasks["APP-A"]["metadata"]["delivery.state"] == "not-applicable"  # aggregate root
assert all(task["status"] == "done" for task in tasks.values() if task["metadata"].get("delivery.obligation-for"))
assert c.head() == operation["commit"]
assert c.resume(operation)["state"] == "merged"  # Idempotent replay.
assert source.is_dir() and Path(operation["worktree"]).is_dir()

# No approval on failed checks, dirty output, open children or a phase worktree.
for scenario in ("failed-check", "dirty-source", "dirty-check", "open-child", "phase"):
    c = Case(scenario)
    source = c.feature()
    check = "test -f feature.txt"
    if scenario == "failed-check":
        check = "exit 9"
    elif scenario == "dirty-source":
        (source / "unrelated.txt").write_text("keep me")
    elif scenario == "dirty-check":
        check = "echo generated > unowned.txt"
    elif scenario == "open-child":
        c.task("APP-CHILD", "active", parent="APP-A")
    elif scenario == "phase":
        c.task("APP-PARENT")
        data = c.read()
        data["tasks"]["APP-A"]["epic_parent"] = "APP-PARENT"
        c.write(data)
    c.approve(source, check=check, ok=False)
    assert c.read()["tasks"]["APP-A"]["status"] == "active"
    assert "approval.id" not in c.read()["tasks"]["APP-A"]["metadata"]
    assert c.head() == c.base

# Whole-batch preflight and stale source/specification/attempt/generation checks.
for scenario in ("mixed", "duplicate", "source-moved", "spec-changed", "generation", "attempt-replaced", "dirty-main", "dirty-approved-source", "child-reopened", "child-added", "forged-marker"):
    c = Case(scenario)
    source = c.feature()
    c.approve(source)
    refs = ["APP-A"]
    data = c.read()
    if scenario == "mixed":
        c.task("APP-B")
        refs.append("APP-B")
    elif scenario == "duplicate":
        refs.append("id-APP-A")
    elif scenario == "source-moved":
        (source / "feature.txt").write_text("new result\n")
        c.commit(source, "feature.txt")
    elif scenario == "spec-changed":
        data["tasks"]["APP-A"]["description"] = "Changed acceptance criteria"
        c.write(data)
    elif scenario == "generation":
        data["tasks"]["APP-A"]["metadata"]["dispatch.reset-generation"] = "1"
        c.write(data)
    elif scenario == "attempt-replaced":
        with sqlite3.connect(c.store) as db:
            payload = json.loads(db.execute("SELECT payload FROM attempts").fetchone()[0])
            payload["attempt_id"] = "replacement"
            db.execute("UPDATE attempts SET attempt_id=?, payload=?", ("replacement", json.dumps(payload)))
    elif scenario == "dirty-main":
        (c.repo / "personal.txt").write_text("keep me\n")
    elif scenario == "dirty-approved-source":
        (source / "personal.txt").write_text("keep me\n")
    elif scenario == "child-reopened":
        c.task("APP-CHILD", "active", parent="APP-A")
    elif scenario == "child-added":
        c.task("APP-CHILD", "done", parent="APP-A")
    elif scenario == "forged-marker":
        data["tasks"]["APP-A"]["metadata"]["approval.id"] = "approval_not_in_journal"
        c.write(data)
    inventory = c.git(c.repo, "worktree", "list", "--porcelain")
    c.prepare(*refs, ok=False)
    assert c.head() == c.base
    assert c.git(c.repo, "worktree", "list", "--porcelain") == inventory

# A successful Aven marker without completed publication is not an approval.
c = Case("incomplete-approval")
source = c.feature()
c.approve(source)
with sqlite3.connect(c.store) as db:
    db.execute("UPDATE effects SET state='pending' WHERE kind='approval'")
c.prepare("APP-A", ok=False, contains="no complete local approval journal")
assert c.head() == c.base

# Approval can be inferred only from the exact final checkout, without a task argument.
c = Case("inferred-approval")
source = c.feature()
c.cli(source, "approve", "--check", "test -f feature.txt", "--review", "Reviewed exact final result")
assert c.read()["tasks"]["APP-A"]["status"] == "done"

# Missing explicit merge authorization never creates an integration worktree.
c.cli(c.repo, "merge", "APP-A", ok=False, contains="--yes")
assert c.head() == c.base

# A failed newer approval attempt revokes readiness even at the same source SHA.
c.approve(source, check="exit 7", ok=False)
assert c.read()["tasks"]["APP-A"]["metadata"]["approval.state"] == "failed"
c.prepare("APP-A", ok=False, contains="no matching completed approval")

# Batch checks run on the combined result, with actual conflict isolation.
c = Case("batch-conflicts")
a = c.feature("APP-A", "base.txt", "feature A\n")
b = c.feature("APP-B", "base.txt", "feature B\n")
c.approve(a, "APP-A", "grep -q 'feature A' base.txt")
c.approve(b, "APP-B", "grep -q 'feature B' base.txt")
operation = c.prepare("APP-A", "APP-B")
assert operation["state"] == "conflicts" and operation["next"] == 1
assert c.head() == c.base and c.git(c.repo, "status", "--porcelain") == ""
isolated = Path(operation["worktree"])
assert "<<<<<<<" in (isolated / "base.txt").read_text()
assert c.resume(operation)["state"] == "conflicts"  # no duplicate admission/merge
(isolated / "base.txt").write_text("feature A\nfeature B\n")
c.commit(isolated, "base.txt")  # deterministic stand-in for agent resolution
operation = c.resume(operation)
assert operation["state"] == "prepared"
c.publish(operation)
assert c.head() == operation["commit"]
assert (c.repo / "base.txt").read_text() == "feature A\nfeature B\n"
for ref in ("APP-A", "APP-B"):
    assert c.read()["tasks"][ref]["metadata"]["delivery.state"] == "merged"

# Passing source tests don't excuse a failing combined result or scope creep.
for scenario in ("combined-failure", "scope-creep", "main-moved", "review-mismatch", "source-after-prepare"):
    c = Case(scenario)
    source = c.feature()
    c.approve(source, check="test -f feature.txt && ! test -f blocker.txt")
    operation = c.prepare("APP-A")
    isolated = Path(operation["worktree"])
    if scenario == "combined-failure":
        (isolated / "feature.txt").unlink()
        c.commit(isolated, "feature.txt")
        operation = c.resume(operation)
    elif scenario == "scope-creep":
        (isolated / "other.txt").write_text("unapproved\n")
        c.commit(isolated, "other.txt")
        operation["commit"] = c.head(isolated)
    elif scenario == "main-moved":
        (c.repo / "new-main.txt").write_text("new main\n")
        c.commit(c.repo, "new-main.txt")
    elif scenario == "review-mismatch":
        operation["commit"] = c.base
    elif scenario == "source-after-prepare":
        (source / "feature.txt").write_text("changed after approval\n")
        c.commit(source, "feature.txt")
    before = c.head()
    c.publish(operation, ok=False)
    assert c.head() == before

# Delivery recording retries after a Git success, without re-merging main.
c = Case("metadata-recovery")
source = c.feature()
c.approve(source)
operation = c.prepare("APP-A")
c.fail.touch()
c.publish(operation, ok=False, contains="fixture publication unavailable")
assert c.head() == operation["commit"]
with sqlite3.connect(c.store) as db:
    assert db.execute("SELECT state FROM effects WHERE operation_id=?", (operation["operation"],)).fetchone()[0] == "merged"
c.fail.unlink()
c.cli(c.repo, "watch", "--once")
assert c.head() == operation["commit"]
assert c.read()["tasks"]["APP-A"]["metadata"]["delivery.state"] == "merged"
with sqlite3.connect(c.store) as db:
    assert db.execute("SELECT state FROM effects WHERE operation_id=?", (operation["operation"],)).fetchone()[0] == "completed"

# Worktrees mode requires exact integrated commits, never just child done flags.
c = Case("phase-evidence")
source = c.feature()
c.task("APP-CHILD", "done", parent="APP-A")
phase = c.root / "phase"
c.git(c.repo, "worktree", "add", "-q", "-b", "phase/one", str(phase), c.head(source))
phase_data = dict(task_id="id-APP-CHILD", task_ref="APP-CHILD", title="phase", branch="phase/one",
                  worktree=str(phase), pane="", session_id="ses_phase", prompt_id="msg_phase",
                  commit=c.head(phase), integrated_commit=c.head(source), state="running")
c.attempt("APP-A", source, execution_mode="worktrees", phases=[phase_data])
c.approve(source, ok=False, contains="every phase must be integrated")
phase_data["state"] = "integrated"
# Recovery may record an already-cumulative coordinator tip as the integration
# checkpoint; ancestry, not equality with an older phase SHA, is authoritative.
(source / "coordinator.txt").write_text("verified cumulative fix\n")
c.commit(source, "coordinator.txt")
phase_data["integrated_commit"] = c.head(source)
c.attempt("APP-A", source, execution_mode="worktrees", phases=[phase_data])
c.approve(source)
(phase / "feature.txt").write_text("changed phase\n")
c.commit(phase, "feature.txt")
c.prepare("APP-A", ok=False, contains="changed after integration")

print("approval/integration process contracts passed")
