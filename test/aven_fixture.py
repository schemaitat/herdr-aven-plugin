#!/usr/bin/env python3
"""Stateful, disposable Aven CLI fixture for lifecycle tests.

The fixture is intentionally small: it implements only the read/write surface
the dispatcher lifecycle uses, stores everything in one JSON file named by
AVEN_FIXTURE_STATE, and never touches the user's real database.
"""
import json
import os
import sys

STATE = os.environ["AVEN_FIXTURE_STATE"]
CALLS = os.environ.get("AVEN_FIXTURE_LOG")
PREFIX = os.environ.get("AVEN_FIXTURE_PREFIX", "APP")


def load():
    if not os.path.exists(STATE):
        return {"tasks": {}, "next": 1, "projects": {}}
    with open(STATE, encoding="utf-8") as handle:
        return json.load(handle)


def save(state):
    with open(STATE, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)


def log(argv):
    if CALLS:
        with open(CALLS, "a", encoding="utf-8") as handle:
            handle.write("aven " + " ".join(argv) + "\n")


def strip_globals(argv):
    out = []
    i = 0
    while i < len(argv):
        if argv[i] in ("--db", "--workspace") and i + 1 < len(argv):
            i += 2
            continue
        out.append(argv[i])
        i += 1
    return out


def find(state, reference):
    if reference in state["tasks"]:
        return state["tasks"][reference]
    for task in state["tasks"].values():
        if task["id"] == reference:
            return task
    raise SystemExit(f"unknown task {reference}")


def open_dependencies(state, task):
    return sum(
        1
        for dep_ref in task.get("depends_on", [])
        if state["tasks"].get(dep_ref, {}).get("status") not in ("done", "canceled")
    )


def ref_summary(state, task):
    return {
        "id": task["id"],
        "ref": task["ref"],
        "display_ref": task["ref"],
        "title": task["title"],
        "status": task["status"],
    }


def task_summary(state, task):
    parent_ref = task.get("epic_parent")
    parent = state["tasks"].get(parent_ref) if parent_ref else None
    return {
        "id": task["id"],
        "ref": task["ref"],
        "display_ref": task["ref"],
        "title": task["title"],
        "status": task["status"],
        "priority": task.get("priority", "none"),
        "deleted": task.get("deleted", False),
        "is_epic": task.get("is_epic", False),
        "project": task.get("project", ""),
        "metadata": task.get("metadata", {}),
        "blocked_by": open_dependencies(state, task),
        "blocks": sum(
            1
            for other in state["tasks"].values()
            if task["ref"] in other.get("depends_on", [])
        ),
        "epic_parent": ref_summary(state, parent) if parent else None,
        "epic_children": [
            ref_summary(state, child)
            for child in state["tasks"].values()
            if child.get("epic_parent") == task["ref"]
        ],
        "updated_at": task.get("updated_at", "2026-01-01T00:00:00Z"),
    }


def context(state, task):
    children = [
        task_summary(state, child)
        for child in state["tasks"].values()
        if child.get("epic_parent") == task["ref"]
    ]
    depends_on = []
    for dep_ref in task.get("depends_on", []):
        dep = state["tasks"].get(dep_ref)
        if dep:
            depends_on.append(
                {
                    "id": dep["id"],
                    "display_ref": dep["ref"],
                    "title": dep["title"],
                    "status": dep["status"],
                    "unresolved": dep["status"] not in ("done", "canceled"),
                }
            )
    related = []
    for ref in task.get("related", []):
        other = state["tasks"].get(ref)
        if other:
            related.append(
                {
                    "task_id": other["id"],
                    "display_ref": other["ref"],
                    "status": other["status"],
                    "title": other["title"],
                }
            )
    return {
        "task": {
            "id": task["id"],
            "ref_suffix": task["ref"].split("-")[-1],
            "display_ref": task["ref"],
            "title": task["title"],
            "description": task.get("description", ""),
            "status": task["status"],
            "priority": task.get("priority", "none"),
            "deleted": task.get("deleted", False),
            "is_epic": task.get("is_epic", False),
        },
        "project": {"key": task.get("project", "")},
        "workspace": {"key": "default"},
        "metadata": task.get("metadata", {}),
        "dependencies": {
            "depends_on": depends_on,
            "depends_on_open": sum(1 for dep in depends_on if dep["unresolved"]),
            "depends_on_total": len(depends_on),
            "blocks": [],
            "blocks_open": 0,
            "blocks_total": 0,
        },
        "related": related,
        "epic_parent": (
            {"ref": task["epic_parent"], "id": state["tasks"][task["epic_parent"]]["id"]}
            if task.get("epic_parent") in state["tasks"]
            else None
        ),
        "epic_children": children,
        "notes": [
            {"id": note.get("id", f"note-{index}"), "body": note["body"]}
            for index, note in enumerate(task.get("notes", []))
        ],
    }


