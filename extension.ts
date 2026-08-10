import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";
// Resolve extension directory from this module's URL
const extDir = path.dirname(new URL(import.meta.url).pathname);
const scriptPath = path.join(extDir, "repo-map.py");

// Source file extensions aider's tree-sitter can parse
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".rb",
  ".php", ".c", ".cpp", ".h", ".hpp", ".cs", ".swift", ".kt", ".scala",
  ".vue", ".svelte", ".css", ".scss", ".json", ".yaml", ".yml", ".toml",
  ".sql", ".sh", ".bash",
]);

function isSourceFile(fname: string): boolean {
  const ext = path.extname(fname).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

async function resolveGitRoot(pi: ExtensionAPI): Promise<string | null> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
    const root = result.stdout?.trim();
    return root || null;
  } catch {
    return null;
  }
}

async function getSourceFiles(
  pi: ExtensionAPI,
  gitRoot: string,
): Promise<string[]> {
  try {
    const result = await pi.exec("git", ["-C", gitRoot, "ls-files", "--full-name"]);
    const files = (result.stdout || "").split("\n").filter(Boolean);
    return files.filter(isSourceFile);
  } catch {
    return [];
  }
}

/**
 * Extract identifier mentions from text.
 * Matches aider's `get_ident_mentions`: split on \W+ (non-word chars),
 * collect unique words.
 */
function getIdentMentions(text: string): Set<string> {
  const words = text.split(/\W+/);
  return new Set(words.filter(Boolean));
}

/**
 * Map identifier mentions to filenames where the file stem (basename
 * without extension, ≥5 chars) matches the identifier (case-insensitive).
 * Matches aider's `get_ident_filename_matches`.
 */
function getIdentFilenameMatches(
  idents: Set<string>,
  allSourceFiles: string[],
): Set<string> {
  const stemToFiles = new Map<string, string[]>();
  for (const fname of allSourceFiles) {
    const base = path.basename(fname);
    const stem = base.replace(/\.[^.]+$/, "").toLowerCase();
    if (stem.length >= 5) {
      const existing = stemToFiles.get(stem) || [];
      existing.push(fname);
      stemToFiles.set(stem, existing);
    }
  }

  const matches = new Set<string>();
  for (const ident of idents) {
    if (ident.length < 5) continue;
    const files = stemToFiles.get(ident.toLowerCase());
    if (files) {
      for (const f of files) matches.add(f);
    }
  }
  return matches;
}

/**
 * Extract file mentions from message text.
 * Matches aider's `get_file_mentions`:
 * - Split message on whitespace into words
 * - Strip trailing punctuation and surrounding quotes/backticks
 * - A file is mentioned if its relative path (normalized to /) exactly
 *   matches a word, OR if its basename matches a word AND the basename
 *   contains `.`, `-`, `_`, or `/` AND is unique across the repo.
 */
function getFileMentions(
  content: string,
  allSourceFiles: string[],
): Set<string> {
  // Split on whitespace, clean each word
  const rawWords = content.split(/\s+/);
  const words = new Set<string>();
  for (const w of rawWords) {
    let cleaned = w;
    // Strip trailing punctuation
    cleaned = cleaned.replace(/[,.!;:?]+$/, "");
    // Strip surrounding quotes and backticks
    cleaned = cleaned.replace(/^["'`*_]+|["'`*_]+$/g, "");
    if (cleaned) words.add(cleaned);
  }

  const mentioned = new Set<string>();
  const fnameToRelFnames = new Map<string, string[]>();

  for (const relFname of allSourceFiles) {
    const normalizedRelFname = relFname.replace(/\\/g, "/");

    // True relative-path match (normalized to /)
    for (const word of words) {
      if (word.replace(/\\/g, "/") === normalizedRelFname) {
        mentioned.add(relFname);
        break;
      }
    }

    const base = path.basename(relFname);

    // Only consider basenames that contain . - _ or / (not plain words like "run")
    if (/[.\/\-_]/.test(base)) {
      const existing = fnameToRelFnames.get(base) || [];
      existing.push(relFname);
      fnameToRelFnames.set(base, existing);
    }
  }

  // Unique basename mentions
  for (const [base, relFnames] of fnameToRelFnames) {
    if (relFnames.length === 1 && words.has(base)) {
      mentioned.add(relFnames[0]);
    }
  }

  return mentioned;
}

/**
 * Extract the last user message content from the payload.
 */
function getLastUserMessage(
  payload: Record<string, unknown>,
): string | null {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        // Concatenate text blocks
        return m.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }
      return null;
    }
  }
  return null;
}

/**
 * Inject the repo map as a user/assistant message pair after the
 * last user message, matching aider's format.
 */
