// `ask --login` / `--logout` / `--whoami`.
//
// Before this, the only way to configure the direct-to-relay credential was
// hand-editing EDS_TUI_URL/EDS_TUI_TOKEN into a shell rc file — no
// validation, so a stale or mistyped token only surfaces as a raw 401 deep
// inside a real conversation later, on a completely different machine, with
// no clue what actually went wrong. `--login` validates against a real
// request BEFORE ever saving anything, so a bad token is caught immediately
// with a clear message.
import { Ollama } from "ollama";
import { describeError } from "./retry.js";
import chalk from "chalk";
import { promptLine } from "./input.js";
import { saveCredentials, loadCredentials, clearCredentials, CREDENTIALS_FILE } from "./credentials.js";
import * as ui from "./ui.js";
const DEFAULT_HUB_URL = "https://app.interdataresearch.ai";
/**
 * Real request against the given hub with the given token — the only way
 * to actually know a token works, there is no dedicated "check this key"
 * endpoint (confirmed against miniaicloud's own source). A non-401 error
 * (e.g. 503, no healthy backend right now) still means the TOKEN itself
 * was accepted, so that counts as a valid login — just with a caveat.
 */
export async function validateToken(hubUrl, token) {
    const client = new Ollama({ host: hubUrl, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    try {
        const result = await client.list();
        return { ok: true, detail: `connected — ${result.models.length} model(s) reachable` };
    }
    catch (e) {
        if (e && typeof e === "object" && "status_code" in e) {
            const status = e.status_code;
            if (status === 401)
                return { ok: false, detail: "invalid or revoked token (HTTP 401)" };
            return {
                ok: true,
                detail: `token accepted, but the relay returned HTTP ${status} right now (no backend available?)`,
            };
        }
        return { ok: false, detail: describeError(e) };
    }
}
function maskToken(token) {
    if (token.length <= 8)
        return "*".repeat(token.length);
    return token.slice(0, 8) + "…" + "*".repeat(Math.max(0, token.length - 8));
}
function warnIfEnvVarsWillOverride() {
    if (process.env.EDS_TUI_URL || process.env.EDS_TUI_TOKEN) {
        ui.warn("EDS_TUI_URL/EDS_TUI_TOKEN are currently set in your environment — they take " +
            "precedence over a saved login. Unset them (or remove them from your shell rc " +
            "file) for this login to actually take effect.");
    }
}
export async function login() {
    if (!process.stdin.isTTY) {
        ui.warn("ask --login needs an interactive terminal.");
        process.exit(1);
    }
    const urlResult = await promptLine(`Hub URL [${DEFAULT_HUB_URL}]: `);
    if (urlResult.cancelled || urlResult.eof) {
        console.log(chalk.dim("\nCancelled."));
        process.exit(0);
    }
    const hubUrl = (urlResult.text.trim() || DEFAULT_HUB_URL).replace(/\/+$/, "");
    const tokenResult = await promptLine(`Relay API key (mint one at ${hubUrl}/admin/api-keys): `);
    if (tokenResult.cancelled || tokenResult.eof) {
        console.log(chalk.dim("\nCancelled."));
        process.exit(0);
    }
    const token = tokenResult.text.trim();
    if (!token) {
        console.log(chalk.dim("No token given. Cancelled."));
        process.exit(0);
    }
    console.log();
    const outcome = await ui.withSpinner("Validating…", () => validateToken(hubUrl, token));
    if (!outcome.ok) {
        ui.warn(`Login failed: ${outcome.detail}`);
        process.exit(1);
    }
    saveCredentials({ hubUrl, token });
    ui.ok(`Logged in — ${outcome.detail}`);
    console.log(chalk.dim(`Saved to ${CREDENTIALS_FILE}`));
    warnIfEnvVarsWillOverride();
    process.exit(0);
}
export function logout() {
    const cleared = clearCredentials();
    if (cleared) {
        ui.ok("Logged out — removed the saved login.");
    }
    else {
        console.log(chalk.dim("Not logged in — nothing to remove."));
    }
    process.exit(0);
}
export async function whoami() {
    const saved = loadCredentials();
    if (!saved) {
        console.log(chalk.dim("Not logged in via `ask --login`. (EDS_TUI_URL/EDS_TUI_TOKEN env vars, if set, " +
            "would still be used and take precedence over a saved login either way.)"));
        process.exit(0);
    }
    console.log(`Hub:   ${saved.hubUrl}`);
    console.log(`Token: ${maskToken(saved.token)}`);
    console.log();
    const outcome = await ui.withSpinner("Checking…", () => validateToken(saved.hubUrl, saved.token));
    if (outcome.ok) {
        ui.ok(`Still valid — ${outcome.detail}`);
    }
    else {
        ui.warn(`Saved token no longer works: ${outcome.detail}`);
    }
    warnIfEnvVarsWillOverride();
    process.exit(outcome.ok ? 0 : 1);
}
//# sourceMappingURL=login.js.map