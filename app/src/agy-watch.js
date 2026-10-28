// Antigravity in the office (contract v3.23): the state of an `agy` tab, read one way from what the app already has.
// No Electron; tested with node --test. The watcher itself is pure; the transcript helpers at the end only read files.
//
// agy does not load the office plugin, and nothing may be passed to it (v3.22: no env, argument or file), so the app
// watches the bytes agy writes to its pty, the keys the person sends to it and, read-only, agy's own conversation
// transcript (`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`, the
// conversation found in `cache/last_conversations.json` by the tab's folder).
// - A prompt is submitted (Enter after typed text, not inside an approval dialog): a turn starts, the boss works.
// - agy's busy line (a spinner glyph or "esc to cancel"/"esc to interrupt", redrawn while it works) or the transcript
//   growing keeps it busy; either one seen without a submitted prompt (agy started with -i, or carrying on by
//   itself) starts a turn too.
// - An approval dialog on screen ("Allow create this file? [y/n/f]", "Yes, and run in sandbox", "Subagent 12 asks
//   to run …", or Gemini-CLI-style labels: "Allow once", "Allow execution of", …) is an open prompt: stats.waiting,
//   the boss's NEEDS YOU sign, the ✋ on the row and a notification. A key sent to the tab answers it.
// - The turn ends when terminal and transcript have been quiet for QUIET_MS after the last busy sign: the boss
//   stops, one turn is counted and delivered (agy's sub-agents are not shown; the boss's finished turn is its
//   delivery), and attention.js raises 'done' for a project nobody is looking at.
// The result is a session in the plugin's file shape (`session()`), handed to readOffice as an observed session, so
// the office, the agent panel and attention.js need no Antigravity case.
// Command Code tabs (contract v3.25) use the same watcher (`engine: 'commandcode'`) and, read-only, the newest
// session file of the tab's folder in ~/.commandcode/projects/<slug>/ (cmdTranscriptPath). OpenCode tabs (v3.40) use it
// with `engine: 'opencode'` and no transcript (its sessions are in a database); their subagents (v3.55) come from
// read-only `part` rows of its own opencode.db (ocDataDir, ocTaskOf below), fed through spool() by main.js.

const fs = require('node:fs');
const path = require('node:path');
const { draftAfter } = require('./sleep.js');
const { ccSlugOf } = require('./token-usage.js');

const { usageTokens } = require('./cmd-spool.js');
const WORKER_FORGET_MS = 60000; // a done worker (Command Code mod spool, v3.37) stays this long in the office
const QUIET_MS = 3000; // no output and no busy sign this long after the last one: the turn is over
const SUBMIT_GRACE_MS = 8000; // after Enter, agy may take a while before its first busy line (model start)
const TAIL = 2000; // characters of plain screen text kept to match patterns across chunk borders

// --- patterns (see contract v3.23 for which are documented and which are guessed)
// busy: the spinner frames of a terminal "dots" spinner (Gemini CLI family) or the cancel hint of the busy line
const BUSY_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\besc to (cancel|interrupt|stop)\b/i;
const OC_BUSY_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\besc (to )?(cancel|interrupt|stop)\b/i; // OpenCode's busy line says "esc interrupt" (v3.40)
// an approval dialog. agy's documented prompts: "Allow create this file? [y/n/f]" (a `[y/n…]` choice after a
// question), the sandbox choices "Yes, and run in sandbox" / "Yes, and run without sandbox restrictions" and the
// sub-agent notice 'Subagent 12 asks to run "npm test"'. The rest are Gemini CLI's dialog labels (guessed for agy).
const ASK_RE = new RegExp([
  String.raw`\?\s*\[y\/n(\/[a-z])*\]`,
  String.raw`\byes,? and run (in|without) sandbox`,
  String.raw`\bsubagent \S+ asks to\b`,
  String.raw`\bdon'?t ask again\b`, // Command Code's permission prompt (commandcode.ai/docs/settings, v3.25)
  String.raw`\b(allow once|allow always|always allow|allow for (this|the|all) (session|conversation|future)|yes,? allow|no,? suggest changes|allow execution of|apply (this|these) changes?\?|waiting for (user |your )?(confirmation|approval))`,
].join('|'), 'i');
// what the dialog is about: a tool name for stats.waiting.tool ('' when unknown)
/** @type {[RegExp, string][]} */
const TOOL_OF = [
  [/\b(command|execut|shell|terminal|asks to run|run (in|without) sandbox)/i, 'Shell'],
  [/\b(create|edit|write|change|file|patch|diff)/i, 'Edit'],
  [/\b(fetch|url|browse|web|http)/i, 'Web'],
  [/\bmcp\b/i, 'MCP'],
];

