# repo-map

Auto-injected repo map for coding agents (omp, pi, Claude Code, etc.). Uses aider's tree-sitter engine to build a ranked map of the current repository — injected before every LLM call so agents never recreate existing code.

## What it does

Like aider's own repo map, but as a standalone plugin. Before every prompt, the `pre_llm_call` hook:
1. Checks if the repo changed (HEAD SHA or dirty tree)
2. If stale, regenerates `MAP.md` using aider's repomap engine
3. Injects the map into context — always there, never manual

## Install

### omp / Hermes Agent

```bash
# Add to ~/.omp/plugins/package.json:
"@yousefsahloul/repo-map": "github:yousefsahloul/repo-map"
bun install
```

### Pi agent

```
pi install git:github.com/yousefsahloul/repo-map
```

### Standalone (no injection, just generate MAP.md)

```bash
python3 repo-map.py /path/to/repo
```

## How it works

- **Tree-sitter** (via aider): precise, language-aware symbol extraction
- **PageRank** ranking: important files first, not alphabetical
- **Mtime-based caching**: only re-parses changed files
- **HEAD SHA stamping**: `MAP.md` records the git SHA; hook skips regen when nothing changed

## Structure

```
repo-map/
  plugin.yaml          # omp/Hermes plugin manifest
  hooks/
    pre-llm-call.js    # auto-injection hook
  skills/
    repo-map/
      SKILL.md         # skill instructions (cross-platform)
  repo-map.py          # generator (stdlib + aider)
  package.json
```

## Requirements

- [aider](https://github.com/Aider-AI/aider) installed (`aider` on PATH)
- Python 3.12+ (aider's venv is auto-discovered)
- Git

## License

MIT
