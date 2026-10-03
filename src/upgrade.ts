// Ported from eds_tui/main.py's self_upgrade(), and back to that original
// simple form: `npm install -g eds-tui@latest`.
//
// This used to clone+pack+install instead, for two reasons that are both now
// gone. The first was that the npm registry publish for this package was
// stuck on an old version (an account-access issue on the publishing side),
// so `@latest` would have silently downgraded a real install — resolved,
// 0.6.2 onward is published. The second was that `npm install -g
// git+https://github.com/...` for this repo was confirmed unreliable, able
// to report success while leaving an incomplete install; that was npm's own
// git-dependency fetch machinery and simply does not apply to a registry
// tarball. install.sh/install.ps1 keep the clone+pack path as a fallback for
// boxes that can't reach the registry at all.
//
// githubUpgrade() (`ask --github-upgrade [repo]`) is that clone+pack path,
// built in: for when the registry is behind (a publish blocked on npm 2FA,
// say) or unreachable. A plain `git clone` + `npm pack` of the checkout +
// `npm install -g` of that tarball — never `npm install -g git+https://...`,
// which for this repo could report success over an incomplete install.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ui from "./ui.js";

export const DEFAULT_REPO_URL = "https://github.com/edantonio505/eds-tui-js.git";

/**
 * The git URL to clone for `ask --github-upgrade [repo]`: the default repo
 * when none is given, `owner/repo` shorthand expanded to GitHub, anything
 * else (https, ssh, a local path) passed to git as-is.
 */
export function resolveRepoUrl(arg: string | undefined): string {
  const repo = arg?.trim();
  if (!repo) return DEFAULT_REPO_URL;
  if (/^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.startsWith(".")) return `https://github.com/${repo.replace(/\.git$/, "")}.git`;
  return repo;
}

export function selfUpgrade(): never {
  ui.say("\n  Upgrading eds-tui from npm...\n");

  // --prefer-online: without it npm can resolve @latest from a stale cached
  // packument and "upgrade" to the version already installed right after a
  // fresh publish.
  const r = spawnSync("npm", ["install", "-g", "eds-tui@latest", "--prefer-online", "--no-fund", "--no-audit"], {
    stdio: "inherit",
  });

  if (r.status === 0) {
    ui.say("\n  Done. Restart ask to use the new version.\n");
  } else {
    // Deliberately no automatic sudo retry, unlike the installers: `ask` can
    // be run with no controlling terminal to type a password into, and an
    // interactive tool escalating privileges on its own is worse than
    // printing the command for the user to run deliberately.
    ui.warn("npm install -g eds-tui@latest failed.");
    ui.warn("If that was a permissions error (EACCES), your global npm prefix needs root:");
    ui.warn("  sudo npm install -g eds-tui@latest");
    ui.warn("Or install straight from GitHub, which does not need the registry:");
    ui.warn("  ask --github-upgrade");
  }

  process.exit(r.status ?? 1);
}

export function githubUpgrade(repoArg?: string): never {
  const repoUrl = resolveRepoUrl(repoArg);
  ui.say(`\n  Upgrading eds-tui from ${repoUrl}...\n`);

  const tmp = mkdtempSync(join(tmpdir(), "eds-tui-upgrade-"));
  let exitCode = 1;
  try {
    // `--` so a repo argument can never be read as a git option.
    const clone = spawnSync("git", ["clone", "--depth", "1", "-q", "--", repoUrl, tmp], { stdio: "inherit" });
    if (clone.error || clone.status !== 0) {
      ui.warn(clone.error ? `Could not run git: ${clone.error.message}` : "git clone failed — check the repo URL, your network, and that git is installed.");
      exitCode = clone.status ?? 1;
    } else {
      let pkg: { name?: string; version?: string } = {};
      try {
        pkg = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8"));
      } catch {
        // handled by the name check below
      }
      if (pkg.name !== "eds-tui") {
        // Installing some other package would leave `ask` untouched (or clobber another global command).
        ui.warn(`That repo is not eds-tui (package name: ${pkg.name ?? "none"}) — aborting.`);
      } else {
        const pack = spawnSync("npm", ["pack", "--silent"], { cwd: tmp, encoding: "utf8" });
        const tarball = (pack.stdout ?? "").trim().split("\n").pop() ?? "";
        if (pack.status !== 0 || !tarball || !readdirSync(tmp).includes(tarball)) {
          ui.warn("npm pack did not produce a tarball — aborting.");
          exitCode = pack.status || 1;
        } else {
          ui.say(`  Installing eds-tui ${pkg.version}...\n`);
          const install = spawnSync("npm", ["install", "-g", join(tmp, tarball), "--no-fund", "--no-audit"], { stdio: "inherit" });
          if (install.status === 0) {
            ui.say(`\n  Done — eds-tui ${pkg.version} installed. Restart ask to use it.\n`);
          } else {
            ui.warn("npm install failed. If that was a permissions error (EACCES), your global npm prefix needs root.");
          }
          exitCode = install.status ?? 1;
        }
      }
    }
  } finally {
    // Cleanup via normal control flow: process.exit() would skip `finally`.
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(exitCode);
}