/** Terminal output → plain text: escape sequences (CSI, OSC, DCS, charset, single-char) removed, \r as a line break. */
function plainText(data) {
  return String(data ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '') // OSC … BEL/ST
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[PX^_][^\x1b]*(\x1b\\)?/g, '') // DCS, SOS, PM, APC … ST
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '') // charset
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_=>78]/g, '') // other two-byte escapes
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * One agy tab's watcher. Feed it with output(data), input(data) and exit(); tick(now) ends quiet turns;
 * session(project) gives the office its view. engine/label: the observed CLI (v3.25: 'commandcode', 'Command Code').
 * @param {number} [startAt] @param {{ engine?: 'agy' | 'commandcode' | 'opencode', label?: string }} [o]
 */
function createAgyWatch(startAt = Date.now(), { engine = 'agy', label = 'Antigravity' } = {}) {
  const busyRe = engine === 'opencode' ? OC_BUSY_RE : BUSY_RE;
  let busy = false;
  let turnOpen = false; // a turn that has not been counted yet
  let turnAt = 0; // when the current turn began
  let lastSign = 0; // last busy sign (or the submit) that keeps the turn going
  let lastOutput = startAt;
  /** @type {{ kind: 'permission', tool: string, since: number } | null} */
  let waiting = null;
  let draft = false;
  let tail = '';
  let turns = 0;
  let updatedAt = startAt;
  /** @type {{ date: string, ids: string[], log: { id: string, type: string, description: string, spawnAt: number, doneAt: number, isOk: boolean, toolCount: number }[] }} */
  let today = { date: dayKey(startAt), ids: [], log: [] };
  let endedAt = 0;
  /** @type {{ size: number, prompts: number } | null} */
  let seen = null; // the transcript as last read
  let muteUntil = 0; // right after a dialog is answered its last frame may still be drawn: not a new dialog
  // Command Code's mod spool (v3.37, src/cmd-spool.js): its sub-agents as workers, and the token counts it reports.
  /** @type {{ id: string, type: string, description: string, spawnAt: number, doneAt?: number, isOk?: boolean, tool?: string, toolCount: number, tokens?: number }[]} */
  let workers = [];
  let tokens = 0;

  const startTurn = (now) => {
    busy = true;
    turnOpen = true;
    turnAt = now;
    lastSign = now;
    updatedAt = now;
  };
  const finishTurn = (now) => {
    busy = false;
    updatedAt = now;
    if (!turnOpen) return;
    turnOpen = false;
    turns++;
    const date = dayKey(now);
    if (today.date !== date) today = { date, ids: [], log: [] };
    const id = `turn-${turns}`;
    today.ids.push(id);
    today.log.push({ id, type: engine, description: label, spawnAt: turnAt, doneAt: now, isOk: true, toolCount: 0 });
    if (today.log.length > 200) today.log.splice(0, today.log.length - 200);
  };

  return {
    /** Bytes agy wrote to its terminal. */
    output(data, now = Date.now()) {
      if (endedAt) return;
      lastOutput = now;
      updatedAt = now;
      const text = plainText(data);
      if (!text) return;
      tail = (tail + text).slice(-TAIL);
      const ask = now >= muteUntil && (ASK_RE.test(text) || (!waiting && ASK_RE.test(tail.slice(-400))));
      if (ask) {
        if (!waiting) {
          const around = tail.slice(-400);
          const tool = TOOL_OF.find(([re]) => re.test(around))?.[1] ?? '';
          waiting = { kind: 'permission', tool, since: now };
        }
        if (!busy) startTurn(now); // a dialog belongs to a turn
        lastSign = now;
        return;
      }
      if (busyRe.test(text)) {
        if (!busy) startTurn(now);
        lastSign = now;
      }
    },
    /** Keys the person sent to the tab. */
    input(data, now = Date.now()) {
      if (endedAt) return;
      const s = String(data ?? '');
      if (waiting) {
        // any key answers the dialog (a choice, Enter, Esc, Ctrl+C); agy carries on or stops, the busy line tells
        waiting = null;
        tail = '';
        muteUntil = now + 700;
        lastSign = now;
        updatedAt = now;
        draft = false;
        return;
      }
      const hadDraft = draft;
      draft = draftAfter(draft, s);
      if (hadDraft && /\r/.test(s) && !s.includes('\x03')) {
        tail = '';
        if (!busy) startTurn(now);
        else lastSign = now;
      }
    },
    /**
     * agy's transcript, read by the app: its size and how many prompts (USER_INPUT records) it holds. The first call
     * is the baseline; later growth is a busy sign (and a new prompt, or growth while idle, starts a turn).
     * @param {{ size: number, prompts: number } | null} t
     */
    transcript(t, now = Date.now()) {
      if (endedAt || !t) return;
      if (!seen) { seen = { ...t }; return; }
      if (t.size < seen.size) { seen = { ...t }; return; } // another conversation (or rewritten): new baseline
      if (t.size > seen.size || t.prompts > seen.prompts) {
        if (!busy) startTurn(now);
        else lastSign = now;
        lastOutput = Math.max(lastOutput, now);
        updatedAt = now;
      }
      seen = { ...t };
    },
    /**
     * Events of the tab's Command Code mod spool (contract v3.37, cmd-spool.js parseSpoolLine): subagent_start/
     * progress/stop make workers (done ones go to the day's log and leave after WORKER_FORGET_MS); permission names
     * the tool of an open dialog (or opens one); turn_end and subagent_stop add tokens. description (v3.55, the
     * database events): the subagent's task when the source knows it.
     * @param {{ t: string, at: number, id?: string, type?: string, description?: string, tool?: string, tokens?: number, usage?: Record<string, number> }[]} events
     */
    spool(events, now = Date.now()) {
      if (endedAt) return;
      for (const e of events || []) {
        const at = e.at || now;
        if (e.t === 'subagent_start' && e.id && !workers.some((w) => w.id === e.id)) {
          // description when the source knows the task (opencode.db, v3.55); the spool's own events name the agent
          workers.push({ id: e.id, type: e.type || 'subagent', description: e.description || e.type || 'subagent', spawnAt: at, toolCount: 0 });
          if (workers.length > 50) workers.splice(0, workers.length - 50);
          if (!busy) startTurn(now);
          lastSign = now;
        } else if (e.t === 'subagent_progress' && e.id) {
          const w = workers.find((x) => x.id === e.id && x.doneAt === undefined);
          if (w) { w.toolCount++; if (e.tool) w.tool = e.tool; if (e.tokens !== undefined) w.tokens = e.tokens; }
          lastSign = now;
        } else if (e.t === 'subagent_stop' && e.id) {
          const w = workers.find((x) => x.id === e.id && x.doneAt === undefined);
          if (!w) continue;
          w.doneAt = at;
          w.isOk = true;
          if (e.tokens !== undefined) { w.tokens = e.tokens; tokens += e.tokens; }
          const date = dayKey(at);
          if (today.date !== date) today = { date, ids: [], log: [] };
          today.ids.push(w.id);
          today.log.push({ id: w.id, type: w.type, description: w.description, spawnAt: w.spawnAt, doneAt: at, isOk: true, toolCount: w.toolCount });
          if (today.log.length > 200) today.log.splice(0, today.log.length - 200);
        } else if (e.t === 'permission') {
          if (waiting) { if (!waiting.tool && e.tool) waiting.tool = e.tool; } else if (now >= muteUntil) {
            waiting = { kind: 'permission', tool: e.tool || '', since: at };
            if (!busy) startTurn(now);
            lastSign = now;
          }
        } else if (e.t === 'turn_end') {
          tokens += usageTokens(e.usage);
        }
        updatedAt = Math.max(updatedAt, now);
      }
    },
    /** agy ended (the pty exited or was killed). */
    exit(now = Date.now()) {
      if (endedAt) return;
      if (busy) finishTurn(now);
      waiting = null;
      endedAt = now;
      updatedAt = now;
    },
    /** Ends a turn whose terminal went quiet. Returns true when the state changed. */
    tick(now = Date.now()) {
      if (!busy || waiting || endedAt) return false;
      const grace = lastSign === turnAt ? Math.max(QUIET_MS, SUBMIT_GRACE_MS) : QUIET_MS;
      if (now - lastSign < grace || now - lastOutput < QUIET_MS) return false;
      finishTurn(now);
      return true;
    },
    /** Is anything going on that a sleep would cut off? '' = no (src/sleep.js sleepBlocker's words). */
    blocker() {
      if (busy) return 'busy';
      if (waiting) return 'waiting';
      if (draft) return 'draft';
      return '';
    },
    /**
     * The office's view: a session in the plugin's file shape (contract v2/v2.6/v2.9) plus `id` and `engine`.
     * While agy runs the session is live (updatedAt = now), so an idle tab or a long-open dialog stays in the office.
     * @param {string} project @param {string} id @param {number} [now]
     */
    session(project, id, now = Date.now()) {
      return {
        id, project, engine, format: 2, updatedAt: endedAt || Math.max(updatedAt, now), ...(endedAt ? { endedAt } : {}),
        workers: workers.filter((w) => w.doneAt === undefined || now - w.doneAt < WORKER_FORGET_MS).map((w) => ({ ...w })),
        stats: {
          isBossBusy: busy, turns,
          ...(tokens ? { tokens: { total: tokens } } : {}),
          ...(waiting ? { waiting: { ...waiting } } : {}),
          today: { date: today.date, ids: [...today.ids], log: today.log.map((l) => ({ ...l })) },
        },
      };
    },
    get isBusy() { return busy; },
    get waiting() { return waiting; },
    get turns() { return turns; },
  };
}

