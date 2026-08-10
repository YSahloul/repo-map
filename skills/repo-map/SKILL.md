---
name: repo-map
description: Generates and maintains MAP.md — a map of the current repo (tracked-file tree, per-file symbols, and stated purpose) so agents know what already exists and never recreate it. Use at the start of any coding task in a repo, when asked where something lives, when starting work in an unfamiliar repo, or after structural changes (new files/dirs, moves, renames). The map prevents duplicate implementation by making existing modules findable.
alwaysApply: true
---

# Repo Map

Before writing any code in a repo, know what is already there. `MAP.md` at the repo root is the map: where everything lives, what each file declares, and what it says it is for.

## Generate / refresh the map

Run the deterministic generator from anywhere inside the repo (git root is auto-detected):

```bash
python3 ~/.omp/skills/repo-map/repo-map.py
```

It writes `MAP.md` at the repo root using only git-tracked files (respects `.gitignore`, so no `node_modules` noise). Deterministic: same repo → same output.

## When to use

- **Start of a task** — if `MAP.md` exists, read it before implementing anything. If it is missing or clearly stale (files exist that are not in it), regenerate it first.
- **"Where is X?"** — check the map before grepping; the symbol index answers most location questions faster.
- **After structural changes** — regenerate when you add, move, or rename files, so the next session starts from a correct map.

## The rule this skill exists for: never recreate

1. Read `MAP.md` before writing code.
2. If a module, function, component, or endpoint that already does the job exists in the map — **reuse or extend it**. Do not write a second implementation.
3. Only create something new when the map proves nothing covers the need.

## Keeping it honest

- The map is only as current as the last regeneration. If you notice drift mid-task, regenerate once and continue.
- Symbol extraction is noise-tolerant by design: it may list a few false positives but rarely misses a real declaration. When a symbol matters, open the file to confirm — do not trust the map over the code.
