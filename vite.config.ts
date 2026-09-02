import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";

/**
 * A visible stamp for "which build is this phone actually running?".
 *
 * Without it there is no way to tell whether a deploy landed, whether an
 * installed PWA is serving a stale shell, or whether the person reporting a bug
 * is on the version that fixed it. The release runbook (docs/RELEASE.md) checks
 * this after every deploy, so it has to be present in production builds.
 *
 * The trailing `+` means the working tree had uncommitted changes when this was
 * built — that build is not reproducible from any commit, which is worth
 * knowing before chasing a bug in it.
 */
function buildId(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const dirty =
      execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim().length > 0
        ? "+"
        : "";
    return `${stamp} · ${sha}${dirty}`;
  } catch {
    // Not a git checkout. Still stamp the time — a build with no identity at
    // all is worse than one identified only by when it was made.
    return `${stamp} · nogit`;
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174 },
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
});