// --- agy's transcript (read-only). Documented: the file's path (antigravity.google/docs/hooks) and
// last_conversations.json, a map from the absolute workspace path to its newest conversation id
// (antigravity.google/docs/cli/commands/resume). Not documented: the records; "USER_INPUT" as a prompt record's type
// comes from a third-party write-up, so only its occurrences are counted and the file's growth is what matters.
const agyDataDir = (home) => path.join(home, '.gemini', 'antigravity-cli');

/**
 * The transcript of the newest conversation of a folder, or null (no map, no entry, odd id).
 * @param {string} home @param {string} dir @param {(file: string) => string} [read]
 */
function agyTranscriptPath(home, dir, read = (f) => fs.readFileSync(f, 'utf8')) {
  let map;
  try { map = JSON.parse(read(path.join(agyDataDir(home), 'cache', 'last_conversations.json'))); } catch { return null; }
  if (!map || typeof map !== 'object') return null;
  const strip = (/** @type {string} */ p) => String(p).replace(/[\\/]+$/, '');
  const key = Object.keys(map).find((k) => strip(k) === strip(dir));
  const id = key ? map[key] : null;
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return null;
  return path.join(agyDataDir(home), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
}

// --- Command Code's session files (read-only, contract v3.25). Documented (commandcode.ai/docs/sessions):
// ~/.commandcode/projects/<project-slug>/<session-id>.jsonl, append-only, one record per line, next to sidecars
// (<id>.meta.json, <id>.checkpoints.jsonl, <id>.prompts.jsonl, <id>.share.json). The slug rule is not documented:
// token-usage.js ccSlugOf (lower case, non-alphanumerics → '-', no leading dash) is taken from real folders.
// Prompt records: `"role":"user"` (the message records parseEntryCC reads). ~/.commandcode/auth.json is never read.
const CMD_PROMPT_RE = /"role"\s*:\s*"user"/g;
/** The folder of Command Code's sessions for a working directory. */
const cmdProjectDir = (home, dir) => path.join(home, '.commandcode', 'projects', ccSlugOf(dir));
/** Does the folder have a Command Code session (`--continue` has one to open)? */
function hasCmdSession(home, dir, list = (d) => fs.readdirSync(d)) {
  try { return list(cmdProjectDir(home, dir)).some((f) => /^[\w-]+\.jsonl$/.test(f)); } catch { return false; }
}
/**
 * The newest session file of a folder (the one `--continue` opens), or null.
 * @param {string} home @param {string} dir
 */
function cmdTranscriptPath(home, dir) {
  const d = cmdProjectDir(home, dir);
  let best = null, at = -1;
  let names = [];
  try { names = fs.readdirSync(d); } catch { return null; }
  for (const f of names) {
    if (!/^[\w-]+\.jsonl$/.test(f)) continue; // the session itself, not a sidecar (<id>.prompts.jsonl, …)
    try { const m = fs.statSync(path.join(d, f)).mtimeMs; if (m > at) { at = m; best = path.join(d, f); } } catch { /* gone */ }
  }
  return best;
}

// --- OpenCode's session database (read-only, contract v3.55): <XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db.
// A top-level session's `part` rows with {"type":"tool","tool":"task"} describe one subagent run each (recovered from
// opencode 2.1.2's own storage): state.status is 'pending' | 'running' | 'completed' | 'error', state.input carries
// { description, prompt, subagent_type }, state.metadata carries { parentSessionId, sessionId, title } and state.time
// ({ start, end } as ms epochs). ocDataDir mirrors oc-auth.js's opencode folder rule; nothing is written and no value
// of the machine's files is sent anywhere by the query itself.
/** The folder OpenCode keeps its data in (its opencode.db lives right here). @param {string} home @param {string} [xdgData] */
const ocDataDir = (home, xdgData) =>
  path.join(xdgData && path.isAbsolute(xdgData) ? xdgData : path.join(home, '.local', 'share'), 'opencode');

/**
 * One task-tool part record (parsed part.data) → one worker, or null.
 * doneAt/isOk only when state.status says the run ended ('completed' | 'error').
 * @param {any} d
 */
function ocTaskOf(d) {
  if (!d || typeof d !== 'object' || d.type !== 'tool' || d.tool !== 'task') return null;
  const state = d.state || {};
  const meta = state.metadata || {};
  const input = state.input || {};
  const time = state.time || {};
  const id = typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId
    : typeof d.callID === 'string' && d.callID ? `call-${d.callID}` : null;
  if (!id) return null;
  const spawnAt = Number(time.start) > 0 ? Number(time.start) : 0;
  const done = state.status === 'completed' || state.status === 'error';
  const type = typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'subagent';
  const description = [meta.title, input.description].find((v) => typeof v === 'string' && v) || type;
  const t = { id, type, description };
  if (spawnAt) t.spawnAt = spawnAt;
  if (done) {
    t.doneAt = Number(time.end) > 0 ? Number(time.end) : 0;
    t.isOk = state.status === 'completed';
  }
  return t;
}

/**
 * Parses the new task-tool part rows of the tab's poll into spool events (description + exact spawn/done epochs, v3.55).
 * events, always in one pass: a row may enter already finished (its start then stop, back to back). A row read again in
 * another poll keeps only its stop one-time (done); starts are idempotent by id inside the call and harmless again.
 * @param {{ at: number, data: string }[]} rows @param {Set<string>} done
 */
function ocSpoolEvents(rows, done) {
  const events = [];
  const saw = new Set();
  for (const r of rows || []) {
    let d;
    try { d = JSON.parse(r.data); } catch { continue; }
    const t = ocTaskOf(d);
    if (!t) continue;
    if (!saw.has(t.id)) {
      saw.add(t.id);
      events.push({ t: 'subagent_start', id: t.id, type: t.type, description: t.description, at: t.spawnAt || r.at });
    }
    if (t.doneAt && done && !done.has(t.id)) {
      done.add(t.id);
      events.push({ t: 'subagent_stop', id: t.id, at: t.doneAt });
    }
  }
  return events;
}

/**
 * Reads what was appended to a transcript since `from` (a cursor { file, size, prompts }); returns the new cursor, or
 * null when the file is missing. Only the new bytes are read. promptRe: what a prompt record looks like.
 * @param {string} file @param {{ file: string, size: number, prompts: number } | null} from @param {RegExp} [promptRe]
 */
function readTranscript(file, from, promptRe = /"USER_INPUT"/g) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const start = from && from.file === file && from.size <= st.size ? from.size : 0;
  let prompts = start ? from?.prompts ?? 0 : 0;
  if (st.size > start) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const n = Math.min(st.size - start, 4 * 1024 * 1024);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, st.size - n);
      prompts += (buf.toString('utf8').match(promptRe) || []).length;
    } catch { /* unreadable: size only */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  return { file, size: st.size, prompts };
}

module.exports = { createAgyWatch, dayKey, plainText, agyTranscriptPath, readTranscript, cmdProjectDir, hasCmdSession, cmdTranscriptPath, CMD_PROMPT_RE, BUSY_RE, OC_BUSY_RE, ASK_RE, QUIET_MS, SUBMIT_GRACE_MS, ocDataDir, ocTaskOf, ocSpoolEvents };
