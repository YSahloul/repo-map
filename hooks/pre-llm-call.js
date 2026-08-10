#!/usr/bin/env node
// repo-map — pre_llm_call hook
//
// Runs before every LLM call. Injects the repo map (MAP.md) into context.
// Regenerates MAP.md when the git HEAD changed, caching otherwise.
//
// Mode control (checked in order, first match wins):
//   1. Per-project .repo-map.toml: mode = "auto" | "manual" | "off"
//   2. Global REPO_MAP_MODE env var: "auto" | "manual" | "off"
//   3. Default: "manual" (safe — user must run /repo-map first per project)
// "auto"  = inject MAP.md before every LLM call (auto-generates if missing)
// "manual"= skip injection; use /repo-map command on demand (default)
// "off"   = skip entirely (same as disabling the plugin for this project)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- mode detection ---

function resolveMode(root) {
  // 1. Per-project .repo-map.toml
  const tomlPath = path.join(root, '.repo-map.toml');
  try {
    const toml = fs.readFileSync(tomlPath, 'utf8');
    const m = toml.match(/^\s*mode\s*=\s*"(auto|manual|off)"/m);
    if (m) return m[1];
  } catch {}
  // 2. Global env var
  const env = process.env.REPO_MAP_MODE;
  if (env && ['auto', 'manual', 'off'].includes(env)) return env;
  // 3. Default: manual (user must generate first map explicitly)
  return 'manual';
}

// --- git helpers ---
function gitRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','pipe'] }).trim();
  } catch { return null; }
}

function headSha(root) {
  try {
    return execSync('git -C ' + JSON.stringify(root) + ' rev-parse HEAD', { encoding: 'utf8', timeout: 3000 }).trim();
  } catch { return null; }
}

function workingTreeDirty(root) {
  try {
    execSync('git -C ' + JSON.stringify(root) + ' diff --quiet HEAD', { timeout: 3000 });
    return false;
  } catch { return true; }
}

function mapHeadSha(mapPath) {
  try {
    const head = fs.readFileSync(mapPath, 'utf8').split('\n').slice(0, 10).join('\n');
    const m = head.match(/^<!-- HEAD:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch { return null; }
}

// --- main ---

function main() {
  const root = gitRoot();
  if (!root) return; // not a git repo

  const mode = resolveMode(root);
  if (mode === 'off') return;          // disabled for this project
  if (mode === 'manual') return;       // manual only — /repo-map command

  // mode === 'auto': inject the map before every LLM call
  const mapPath = path.join(root, 'MAP.md');
  const scriptPath = __dirname.replace(/\/hooks$/, '') + '/repo-map.py';
  const currentSha = headSha(root);
  const dirty = workingTreeDirty(root);

  let content = null;
  const needRegen = dirty || !fs.existsSync(mapPath) || mapHeadSha(mapPath) !== currentSha;

  if (needRegen) {
    try {
      execSync('python3 ' + JSON.stringify(scriptPath) + ' ' + JSON.stringify(root) + ' --quiet', {
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
    } catch {} // timeout or failure — fall through to stale map
    try { content = fs.readFileSync(mapPath, 'utf8'); } catch { content = null; }
  } else {
    try { content = fs.readFileSync(mapPath, 'utf8'); } catch { content = null; }
  }

  if (!content) return;

  // Strip our own HEAD comment for cleaner injection
  const body = content
    .split('\n')
    .filter(line => !/^<!-- HEAD:/.test(line))
    .join('\n');

  process.stdout.write(body);
}

main();
