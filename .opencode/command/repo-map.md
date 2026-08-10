# /repo-map — generate or refresh the repo map

Run `python3 <plugin-dir>/repo-map.py` from the repo root. Writes `MAP.md` with:
- A directory tree of all git-tracked files.
- Tree-sitter powered symbol index, ranked by importance (most-referenced files first).
- Per-file symbol outlines with surrounding context.

Use this command to:
- Generate the initial map for a new repo.
- Refresh the map after structural changes (new files, moves, renames).
- Force-regenerate when the auto-injection is in `manual` mode.

After generating, read `MAP.md`. If a module already does the job listed in the
map, extend it — never write a second implementation.
