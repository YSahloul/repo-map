import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

// Resolve extension directory from this module's URL
const extDir = path.dirname(new URL(import.meta.url).pathname);
const scriptPath = path.join(extDir, "repo-map.py");

function stripHeadSha(mapContent: string): string {
  return mapContent.replace(/^<!-- HEAD: [a-f0-9]+ -->\n/m, "");
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

async function ensureMapFresh(
  pi: ExtensionAPI,
  gitRoot: string,
): Promise<string | null> {
  const mapPath = path.join(gitRoot, "MAP.md");

  // Check existing MAP.md freshness
  if (fs.existsSync(mapPath)) {
    const existingMap = fs.readFileSync(mapPath, "utf-8");
    const shaMatch = existingMap.match(/^<!-- HEAD: ([a-f0-9]+) -->/m);

    let currentSha: string | null = null;
    try {
      const shaResult = await pi.exec("git", ["rev-parse", "HEAD"], {
        cwd: gitRoot,
      });
      currentSha = shaResult.stdout?.trim() || null;
    } catch {
      // Can't get SHA — regenerate
    }

    if (shaMatch && currentSha && shaMatch[1] === currentSha) {
      // SHA matches — check working tree for uncommitted changes
      try {
        await pi.exec("git", ["diff", "--quiet", "HEAD"], { cwd: gitRoot });
        // exit 0 = clean — MAP.md is fresh
        return stripHeadSha(existingMap);
      } catch {
        // diff --quiet exits non-zero when dirty → stale
      }
    }
  }

  // Regenerate
  try {
    const pyResult = await pi.exec(
      "python3",
      [scriptPath, gitRoot, "--quiet"],
      { timeout: 120000 },
    );
    if (pyResult.exitCode !== 0) {
      pi.logger?.warn(
        `repo-map auto-generation failed: ${pyResult.stderr}`,
      );
      return null;
    }
    if (fs.existsSync(mapPath)) {
      return stripHeadSha(fs.readFileSync(mapPath, "utf-8"));
    }
  } catch (err) {
    pi.logger?.warn(`repo-map auto-generation error: ${err}`);
  }
  return null;
}

function injectMapIntoPayload(
  payload: Record<string, unknown>,
  mapContent: string,
): Record<string, unknown> {
  // Handle messages-array payload (most providers)
  if (Array.isArray(payload.messages)) {
    const sysIdx = payload.messages.findIndex(
      (m: any) => m?.role === "system",
    );
    if (sysIdx >= 0) {
      const existing = payload.messages[sysIdx];
      if (typeof existing.content === "string") {
        existing.content = mapContent + "\n\n" + existing.content;
      } else if (Array.isArray(existing.content)) {
        existing.content.unshift({ type: "text", text: mapContent + "\n\n" });
      }
    } else {
      payload.messages.unshift({ role: "system", content: mapContent });
    }
    return payload;
  }

  // Handle system-string payload (some providers)
  if (typeof payload.system === "string") {
    payload.system = mapContent + "\n\n" + payload.system;
    return payload;
  }

  return payload;
}

export default function repoMap(pi: ExtensionAPI) {
  pi.setLabel("Repo Map");

  // 2a. Mode flag — controls auto/manual/off
  pi.registerFlag({
    name: "repo-map.mode",
    type: "string",
    default: "manual",
    description:
      "'auto' injects before every LLM call; 'manual' uses /repo-map command only; 'off' disables",
  });

  // 2b. /repo-map slash command
  pi.registerCommand("repo-map", {
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
  });

  // 2c. Auto-injection before every provider request
  pi.on(
    "before_provider_request",
    async (payload: Record<string, unknown>) => {
      try {
        // 1. Resolve git root
        const gitRoot = await resolveGitRoot(pi);
        if (!gitRoot) return payload;

        // 2. Per-project opt-out (.no-repo-map)
        if (fs.existsSync(path.join(gitRoot, ".no-repo-map"))) {
          return payload;
        }

        // 3. Mode gate
        const mode = pi.getFlag("repo-map.mode");
        if (mode !== "auto") return payload;

        // 4. Ensure MAP.md is fresh (generate if missing/stale)
        const mapContent = await ensureMapFresh(pi, gitRoot);
        if (!mapContent) return payload;

        // 5. Inject into provider request payload
        return injectMapIntoPayload(payload, mapContent);
      } catch (err) {
        pi.logger?.warn(`repo-map injection error: ${err}`);
        return payload;
      }
    },
  );
}