def main(argv):
    log(argv)
    argv = strip_globals(argv)
    if not argv:
        raise SystemExit("missing command")
    command = argv[0]
    state = load()
    if command in ("--version", "version"):
        print("aven 0.0.0-fixture")
        return
    if command == "project":
        if len(argv) >= 3 and argv[1] == "create":
            state["projects"].setdefault(argv[2].lower().replace(" ", "-"), argv[2])
            save(state)
            return
        if len(argv) >= 2 and argv[1] == "list":
            projects = sorted(
                {
                    task.get("project", "")
                    for task in state["tasks"].values()
                    if task.get("project", "")
                }
            )
            if "--json" in argv:
                print(json.dumps([{"key": project, "name": project} for project in projects]))
            else:
                for project in projects:
                    print(project)
        return
    if command == "context":
        task = find(state, argv[1])
        print(json.dumps(context(state, task)))
        return
    if command == "delete":
        task = find(state, argv[1])
        if os.environ.get("AVEN_FIXTURE_FAIL_DELETE") == task["ref"]:
            raise SystemExit(f"refusing delete {task['ref']}")
        task["deleted"] = True
        task["updated_at"] = "2026-01-02T00:00:00Z"
        save(state)
        print(f"deleted {task['ref']}")
        return
    if command == "list":
        project = None
        metadata = []
        include_deleted = False
        include_open = False
        include_ready = False
        required_status = None
        i = 1
        while i < len(argv):
            if argv[i] in ("--project", "-p") and i + 1 < len(argv):
                project = argv[i + 1]
                i += 2
            elif argv[i] == "--metadata" and i + 1 < len(argv):
                metadata.append(argv[i + 1])
                i += 2
            elif argv[i] == "--status" and i + 1 < len(argv):
                required_status = argv[i + 1]
                i += 2
            elif argv[i] == "--all":
                include_deleted = True
                i += 1
            elif argv[i] == "--open":
                include_open = True
                i += 1
            elif argv[i] == "--ready":
                include_ready = True
                i += 1
            elif argv[i] in ("--json", "--limit") and i + 1 < len(argv) and argv[i] == "--limit":
                i += 2
            else:
                i += 1
        tasks = []
        for task in state["tasks"].values():
            if not include_deleted and task.get("deleted", False):
                continue
            if project and task.get("project", "") != project:
                continue
            if required_status and task["status"] != required_status:
                continue
            if include_open and task["status"] in ("done", "canceled"):
                continue
            if include_ready and (
                task["status"] in ("done", "canceled")
                or task.get("is_epic", False)
                or open_dependencies(state, task) > 0
            ):
                continue
            if any(
                task.get("metadata", {}).get(key) != value
                for key, value in (item.split("=", 1) for item in metadata)
            ):
                continue
            tasks.append(task_summary(state, task))
        if "--json" in argv:
            print(json.dumps(tasks))
        else:
            for task in tasks:
                print(f"{task['ref']} {task['status']} {task['title']}")
        return
    if command == "add":
        title = argv[1]
        project = ""
        status = "inbox"
        description = ""
        metadata = {}
        is_epic = False
        i = 2
        while i < len(argv):
            if argv[i] in ("--project", "--status", "--description") and i + 1 < len(argv):
                if argv[i] == "--project":
                    project = argv[i + 1]
                elif argv[i] == "--status":
                    status = argv[i + 1]
                else:
                    description = argv[i + 1]
                i += 2
            elif argv[i] == "--metadata" and i + 1 < len(argv):
                key, value = argv[i + 1].split("=", 1)
                metadata[key] = value
                i += 2
            elif argv[i] == "--epic":
                is_epic = True
                i += 1
            else:
                i += 1
        number = state["next"]
        state["next"] = number + 1
        reference = f"{PREFIX}-{number:04X}"
        task = {
            "id": f"id-{reference}",
            "ref": reference,
            "title": title,
            "status": status,
            "priority": "none",
            "deleted": False,
            "is_epic": is_epic,
            "project": project,
            "description": description,
            "metadata": metadata,
            "notes": [],
            "related": [],
            "depends_on": [],
        }
        state["tasks"][reference] = task
        save(state)
        print(f"created {reference}")
        return
    if command == "edit":
        task = find(state, argv[1])
        metadata_keys = set()
        i = 2
        while i < len(argv):
            if argv[i] == "--status" and i + 1 < len(argv):
                task["status"] = argv[i + 1]
                i += 2
            elif argv[i] == "--metadata" and i + 1 < len(argv):
                key, value = argv[i + 1].split("=", 1)
                if key in metadata_keys:
                    raise SystemExit("duplicate-metadata-key")
                metadata_keys.add(key)
                task.setdefault("metadata", {})[key] = value
                i += 2
            elif argv[i] == "--remove-metadata" and i + 1 < len(argv):
                task.setdefault("metadata", {}).pop(argv[i + 1], None)
                i += 2
            elif argv[i] == "--epic" and i + 1 < len(argv):
                task["is_epic"] = argv[i + 1] in ("on", "true", "1")
                i += 2
            elif argv[i] in (
                "--title",
                "--description",
                "--description-file",
                "--description-stdin",
                "--project",
                "--priority",
                "--available-at",
                "--due",
            ) and i + 1 < len(argv):
                i += 2
            else:
                i += 1
        save(state)
        return
    if command == "note":
        task = find(state, argv[1])
        if "--stdin" in argv:
            body = sys.stdin.read()
        elif "--file" in argv:
            with open(argv[argv.index("--file") + 1], encoding="utf-8") as handle:
                body = handle.read()
        else:
            body = argv[2] if len(argv) > 2 else ""
        task.setdefault("notes", []).append(
            {"id": f"note-{len(task['notes'])}", "body": body}
        )
        save(state)
        return
    if command == "related":
        if argv[1] == "add":
            left = find(state, argv[2])
            right = find(state, argv[3])
            if right["ref"] not in left.setdefault("related", []):
                left["related"].append(right["ref"])
            if left["ref"] not in right.setdefault("related", []):
                right["related"].append(left["ref"])
            save(state)
        return
    if command == "dep":
        if argv[1] == "add":
            dependent = find(state, argv[2])
            blocker = find(state, argv[3])
            if blocker["ref"] not in dependent.setdefault("depends_on", []):
                dependent["depends_on"].append(blocker["ref"])
            save(state)
        return
    raise SystemExit(f"unsupported fixture command: {' '.join(argv)}")


if __name__ == "__main__":
    main(sys.argv[1:])