function injectMapAsMessagePair(
  payload: Record<string, unknown>,
  mapContent: string,
): Record<string, unknown> {
  if (!Array.isArray(payload.messages)) return payload;

  // Find the last user message index
  let lastUserIdx = -1;
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    if ((payload.messages[i] as any)?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return payload;

  // Insert the map user/assistant pair after the last user message
  const mapMessages = [
    { role: "user", content: mapContent },
    { role: "assistant", content: "Ok, I won't try and edit those files without asking first." },
  ];
  payload.messages.splice(lastUserIdx + 1, 0, ...mapMessages);
  return payload;
}

export default function repoMap(pi: ExtensionAPI) {
  pi.setLabel("Repo Map");

  // Mode flag — controls auto/manual/off
  try { pi.registerFlag({
    name: "repo-map.mode",
    type: "string",
    default: "manual",
    description:
      "'auto' injects before every LLM call; 'manual' uses /repo-map command only; 'off' disables",
  }); } catch {}

  // Debug flag — logs injection details to console
  try { pi.registerFlag({
    name: "repo-map.debug",
    type: "boolean",
    default: false,
    description: "Log repo map injection details (message array, mentions, timing)",
  }); } catch {}

  // /repo-map slash command — writes MAP.md for manual inspection
  try { pi.registerCommand("repo-map", {
    description: "Generate or refresh the repo map (MAP.md)",
    handler: async (_args, ctx) => {
      try {
        const gitRoot = await resolveGitRoot(pi);
        if (!gitRoot) {
          ctx.ui.notify("Not a git repository", "error");
          return;
        }
        ctx.ui.notify(
          `Generating MAP.md for ${path.basename(gitRoot)}...`,
          "info",
        );
        const pyResult = await pi.exec(
          "python3",
          [scriptPath, gitRoot],
          { timeout: 120000 },
        );
        if (pyResult.exitCode === 0) {
          ctx.ui.notify(`MAP.md generated at ${gitRoot}`, "success");
        } else {
          ctx.ui.notify(
            `repo-map failed: ${pyResult.stderr || "unknown error"}`,
            "error",
          );
        }
      } catch (err) {
        ctx.ui.notify(`repo-map command failed: ${err}`, "error");
      }
    },
  }); } catch {}

  // Auto-injection before every provider request — per-turn dynamic map
  pi.on(
    "before_provider_request",
    async (payload: Record<string, unknown>) => {
      const L = (msg: string) => pi.logger?.warn("[repo-map] " + msg);
      try {
        // Always dump payload structure on every call
        const keys = Object.keys(payload);
        const msgCount = Array.isArray(payload.messages) ? (payload.messages as any[]).length : 0;
        const roles = Array.isArray(payload.messages)
          ? (payload.messages as any[]).map((m: any) => m.role).join(",")
          : "no-array";
        L("fired: payload keys=" + keys.join(",") + " msgs=" + msgCount + " roles=[" + roles + "]");
        const gitRoot = await resolveGitRoot(pi);
        if (!gitRoot) { L("skip: not a git repo"); return payload; }
        if (fs.existsSync(path.join(gitRoot, ".no-repo-map"))) { L("skip: .no-repo-map"); return payload; }

        const mode = pi.getFlag("repo-map.mode") || "auto";
        if (mode !== "auto") { L("skip: mode=" + mode); return payload; }

        const lastUserMsg = getLastUserMessage(payload);
        if (!lastUserMsg) { L("skip: no user message"); return payload; }

        const sourceFiles = await getSourceFiles(pi, gitRoot);
        if (sourceFiles.length === 0) { L("skip: no source files"); return payload; }

        L("git=" + gitRoot + " src=" + sourceFiles.length + " msg=" + lastUserMsg.slice(0, 80));

        const fileMentions = getFileMentions(lastUserMsg, sourceFiles);
        const idents = getIdentMentions(lastUserMsg);
        const identFileMatches = getIdentFilenameMatches(idents, sourceFiles);
        const mentionedFnames = new Set([...fileMentions, ...identFileMatches]);
        const mentionedIdents = idents;

        L("mentioned: " + mentionedFnames.size + " files, " + mentionedIdents.size + " idents");
        if (mentionedFnames.size > 0) L("files: " + [...mentionedFnames].slice(0, 10).join(", "));

        const args = [scriptPath, gitRoot, "--quiet", "--no-file"];
        if (mentionedFnames.size > 0) args.push("--mentioned-fnames", JSON.stringify([...mentionedFnames]));
        if (mentionedIdents.size > 0) args.push("--mentioned-idents", JSON.stringify([...mentionedIdents]));

        const pyResult = await pi.exec("python3", args, { timeout: 120000 });
        if (pyResult.exitCode !== 0 || !pyResult.stdout?.trim()) {
          L("gen-failed: " + (pyResult.stderr || "empty"));
          return payload;
        }

        L("map-chars=" + pyResult.stdout.length);
        const injected = injectMapAsMessagePair(payload, pyResult.stdout.trim());
        L("injected: " + (Array.isArray(payload.messages) ? (payload.messages as any[]).length : 0) + " msgs -> " + (Array.isArray(injected.messages) ? (injected.messages as any[]).length : 0));
        return injected;
      } catch (err) {
        pi.logger?.warn("repo-map injection error: " + err);
        return payload;
      }
    },
  );
}
