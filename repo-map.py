#!/usr/bin/env python3
"""Generate MAP.md using aider's tree-sitter repomap engine.

Requires aider installed (the user has it). Runs from aider's venv Python.
Uses aider's own tag cache (.aider.tags.cache.v*/) for speed after first run.
Stdlib + aider; no extra deps.
"""
import argparse
import datetime
import os
import subprocess
import sys
import textwrap


def git_root(start):
    try:
        out = subprocess.run(
            ["git", "-C", start, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True, timeout=10,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return None


def tracked_files(root):
    """Git-tracked files, respecting .gitignore."""
    try:
        out = subprocess.run(
            ["git", "-C", root, "ls-files"],
            capture_output=True, text=True, check=True, timeout=30,
        )
        return [f for f in out.stdout.splitlines() if f and f != "MAP.md" and not f.endswith(".d.ts")]
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return []


def find_aider_python():
    """Locate aider's venv python — the only python that can import aider."""
    # aider binary is a script with a venv shebang
    aider_bin = shutil_locate("aider") or "/Users/yousefsahloul/.local/bin/aider"
    try:
        with open(aider_bin) as fh:
            shebang = fh.readline().strip()
    except OSError:
        return None
    if shebang.startswith("#!") and "aider" in shebang:
        return shebang[2:]  # strip #!
    # fallback: search known uv tool dirs
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".local/share/uv/tools/aider-chat/bin/python"),
        os.path.join(home, ".local/share/uv/tools/aider-chat/bin/python3"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def shutil_locate(name):
    from shutil import which
    return which(name)


def generate_map(root, max_tokens=2000):
    """Produce the repo map text using aider's RepoMap engine."""
    aider_py = find_aider_python()
    if not aider_py:
        return None, "aider Python not found — install aider first"
    other = tracked_files(root)
    if not other:
        return None, "no tracked files found"
    script = textwrap.dedent(f"""
        import os, sys
        os.chdir({root!r})
        class _IO:
            def read_text(self, path): return open(path, encoding='utf-8', errors='replace').read()
            def tool_output(self, msg): pass
            def tool_warning(self, msg): pass
            def tool_error(self, msg): pass
        class _Model:
            def token_count(self, text): return len(text) // 4
        from aider.repomap import RepoMap
        rm = RepoMap(root={root!r}, map_tokens={max_tokens}, io=_IO(), main_model=_Model())
        other = {other!r}
        result = rm.get_repo_map(chat_files=[], other_files=other)
        if result:
            print(result)
    """)
    try:
        proc = subprocess.run(
            [aider_py, "-c", script],
            capture_output=True, text=True, timeout=120,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        if proc.returncode != 0:
            return None, proc.stderr.strip()[:500] or "aider failed"
        return proc.stdout.strip(), None
    except subprocess.TimeoutExpired:
        return None, "aider timed out (repo too large?)"
    except FileNotFoundError:
        return None, f"aider python not found at {aider_py}"


def head_sha(root):
    try:
        out = subprocess.run(
            ["git", "-C", root, "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True, timeout=5,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None


def main():
    ap = argparse.ArgumentParser(description="Generate MAP.md using aider's repomap engine.")
    ap.add_argument("path", nargs="?", default=os.getcwd(), help="start dir (default: cwd)")
    ap.add_argument("--tokens", type=int, default=2000, help="max map tokens (default: 2000)")
    ap.add_argument("--quiet", action="store_true", help="suppress progress output on stderr")
    args = ap.parse_args()

    root = git_root(args.path) or os.path.abspath(args.path)
    repo_name = os.path.basename(root.rstrip(os.sep)) or root
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    sha = head_sha(root)

    if not args.quiet:
        print(f"Building map for {repo_name} ({root})...", file=sys.stderr)
    body, err = generate_map(root, args.tokens)
    if err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)
    if not body:
        print("Error: aider produced empty map", file=sys.stderr)
        sys.exit(1)

    header = (
        f"<!-- HEAD: {sha} -->\n"
        f"# {repo_name} — repo map\n\n"
        f"> Generated by the repo-map skill (aider engine) · {stamp}\n"
        f"> Refresh: `python3 {os.path.abspath(__file__)}`\n"
        f"> Read this BEFORE writing new code — if a module already does the job, reuse it.\n\n"
    )
    prompt_prefix = (
        "Below is a snapshot of the current workspace\u2019s file structure and its "
        "introduced symbols (functions, classes, methods, etc.). This is the \u201cRepo "
        "Map\u201d and helps orient agents in the codebase. It is always read-only and "
        "should be used before any coding \u2014 if a task can be accomplished by "
        "reusing or extending something already shown here, prefer that over creating "
        "from scratch.\n\n"
    )
    map_path = os.path.join(root, "MAP.md")
    with open(map_path, "w") as fh:
        fh.write(header)
        fh.write(prompt_prefix)
        fh.write(body)
        if not body.endswith("\n"):
            fh.write("\n")
    if not args.quiet:
        print(f"Wrote {map_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
