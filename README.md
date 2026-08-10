# repo-map

Auto-injected repo map for omp coding agents. Uses aider's tree-sitter engine to build a ranked map of the current repository — injected before every LLM call so agents never recreate existing code.

## What it does

Like aider's own repo map, but as a standalone omp extension. Three modes:

| Mode | Behavior |
|---|---|
| `auto` | MAP.md injected before every provider request; auto-regenerated when stale |
| `manual` (default) | No automatic injection; use `/repo-map` command on demand |
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

- `/repo-map` — generate or refresh MAP.md for the current git repo

## How it works

- **Extension API**: omp-native TypeScript extension using `registerFlag`, `registerCommand`, and `before_provider_request` event
- **Tree-sitter** (via aider): precise, language-aware symbol extraction
- **PageRank** ranking: important files first, not alphabetical
- **Mtime-based caching**: only re-parses changed files
- **HEAD SHA stamping**: `MAP.md` records the git SHA; injection skips regen when nothing changed

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
