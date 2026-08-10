# repo-map

Auto-injected repo map for omp coding agents. Uses aider's tree-sitter engine to build a ranked map of the current repository — generated dynamically **per turn** with query-aware file boosting, exactly like aider's own repo map.

## What it does

Like aider's `get_repo_map()`, but as a standalone omp extension. Three modes:

| Mode | Behavior |
|---|---|
| `auto` | On every provider request: extracts file and identifier mentions from your message, generates a fresh repo map with those files boosted, and injects it as context |
| `manual` (default) | No automatic injection; use `/repo-map` command on demand to write `MAP.md` |
| `off` | Disabled entirely |

Per-project opt-out: `touch .no-repo-map` in the repo root (works even when global mode is `auto`).

## Install

```bash
# Add to ~/.omp/plugins/package.json:
"@yousefsahloul/repo-map": "github:yousefsahloul/repo-map"
bun install
```

Then register in `~/.omp/plugins/omp-plugins.lock.json` (manual step — omp reads installed plugin manifests from there).

## Configuration

```bash
# Enable auto-injection globally
omp config set repo-map.mode auto

# Or add directly to ~/.omp/agent/config.yml:
repo-map:
  mode: auto
```

## Commands

- `/repo-map` — generate or refresh MAP.md for the current git repo (for manual inspection)

## How it works

- **Per-turn dynamic generation**: the map is rebuilt every LLM call using `repo-map.py --no-file` (stdout only, no `MAP.md` disk artifact)
- **Query-aware boosting**: file names and identifiers mentioned in your message are extracted and passed as hints to aider's PageRank engine — mentioned files rank higher in the output
- **Mention extraction**: mirrors aider's `get_file_mentions()` (exact path matches + unique basenames with `.`, `-`, `_`), `get_ident_mentions()`, and `get_ident_filename_matches()` (stem ≥5 chars matched to identifiers)
- **Injection format**: map content is injected as a `user`/`assistant` message pair after the user's message — same position and format aider uses (`base_coder.py:695-706`)
- **Tree-sitter** (via aider): precise, language-aware symbol extraction with tag caching for speed
- **Fallback safe**: on timeout or error, injection is skipped; the LLM call proceeds normally

## Structure

```
repo-map/
  extension.ts         # omp extension factory
  skills/
    repo-map/
      SKILL.md         # skill instructions with alwaysApply
  repo-map.py          # generator (stdlib + aider)
  package.json
```

## Requirements

- [aider](https://github.com/Aider-AI/aider) installed (`aider` on PATH)
- Python 3.12+ (aider's venv is auto-discovered)
- Git

## License

MIT
