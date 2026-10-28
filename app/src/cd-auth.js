// Codex login in the project row (contract v3.56). Pure functions (no Electron; tested with node --test).
// What Codex says itself: installed = `codex` on the PATH, its sessions in ~/.codex/sessions; `codex login` opens the
// browser to authorize or reads an API key from stdin (`codex login --with-api-key`; both through a login pty); the
// state lives in ~/.codex/auth.json and `codex login status` prints a line like "Logged in using ChatGPT".
// Logged in = only that auth.json exists: it holds the tokens and the API key, so its contents are never read.
const path = require('node:path');

// The documented install line (developers.openai.com/codex); shown as a hint, never run by the app.
const CD_INSTALL = 'npm i -g @openai/codex';

// The login / logout subcommands (`codex login [status]`, `codex logout`).
const CD_LOGIN_ARGS = ['login'];
const CD_LOGOUT_ARGS = ['logout'];

// The status check run by the user's login shell with cdEnv (so PATH and rc files apply as for a Codex tab).
const CD_STATUS_COMMAND = 'command -v codex; true';

/**
 * The status command's output (rc files may print noise around it): where codex is.
 * @param {string} stdout @returns {{ path: string | null }}
 */
function parseCdStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim());
  return { path: lines.find((l) => /^(\/|[A-Za-z]:\\).*[\\/]codex(\.exe|\.cmd)?$/.test(l)) || null };
}

/** Codex's credentials file (documented, `codex login status`): ~/.codex/auth.json. @param {string} home */
const cdAuthFile = (home) => path.join(home, '.codex', 'auth.json');

/**
 * @typedef {{ installed: boolean, state: 'in' | 'out' | 'missing' }} CdAuth
 * Codex's login state from where codex is and whether auth.json exists (never its contents).
 * @param {{ path: string | null }} status @param {string} home @param {(f: string) => boolean} exists
 * @returns {CdAuth}
 */
function cdAuthState(status, home, exists) {
  if (!status.path) return { installed: false, state: 'missing' };
  let has = false;
  try { has = Boolean(exists(cdAuthFile(home))); } catch {}
  return { installed: true, state: has ? 'in' : 'out' };
}

module.exports = { CD_INSTALL, CD_LOGIN_ARGS, CD_LOGOUT_ARGS, CD_STATUS_COMMAND, parseCdStatus, cdAuthFile, cdAuthState };
