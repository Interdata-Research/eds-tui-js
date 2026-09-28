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

import { spawnSync } from "node:child_process";
import * as ui from "./ui.js";

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
    ui.warn("Or use the standalone installer, which does not need the registry:");
    ui.warn("  curl -fsSL https://raw.githubusercontent.com/edantonio505/eds-tui-js/main/install.sh | bash");
  }

  process.exit(r.status ?? 1);
}
