import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

const extDir = path.dirname(new URL(import.meta.url).pathname);
const scriptPath = path.join(extDir, "repo-map.py");

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".rb",
  ".php", ".c", ".cpp", ".h", ".hpp", ".cs", ".swift", ".kt", ".scala",
  ".vue", ".svelte", ".css", ".scss", ".json", ".yaml", ".yml", ".toml",
  ".sql", ".sh", ".bash",
]);

function isSourceFile(fname: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(fname).toLowerCase());
}

async function resolveGitRoot(pi: ExtensionAPI): Promise<string | null> {
  try {
    const r = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
    return r.stdout?.trim() || null;
  } catch { return null; }
}

async function getSourceFiles(pi: ExtensionAPI, gitRoot: string): Promise<string[]> {
  try {
    const r = await pi.exec("git", ["-C", gitRoot, "ls-files", "--full-name"]);
    return (r.stdout || "").split("\n").filter((f: string) => f && isSourceFile(f));
  } catch { return []; }
}

function getIdentMentions(text: string): Set<string> {
  return new Set(text.split(/\W+/).filter(Boolean));
}

function getIdentFilenameMatches(idents: Set<string>, allSourceFiles: string[]): Set<string> {
  const stemMap = new Map<string, string[]>();
  for (const f of allSourceFiles) {
    const stem = path.basename(f).replace(/\.[^.]+$/, "").toLowerCase();
    if (stem.length >= 5) {
      const arr = stemMap.get(stem) || [];
      arr.push(f);
      stemMap.set(stem, arr);
    }
  }
  const out = new Set<string>();
  for (const id of idents) {
    if (id.length < 5) continue;
    const files = stemMap.get(id.toLowerCase());
    if (files) files.forEach((f: string) => out.add(f));
  }
  return out;
}

function getFileMentions(content: string, allSourceFiles: string[]): Set<string> {
  const raw = content.split(/\s+/);
  const words = new Set<string>();
  for (const w of raw) {
    let c = w.replace(/[,.!;:?]+$/, "").replace(/^["'`*_]+|["'`*_]+$/g, "");
    if (c) words.add(c);
  }
  const mentioned = new Set<string>();
  const baseMap = new Map<string, string[]>();
  for (const rel of allSourceFiles) {
    const norm = rel.replace(/\\/g, "/");
    for (const w of words) { if (w.replace(/\\/g, "/") === norm) { mentioned.add(rel); break; } }
    const base = path.basename(rel);
    if (/[.\/\-_]/.test(base)) {
      const arr = baseMap.get(base) || [];
      arr.push(rel);
      baseMap.set(base, arr);
    }
  }
  for (const [base, rels] of baseMap) {
    if (rels.length === 1 && words.has(base)) mentioned.add(rels[0]);
  }
  return mentioned;
}

function getLastUserMessage(payload: Record<string, unknown>): string | null {
  let msgs: any[] | null = null;
  if (Array.isArray(payload.messages)) msgs = payload.messages as any[];
  else if (payload.payload && typeof payload.payload === "object") {
    const inner = payload.payload as Record<string, unknown>;
    if (Array.isArray(inner.messages)) msgs = inner.messages as any[];
  }
  if (!msgs) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      }
      return null;
    }
  }
  return null;
}

function injectMapAsMessagePair(payload: Record<string, unknown>, mapContent: string, afterSystem: boolean): Record<string, unknown> {
  let msgs: any[] | null = null;
  let isNested = false;
  if (Array.isArray(payload.messages)) msgs = payload.messages as any[];
  else if (payload.payload && typeof payload.payload === "object") {
    const inner = payload.payload as Record<string, unknown>;
    if (Array.isArray(inner.messages)) { msgs = inner.messages as any[]; isNested = true; }
  }
  if (!msgs) return payload;

  if (afterSystem) {
    // Aider positioning: after system messages, before conversation
    let insertAt = 0;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]?.role === "system") insertAt = i + 1;
    }
    msgs.splice(insertAt, 0,
      { role: "user", content: mapContent },
      { role: "assistant", content: "Ok, I won't try and edit those files without asking first." },
    );
  } else {
    // After last user message (legacy/fallback)
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "user") { idx = i; break; }
    }
    if (idx < 0) return payload;
    msgs.splice(idx + 1, 0,
      { role: "user", content: mapContent },
      { role: "assistant", content: "Ok, I won't try and edit those files without asking first." },
    );
  }
  return payload;
}

export default function repoMap(pi: ExtensionAPI) {
  const L = (msg: string) => { try { pi.logger?.warn("[repo-map] " + msg); } catch {} };
  pi.setLabel("Repo Map");

  try { pi.registerFlag({ name: "repo-map.mode", type: "string", default: "manual", description: "auto/manual/off" }); } catch {}
  try { pi.registerFlag({ name: "repo-map.debug", type: "boolean", default: false, description: "debug logging" }); } catch {}
  try { pi.registerCommand("repo-map", {
    description: "Generate or refresh the repo map (MAP.md)",
    handler: async (_args: any, ctx: any) => {
      try {
        const gitRoot = await resolveGitRoot(pi);
        if (!gitRoot) { ctx.ui.notify("Not a git repository", "error"); return; }
        ctx.ui.notify("Generating MAP.md for " + path.basename(gitRoot) + "...", "info");
        const r = await pi.exec("python3", [scriptPath, gitRoot], { timeout: 120000 });
        if (r.code === 0) ctx.ui.notify("MAP.md generated at " + gitRoot, "success");
        else ctx.ui.notify("repo-map failed: " + (r.stderr || "unknown error"), "error");
      } catch (e: any) { ctx.ui.notify("repo-map command failed: " + e, "error"); }
    },
  }); } catch {}

  // Once-per-session injection (aider places the map between system + conversation, not after every user msg)
  let mapInjected = false;

  try {
    pi.on("before_provider_request", async (payload: Record<string, unknown>) => {
      try {
        const mode = pi.getFlag("repo-map.mode") || "auto";
        if (mode !== "auto") return payload;

        const gitRoot = await resolveGitRoot(pi);
        if (!gitRoot) return payload;
        if (fs.existsSync(path.join(gitRoot, ".no-repo-map"))) return payload;

        const lastMsg = getLastUserMessage(payload);
        if (!lastMsg) return payload;

        const srcFiles = await getSourceFiles(pi, gitRoot);
        if (!srcFiles.length) return payload;

        const fMentions = getFileMentions(lastMsg, srcFiles);
        const iMentions = getIdentMentions(lastMsg);
        const iMatches = getIdentFilenameMatches(iMentions, srcFiles);
        const mFiles = new Set([...fMentions, ...iMatches]);

        const args = [scriptPath, gitRoot, "--quiet", "--no-file"];
        if (mFiles.size > 0) args.push("--mentioned-fnames", JSON.stringify([...mFiles]));
        if (iMentions.size > 0) args.push("--mentioned-idents", JSON.stringify([...iMentions]));

        const pyResult = await pi.exec("python3", args, { timeout: 120000 });
        if (pyResult.code !== 0 || !pyResult.stdout?.trim()) return payload;

        // Inject after system messages (aider positioning), only once
        const injectPos = !mapInjected ? true : false;
        if (mapInjected) return payload; // already in history from first injection

        const mapContent = pyResult.stdout.trim();
        L("injecting map (" + mapContent.length + " chars, src=" + srcFiles.length + " files) after system msgs");
        const injected = injectMapAsMessagePair(payload, mapContent, true);
        mapInjected = true;

        // Log message array
        const msgs = Array.isArray(injected.messages) || (injected.payload && typeof injected.payload === "object" && Array.isArray((injected.payload as any).messages))
          ? (Array.isArray(injected.messages) ? injected.messages as any[] : (injected.payload as any).messages as any[])
          : [];
        L("MODEL RECEIVES " + msgs.length + " messages (map at position after system):");
        for (let i = 0; i < Math.min(msgs.length, 6); i++) {
          const m = msgs[i];
          const preview = typeof m.content === "string" ? m.content.slice(0, 80).replace(/\n/g, "\\n") : "[complex]";
          L("  [" + i + "] " + m.role + ": " + preview);
        }
        return injected;
      } catch (e: any) {
        L("error: " + (e?.message || String(e)));
        return payload;
      }
    });
    L("registered: before_provider_request handler");
  } catch (e: any) { L("register-fail: " + (e?.message || String(e))); }
}
