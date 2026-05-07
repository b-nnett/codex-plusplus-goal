/**
 * Goal
 *
 * Adds a desktop GUI shim for Codex's CLI-backed /goal command.
 *
 * Renderer:
 *   - Adds a /goal row to the slash menu.
 *   - Intercepts composer submissions beginning with /goal.
 *   - Renders a compact active-goal pill in the composer footer.
 *
 * Main:
 *   - Reads and writes ~/.codex/state_5.sqlite thread_goals records.
 */

const STYLE_ID = "codexpp-goal-style";
const ROOT_ATTR = "data-codexpp-goal";
const SLASH_ROW_ATTR = "data-codexpp-goal-slash-row";
const GOAL_MENTION_NAME = "codexpp-goal";
const GOAL_MENTION_SELECTOR = `[skill-mention-name="${GOAL_MENTION_NAME}"]`;

const IPC_GET = "goal:get";
const IPC_SET = "goal:set";
const IPC_CLEAR = "goal:clear";
const IPC_STATUS = "goal:status";
const IPC_CREATE_THREAD = "goal:create-thread";
const IPC_RESOLVE_THREAD = "goal:resolve-thread";
const IPC_LIST = "goal:list";

const GOAL_STATUSES = new Set(["active", "paused", "budget_limited", "complete"]);
const ACTIVE_STATUSES = new Set(["active", "paused", "budget_limited"]);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** @type {import("@codex-plusplus/sdk").Tweak} */
module.exports = {
  start(api) {
    if (api.process === "main") {
      startMain(this, api);
      return;
    }
    startRenderer(this, api);
  },

  stop() {
    const state = this._state;
    if (!state) return;
    if (state.process === "main") {
      state.dispose?.();
      this._state = null;
      return;
    }
    state.disposed = true;
    window.removeEventListener("keydown", state.onWindowKeyDown, true);
    document.removeEventListener("keydown", state.onKeyDown, true);
    document.removeEventListener("submit", state.onSubmit, true);
    document.removeEventListener("click", state.onClick, true);
    document.removeEventListener("input", state.onInput, true);
    document.removeEventListener("beforeinput", state.onBeforeInput, true);
    window.removeEventListener("popstate", state.onRouteChange);
    window.removeEventListener("hashchange", state.onRouteChange);
    for (const wired of state.wiredEvents || []) {
      wired.node.removeEventListener(wired.type, wired.handler, true);
      if (wired.type === "click") delete wired.node.__codexppGoalSendWired;
      else delete wired.node.__codexppGoalInputWired;
    }
    state.observer?.disconnect();
    if (state.scanTimer) window.clearTimeout(state.scanTimer);
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    if (state.clockTimer) window.clearInterval(state.clockTimer);
    state.modal?.remove();
    state.root?.remove();
    removeGoalTimelineDivider();
    removeGoalSummaryPanel();
    state.style?.remove();
    this._state = null;
  },
};

function startMain(self, api) {
  const state = {
    process: "main",
    dispose() {
      removeMainHandler(api, IPC_GET);
      removeMainHandler(api, IPC_SET);
      removeMainHandler(api, IPC_CLEAR);
      removeMainHandler(api, IPC_STATUS);
      removeMainHandler(api, IPC_CREATE_THREAD);
      removeMainHandler(api, IPC_RESOLVE_THREAD);
      removeMainHandler(api, IPC_LIST);
      if (goalDb) {
        try {
          goalDb.close();
        } catch {}
        goalDb = null;
      }
    },
  };
  self._state = state;

  replaceMainHandler(api, IPC_GET, (payload) => {
    const db = openGoalDb();
    return { goal: getGoalRow(db, requireThreadId(payload)) };
  });

  replaceMainHandler(api, IPC_RESOLVE_THREAD, (payload) => {
    const db = openGoalDb();
    const threadId = resolveThreadIdFromTurnIds(db, payload?.turnIds);
    return {
      threadId,
      goal: threadId ? getGoalRow(db, threadId) : null,
    };
  });

  replaceMainHandler(api, IPC_LIST, (payload) => {
    const db = openGoalDb();
    const threadIds = Array.from(new Set((Array.isArray(payload?.threadIds) ? payload.threadIds : [])
      .map((id) => String(id || "").trim().replace(/^local:/, ""))
      .filter((id) => UUID_RE.test(id))));
    return { goals: getGoalRows(db, threadIds) };
  });

  replaceMainHandler(api, IPC_SET, (payload) => {
    const db = openGoalDb();
    const threadId = requireThreadId(payload);
    const objective = String(payload?.objective || "").trim();
    if (!objective) throw new Error("Goal objective must not be empty.");
    assertThreadExists(db, threadId);
    if (payload?.minCreatedAtMs != null) {
      const minCreatedAtMs = Number(payload.minCreatedAtMs);
      const row = db.prepare("SELECT created_at_ms AS createdAtMs FROM threads WHERE id = ?").get(threadId);
      if (!row || Number(row.createdAtMs || 0) < minCreatedAtMs) {
        const error = new Error("Thread was created before this pending goal.");
        error.code = "THREAD_TOO_OLD_FOR_PENDING_GOAL";
        throw error;
      }
    }
    const existing = getGoalRow(db, threadId);
    if (existing && !payload?.replace) {
      const error = new Error("GOAL_EXISTS: A goal already exists for this thread.");
      error.code = "GOAL_EXISTS";
      error.goal = existing;
      throw error;
    }
    const now = Date.now();
    db.prepare(`
      INSERT INTO thread_goals (
        thread_id, goal_id, objective, status, token_budget,
        tokens_used, time_used_seconds, created_at_ms, updated_at_ms
      )
      VALUES (@threadId, @goalId, @objective, 'active', @tokenBudget, 0, 0, @now, @now)
      ON CONFLICT(thread_id) DO UPDATE SET
        goal_id = excluded.goal_id,
        objective = excluded.objective,
        status = 'active',
        token_budget = excluded.token_budget,
        tokens_used = 0,
        time_used_seconds = 0,
        created_at_ms = excluded.created_at_ms,
        updated_at_ms = excluded.updated_at_ms
    `).run({
      threadId,
      goalId: randomId(),
      objective,
      tokenBudget: positiveIntegerOrNull(payload?.tokenBudget),
      now,
    });
    return { goal: getGoalRow(db, threadId) };
  });

  replaceMainHandler(api, IPC_CLEAR, (payload) => {
    const db = openGoalDb();
    const threadId = requireThreadId(payload);
    db.prepare("DELETE FROM thread_goals WHERE thread_id = ?").run(threadId);
    return { goal: null };
  });

  replaceMainHandler(api, IPC_STATUS, (payload) => {
    const db = openGoalDb();
    const threadId = requireThreadId(payload);
    const status = String(payload?.status || "").trim();
    if (!GOAL_STATUSES.has(status)) throw new Error(`Unsupported goal status: ${status}`);
    db.prepare("UPDATE thread_goals SET status = ?, updated_at_ms = ? WHERE thread_id = ?")
      .run(status, Date.now(), threadId);
    return { goal: getGoalRow(db, threadId) };
  });

  replaceMainHandler(api, IPC_CREATE_THREAD, (payload) => {
    const db = openGoalDb();
    const objective = String(payload?.objective || "").trim();
    if (!objective) throw new Error("Goal objective must not be empty.");
    const context = normalizeThreadCreateContext(payload, db);
    const created = createGoalThread(db, context, objective);
    return {
      thread: {
        id: created.threadId,
        rolloutPath: created.rolloutPath,
      },
      goal: getGoalRow(db, created.threadId),
    };
  });
}

function replaceMainHandler(api, channel, handler) {
  removeMainHandler(api, channel);
  api.ipc.handle(channel, handler);
}

function removeMainHandler(api, channel) {
  try {
    const { ipcMain } = require("electron");
    ipcMain.removeHandler(`codexpp:${api.manifest.id}:${channel}`);
  } catch {}
}

let goalDb = null;
let goalDbPath = null;

function openGoalDb() {
  if (goalDb) return goalDb;
  const path = require("path");
  const os = require("os");
  const Database = requireBetterSqlite3(path);
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  goalDbPath = path.join(codexHome, "state_5.sqlite");
  goalDb = new Database(goalDbPath);
  goalDb.pragma("busy_timeout = 2000");
  return goalDb;
}

function requireBetterSqlite3(path) {
  try {
    return require("better-sqlite3");
  } catch (firstError) {
    try {
      const { createRequire } = require("module");
      const resourcesPath = process.resourcesPath || process.cwd();
      return createRequire(path.join(resourcesPath, "app.asar", "package.json"))("better-sqlite3");
    } catch {
      throw firstError;
    }
  }
}

function requireThreadId(payload) {
  const threadId = String(payload?.threadId || "").trim();
  if (!UUID_RE.test(threadId)) throw new Error("A valid thread id is required.");
  return threadId;
}

function assertThreadExists(db, threadId) {
  const row = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
  if (!row) throw new Error(`Thread not found: ${threadId}`);
}

function getGoalRow(db, threadId) {
  const row = db.prepare(`
    SELECT
      thread_id AS threadId,
      goal_id AS goalId,
      objective,
      status,
      token_budget AS tokenBudget,
      tokens_used AS tokensUsed,
      time_used_seconds AS timeUsedSeconds,
      created_at_ms AS createdAtMs,
      updated_at_ms AS updatedAtMs
    FROM thread_goals
    WHERE thread_id = ?
  `).get(threadId);
  return row || null;
}

function getGoalRows(db, threadIds) {
  if (!threadIds.length) return [];
  const placeholders = threadIds.map(() => "?").join(",");
  return db.prepare(`
    SELECT
      thread_id AS threadId,
      goal_id AS goalId,
      objective,
      status,
      token_budget AS tokenBudget,
      tokens_used AS tokensUsed,
      time_used_seconds AS timeUsedSeconds,
      created_at_ms AS createdAtMs,
      updated_at_ms AS updatedAtMs
    FROM thread_goals
    WHERE thread_id IN (${placeholders})
  `).all(...threadIds);
}

function resolveThreadIdFromTurnIds(db, turnIds) {
  const ids = Array.from(new Set((Array.isArray(turnIds) ? turnIds : [])
    .map((id) => String(id || "").trim())
    .filter((id) => UUID_RE.test(id))));
  if (!ids.length) return null;
  const rows = db.prepare(`
    SELECT id, rollout_path AS rolloutPath
    FROM threads
    WHERE archived = 0
    ORDER BY updated_at_ms DESC, updated_at DESC
    LIMIT 250
  `).all();
  const fs = require("fs");
  for (const row of rows) {
    const path = String(row.rolloutPath || "");
    if (!path || !fs.existsSync(path)) continue;
    let text = "";
    try {
      text = fs.readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (ids.some((id) => text.includes(`"turn_id":"${id}"`))) return row.id;
  }
  return null;
}

function randomId() {
  try {
    return require("crypto").randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function normalizeThreadCreateContext(payload, db) {
  const os = require("os");
  const cwd = nonEmptyString(payload?.cwd) ||
    inferCwdFromWorkspaceLabel(db, payload?.workspaceLabel) ||
    os.homedir();
  return {
    cwd,
    modelProvider: nonEmptyString(payload?.modelProvider) || "openai",
    model: nonEmptyString(payload?.model) || "gpt-5.5",
    reasoningEffort: nonEmptyString(payload?.reasoningEffort) || "high",
    approvalMode: nonEmptyString(payload?.approvalMode) || "on-request",
    sandboxPolicy: normalizeSandboxPolicy(payload?.sandboxPolicy),
    source: nonEmptyString(payload?.source) || "vscode",
    cliVersion: nonEmptyString(payload?.cliVersion) || "",
  };
}

function inferCwdFromWorkspaceLabel(db, label) {
  const path = require("path");
  const normalizedLabel = normalizeProjectLabel(label);
  if (!normalizedLabel) return null;
  try {
    const rows = db.prepare(`
      SELECT cwd
      FROM threads
      WHERE archived = 0 AND cwd != ''
      ORDER BY updated_at_ms DESC, created_at_ms DESC
      LIMIT 200
    `).all();
    for (const row of rows) {
      const cwd = String(row.cwd || "");
      if (normalizeProjectLabel(path.basename(cwd)) === normalizedLabel) return cwd;
    }
  } catch {}
  return null;
}

function normalizeProjectLabel(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function nonEmptyString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeSandboxPolicy(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {}
  }
  const text = nonEmptyString(value);
  if (text) return text;
  return JSON.stringify({
    type: "workspace-write",
    network_access: false,
    exclude_tmpdir_env_var: false,
    exclude_slash_tmp: false,
  });
}

function createGoalThread(db, context, objective) {
  const fs = require("fs");
  const path = require("path");
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const nowIso = new Date(nowMs).toISOString();
  const threadId = randomThreadId();
  const title = "Set goal";
  const firstUserMessage = `/goal ${objective}`;
  const codexHome = goalDbPath ? path.dirname(goalDbPath) : path.join(require("os").homedir(), ".codex");
  const rolloutPath = buildRolloutPath(path, codexHome, threadId, nowMs);
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    buildGoalRolloutJsonl({ threadId, nowIso, context, firstUserMessage }),
    "utf8"
  );

  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider,
        cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event,
        archived, cli_version, first_user_message, memory_mode, model,
        reasoning_effort, created_at_ms, updated_at_ms
      )
      VALUES (
        @threadId, @rolloutPath, @nowSeconds, @nowSeconds, @source, @modelProvider,
        @cwd, @title, @sandboxPolicy, @approvalMode, 0, 1,
        0, @cliVersion, @firstUserMessage, 'enabled', @model,
        @reasoningEffort, @nowMs, @nowMs
      )
    `).run({
      threadId,
      rolloutPath,
      nowSeconds,
      source: context.source,
      modelProvider: context.modelProvider,
      cwd: context.cwd,
      title,
      sandboxPolicy: context.sandboxPolicy,
      approvalMode: context.approvalMode,
      cliVersion: context.cliVersion,
      firstUserMessage,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      nowMs,
    });
    db.prepare(`
      INSERT INTO thread_goals (
        thread_id, goal_id, objective, status, token_budget,
        tokens_used, time_used_seconds, created_at_ms, updated_at_ms
      )
      VALUES (?, ?, ?, 'active', NULL, 0, 0, ?, ?)
    `).run(threadId, randomId(), objective, nowMs, nowMs);
  });
  create();
  return { threadId, rolloutPath };
}

function randomThreadId() {
  try {
    const crypto = require("crypto");
    const nowHex = Date.now().toString(16).padStart(12, "0").slice(-12);
    const random = crypto.randomBytes(9).toString("hex");
    const variant = ((parseInt(random[3], 16) & 0x3) | 0x8).toString(16);
    return [
      nowHex.slice(0, 8),
      nowHex.slice(8, 12),
      `7${random.slice(0, 3)}`,
      `${variant}${random.slice(4, 7)}`,
      random.slice(7, 19).padEnd(12, "0"),
    ].join("-");
  } catch {
    return randomId();
  }
}

function buildRolloutPath(path, codexHome, threadId, nowMs) {
  const date = new Date(nowMs);
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const sec = String(date.getSeconds()).padStart(2, "0");
  return path.join(
    codexHome,
    "sessions",
    yyyy,
    mm,
    dd,
    `rollout-${yyyy}-${mm}-${dd}T${hh}-${min}-${sec}-${threadId}.jsonl`
  );
}

function buildGoalRolloutJsonl({ threadId, nowIso, context, firstUserMessage }) {
  const lines = [
    {
      timestamp: nowIso,
      type: "session_meta",
      payload: {
        id: threadId,
        timestamp: nowIso,
        cwd: context.cwd,
        originator: "Codex Desktop",
        cli_version: context.cliVersion,
        source: context.source,
        model_provider: context.modelProvider,
        model: context.model,
        approval_policy: context.approvalMode,
        sandbox_policy: safeJsonParse(context.sandboxPolicy) || context.sandboxPolicy,
      },
    },
    {
      timestamp: nowIso,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: firstUserMessage }],
      },
    },
    {
      timestamp: nowIso,
      type: "event_msg",
      payload: {
        type: "user_message",
        message: firstUserMessage,
        images: [],
        local_images: [],
        text_elements: [],
      },
    },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function positiveIntegerOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function startRenderer(self, api) {
  const state = {
    process: "renderer",
    api,
    disposed: false,
    threadId: null,
    goal: null,
    pendingGoal: null,
    nativeGoalSubmit: null,
    nativeGoalPassthrough: null,
    goalChange: null,
    goalSummary: null,
    sidebarGoals: new Map(),
    sidebarGoalRefreshInFlight: false,
    sidebarGoalLastRefreshMs: 0,
    root: null,
    modal: null,
    style: installStyle(),
    scanTimer: null,
    observer: null,
    pollTimer: null,
    clockTimer: null,
    onKeyDown: null,
    onWindowKeyDown: null,
    onSubmit: null,
    onClick: null,
    onInput: null,
    onBeforeInput: null,
    onRouteChange: null,
    wiredEvents: [],
  };
  self._state = state;

  state.onKeyDown = (event) => {
    if (handleGoalSlashKeyboard(event)) return;
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey) return;
    const input = findComposerInput();
    maybeRunGoalSubmit(state, event, input);
  };

  state.onWindowKeyDown = (event) => {
    handleGoalSlashKeyboard(event);
  };

  state.onInput = () => scheduleScan(state);

  state.onBeforeInput = (event) => {
    if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return;
    const input = findComposerInput();
    maybeRunGoalSubmit(state, event, input);
  };

  state.onSubmit = (event) => {
    const input = findComposerInput(event.target);
    maybeRunGoalSubmit(state, event, input);
  };

  state.onClick = (event) => {
    const row = event.target?.closest?.(`[${SLASH_ROW_ATTR}="true"]`);
    if (row) {
      event.preventDefault();
      event.stopPropagation();
      const input = findComposerInput();
      if (input) insertGoalMentionFromSlash(input);
      return;
    }
    const button = event.target?.closest?.("button");
    if (!button || button.closest(`[${ROOT_ATTR}]`)) return;
    const input = findComposerInput();
    if (!input) return;
    const payload = getGoalComposerPayload(input);
    if (!payload) return;
    const form = input.closest("form");
    const buttonLabel = normalize(`${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.textContent || ""}`);
    const footer = button.closest(".composer-footer");
    const looksLikeSend =
      button.type === "submit" ||
      (form && form.contains(button)) ||
      (footer && button === findComposerSendButton()) ||
      /\bsend\b/.test(buttonLabel);
    if (!looksLikeSend) return;
    maybeRunGoalSubmit(state, event, input);
  };

  state.onRouteChange = () => {
    state.threadId = null;
    state.goalSummary = null;
    removeGoalSummaryPanel();
    void refreshGoal(state, { resolveThread: true });
  };

  window.addEventListener("keydown", state.onWindowKeyDown, true);
  document.addEventListener("keydown", state.onKeyDown, true);
  document.addEventListener("submit", state.onSubmit, true);
  document.addEventListener("click", state.onClick, true);
  document.addEventListener("input", state.onInput, true);
  document.addEventListener("beforeinput", state.onBeforeInput, true);
  window.addEventListener("popstate", state.onRouteChange);
  window.addEventListener("hashchange", state.onRouteChange);

  state.observer = new MutationObserver(() => scheduleScan(state));
  state.observer.observe(document.body, { childList: true, subtree: true });
  state.pollTimer = window.setInterval(() => refreshGoal(state), 2500);
  state.clockTimer = window.setInterval(() => {
    try {
      renderGoalSurface(state);
      renderGoalChangeDivider(state);
      renderGoalSummaryPanel(state);
      renderSidebarGoalIndicators(state);
    } catch (error) {
      state.api.log.warn("[goal] render failed", error);
    } finally {
      renderTranscriptGoalCompletionDividers();
      renderTranscriptGoalChangeDividers();
    }
  }, 1000);
  scheduleScan(state);
  void refreshGoal(state, { resolveThread: true });
}

function installStyle() {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .composer-footer:has([${ROOT_ATTR}="pill"]) {
      grid-template-columns: minmax(0, auto) minmax(0, 1fr) minmax(0, auto) !important;
    }

    [${ROOT_ATTR}="slot"] {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    [${ROOT_ATTR}="pill"] {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      box-sizing: border-box;
      max-width: min(100%, 11rem);
      min-width: 0;
      height: var(--token-button-composer-sm, 28px);
      border: 1px solid transparent;
      border-radius: 9999px;
      background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
      color: var(--color-token-text-tertiary, var(--color-token-text-secondary, currentColor));
      padding: 0 0.75rem;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      line-height: 18px;
      cursor: pointer;
      justify-content: center;
      white-space: nowrap;
    }

    [${ROOT_ATTR}="pill"]:hover {
      background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
      color: var(--color-token-text-secondary, currentColor);
    }

    [${ROOT_ATTR}="status"] {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-width: 0;
      font-weight: 400;
    }

    [${ROOT_ATTR}="label"] {
      display: inline-block;
      min-width: 0;
      overflow: hidden;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    [${ROOT_ATTR}="dot"] {
      position: relative;
      width: 0.375rem;
      height: 0.375rem;
      flex: none;
      border-radius: 999px;
      background: #7dd3a8;
    }

    [${ROOT_ATTR}="pill"][data-status="active"] [${ROOT_ATTR}="dot"] {
      box-shadow: 0 0 0 0.125rem color-mix(in srgb, #7dd3a8 12%, transparent);
    }

    [${ROOT_ATTR}="pill"][data-status="active"] [${ROOT_ATTR}="dot"]::after {
      content: "";
      position: absolute;
      inset: -0.25rem;
      border-radius: inherit;
      border: 1px solid color-mix(in srgb, #7dd3a8 42%, transparent);
      animation: codexpp-goal-pulse 1.45s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      pointer-events: none;
      will-change: opacity, transform;
    }

    [${ROOT_ATTR}="pill"][data-status="complete"] {
      border-color: color-mix(in srgb, #ff4fa3 35%, transparent);
      background: color-mix(in srgb, #ff4fa3 12%, var(--color-token-main-surface-primary, Canvas));
      color: #ff5ea8;
      min-width: 8.75rem;
    }

    [${ROOT_ATTR}="pill"][data-status="complete"] [${ROOT_ATTR}="label"] {
      min-width: 6.75rem;
    }

    [${ROOT_ATTR}="pill"][data-status="complete"] [${ROOT_ATTR}="dot"] {
      background: #ff4fa3;
      box-shadow: 0 0 0 0.1875rem color-mix(in srgb, #ff4fa3 18%, transparent);
    }

    [${ROOT_ATTR}="pill"][data-status="paused"] [${ROOT_ATTR}="dot"],
    [${ROOT_ATTR}="pill"][data-status="budget_limited"] [${ROOT_ATTR}="dot"] {
      background: #f0b86a;
    }

    [${ROOT_ATTR}="message-command"] {
      display: inline;
    }

    [${ROOT_ATTR}="message-objective"] {
      color: inherit;
    }

    [${ROOT_ATTR}="sidebar-pill"] {
      display: inline-flex;
      align-items: center;
      gap: 0.1875rem;
      box-sizing: border-box;
      height: 1rem;
      min-width: 0;
      border-radius: 9999px;
      background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
      color: var(--color-token-description-foreground, currentColor);
      padding: 0 0.375rem;
      font-size: 11px;
      line-height: 1rem;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    [${ROOT_ATTR}="sidebar-pill"] svg {
      width: 0.75rem;
      height: 0.75rem;
      flex: none;
    }

    [${ROOT_ATTR}="sidebar-pill"] span {
      font-size: inherit;
      line-height: inherit;
    }

    [${ROOT_ATTR}="summary"] {
      width: 100%;
    }

    @keyframes codexpp-goal-pulse {
      0% {
        opacity: 0.72;
        transform: scale(0.55);
      }
      70%, 100% {
        opacity: 0;
        transform: scale(1);
      }
    }

    [${ROOT_ATTR}="modal-backdrop"] {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 1rem;
      background: transparent;
    }

    [${ROOT_ATTR}="modal"] {
      position: relative !important;
      left: auto !important;
      top: auto !important;
      width: min(420px, 92vw);
      max-width: 92vw;
      max-height: calc(100vh - 2rem);
      overflow: auto;
      transform: none !important;
      outline: none;
      border-radius: 1.5rem;
      background: color-mix(in srgb, var(--color-token-dropdown-background, var(--color-token-main-surface-primary, Canvas)) 90%, transparent);
      color: var(--color-token-foreground, var(--color-token-text-primary, CanvasText));
      box-shadow:
        0 0 0 0.5px var(--color-token-border, color-mix(in srgb, currentColor 15%, transparent)),
        0 4px 8px -2px rgb(0 0 0 / 0.1);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
    }

    [${ROOT_ATTR}="modal-title"] {
      min-width: 0;
      font-size: 19px;
      font-weight: 600;
      line-height: 28px;
    }

    [${ROOT_ATTR}="modal-copy"] {
      margin: 0;
      color: var(--color-token-description-foreground, var(--color-token-text-secondary, currentColor));
      font-size: 13px;
      line-height: 19.5px;
    }

    [${ROOT_ATTR}="modal-actions"] {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      margin-top: 0.75rem;
    }

    [${ROOT_ATTR}="modal-button"] {
      min-height: 2rem;
      border-radius: 0.75rem;
      cursor: pointer;
      font-size: 13px;
      line-height: 18px;
      padding: 0.375rem 1rem;
    }

    [${ROOT_ATTR}="modal-button"][data-primary="true"] {
      background: var(--color-token-foreground, currentColor);
      color: var(--color-token-dropdown-background, Canvas);
    }

    [${ROOT_ATTR}="modal-close"] {
      position: absolute;
      top: 1rem;
      right: 1rem;
      border: 0;
      border-radius: 0.25rem;
      background: transparent;
      color: color-mix(in srgb, var(--color-token-foreground, currentColor) 80%, transparent);
      cursor: pointer;
      line-height: 1;
      padding: 0.25rem;
    }

    [${ROOT_ATTR}="modal-close"]:hover {
      background: var(--color-token-toolbar-hover-background, color-mix(in srgb, currentColor 8%, transparent));
    }

    [${SLASH_ROW_ATTR}="true"] {
      cursor: pointer;
    }

    [${SLASH_ROW_ATTR}="true"][data-codexpp-goal-selected] {
      background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
      opacity: 1;
    }

    ${GOAL_MENTION_SELECTOR} {
      --inline-mention-base-color: color-mix(in srgb, var(--color-token-text-link-foreground) 80%, var(--color-token-foreground) 20%);
      background: transparent !important;
      color: var(--inline-mention-color) !important;
      opacity: 1 !important;
    }
  `;
  document.head.appendChild(style);
  return style;
}

function scheduleScan(state) {
  if (state.disposed || state.scanTimer) return;
  state.scanTimer = window.setTimeout(() => {
    state.scanTimer = null;
    enhanceSlashMenus();
    patchGoalMentions();
    patchGoalMessages(document, state);
    wireGoalSubmitTargets(state);
    try {
      renderGoalSurface(state);
      renderGoalChangeDivider(state);
      renderGoalSummaryPanel(state);
      void refreshSidebarGoalIndicators(state);
    } catch (error) {
      state.api.log.warn("[goal] scan render failed", error);
    } finally {
      renderTranscriptGoalCompletionDividers();
      renderTranscriptGoalChangeDividers();
    }
  }, 80);
}

function wireGoalSubmitTargets(state) {
  const input = findComposerInput();
  if (input instanceof HTMLElement && !input.__codexppGoalInputWired) {
    const beforeInput = (event) => {
      if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return;
      maybeRunGoalSubmit(state, event, input);
    };
    const keyDown = (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey) return;
      maybeRunGoalSubmit(state, event, input);
    };
    input.addEventListener("beforeinput", beforeInput, true);
    input.addEventListener("keydown", keyDown, true);
    input.__codexppGoalInputWired = true;
    state.wiredEvents.push({ node: input, type: "beforeinput", handler: beforeInput });
    state.wiredEvents.push({ node: input, type: "keydown", handler: keyDown });
  }

  const sendButton = findComposerSendButton();
  if (sendButton instanceof HTMLElement && !sendButton.__codexppGoalSendWired) {
    const click = (event) => {
      maybeRunGoalSubmit(state, event, findComposerInput());
    };
    sendButton.addEventListener("click", click, true);
    sendButton.__codexppGoalSendWired = true;
    state.wiredEvents.push({ node: sendButton, type: "click", handler: click });
  }
}

function maybeRunGoalSubmit(state, event, input) {
  if (!input || !input.contains(event.target) && event.target !== input && event.type !== "click" && event.type !== "submit") return false;
  const payload = getGoalComposerPayload(input);
  if (!payload) return false;
  if (shouldAllowNativeGoalSubmit(state, payload.commandText)) return false;
  const parsed = parseGoalCommand(payload.commandText);
  const isNewConversation = isNewConversationScreen();
  const threadId = isNewConversation ? null : findThreadId(state.api);
  if (parsed.ok && parsed.action === "set" && !threadId && isNewConversation) {
    prepareNativeGoalConversation(state, parsed.objective, input);
    return false;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  void runGoalCommand(state, payload.commandText, input);
  return true;
}

function prepareNativeGoalConversation(state, objective, input) {
  const commandText = `/goal ${String(objective || "").trim()}`;
  if (input && getComposerText(input).trim() !== commandText) {
    setComposerText(input, commandText);
  }
  const startedAtMs = Date.now();
  state.pendingGoal = createPendingGoal(objective);
  state.nativeGoalSubmit = {
    objective: String(objective || "").trim(),
    commandText,
    startedAtMs,
    done: false,
  };
  renderGoalSurface(state);
  installNativeGoalThreadCapture(state, state.nativeGoalSubmit);
  void waitForNativeGoalThread(state, state.nativeGoalSubmit);
}

async function refreshGoal(state, options = {}) {
  if (state.disposed) return;
  const threadId = await resolveThreadId(state, options);
  if (!threadId) {
    state.goal = null;
    state.goalSummary = null;
    renderGoalSurface(state);
    removeGoalSummaryPanel();
    return;
  }
  try {
    const result = await state.api.ipc.invoke(IPC_GET, { threadId });
    state.goal = normalizeGoal(result?.goal);
    renderGoalSurface(state);
    void refreshSidebarGoalIndicators(state, { force: true });
  } catch (error) {
    state.api.log.warn("[goal] failed to refresh", error);
  }
}

async function resolveThreadId(state, options = {}) {
  if (isNewConversationScreen()) {
    state.threadId = null;
    return null;
  }
  const fromDom = findThreadId(state.api);
  if (fromDom) {
    state.threadId = fromDom;
    return fromDom;
  }
  const fromTurns = await resolveThreadIdFromVisibleTurns(state);
  if (fromTurns) {
    state.threadId = fromTurns;
    return fromTurns;
  }
  state.threadId = null;
  return null;
}

async function resolveThreadIdFromVisibleTurns(state) {
  const turnIds = Array.from(document.querySelectorAll("[data-turn-key]"))
    .map((node) => node.getAttribute("data-turn-key"))
    .filter((id) => UUID_RE.test(String(id || "")));
  if (!turnIds.length) return null;
  try {
    const result = await state.api.ipc.invoke(IPC_RESOLVE_THREAD, { turnIds });
    state.goal = normalizeGoal(result?.goal) || state.goal;
    return String(result?.threadId || "").match(UUID_RE)?.[0] || null;
  } catch (error) {
    state.api.log.warn("[goal] failed to resolve thread from visible turns", error);
    return null;
  }
}

function isNewConversationScreen() {
  if (`${location.pathname} ${location.hash} ${location.search}`.match(UUID_RE)) return false;
  const main = document.querySelector("[data-app-shell-main-content-layout]") || document.querySelector("main") || document.body;
  const text = normalize(main?.textContent || "");
  return text.includes("what should we work on") ||
    Boolean(findComposerInput()) && !document.querySelector('[data-thread-find-target="conversation"] [data-turn-key]');
}

function findThreadId(api) {
  const fromUrl = `${location.pathname} ${location.hash} ${location.search}`.match(UUID_RE)?.[0];
  if (fromUrl) return fromUrl;
  const fromActiveRow = document
    .querySelector('[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]')
    ?.getAttribute("data-app-action-sidebar-thread-id")
    ?.match(UUID_RE)?.[0];
  if (fromActiveRow) return fromActiveRow;
  const input = findComposerInput();
  const fromReact = input ? findUuidInFiber(api, input) : null;
  if (fromReact) return fromReact;
  return null;
}

function findUuidInFiber(api, node) {
  const fiber = getReactFiber(api, node);
  if (!fiber) return null;
  const seen = new WeakSet();
  for (let i = 0; fiber && i < 60; i += 1, fiber = fiber.return) {
    const found = findUuidInValue(fiber.memoizedProps, seen) ||
      findUuidInValue(fiber.pendingProps, seen) ||
      findUuidInValue(fiber.memoizedState, seen);
    if (found) return found;
  }
  return null;
}

function findUuidInValue(value, seen, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") return value.match(UUID_RE)?.[0] || null;
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    const keyText = String(key).toLowerCase();
    if (/thread|conversation|session/.test(keyText) && typeof child === "string") {
      const match = child.match(UUID_RE)?.[0];
      if (match) return match;
    }
  }
  for (const [, child] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
    const found = findUuidInValue(child, seen, depth + 1);
    if (found) return found;
  }
  return null;
}

function enhanceSlashMenus() {
  enhanceInlineSlashMenus();
  enhanceSlashCommandDialogs();
}

function enhanceInlineSlashMenus() {
  if (!shouldShowGoalSlashRow()) {
    removeGoalSlashRows();
    return;
  }
  document
    .querySelectorAll('[data-composer-overlay-floating-ui="true"] .vertical-scroll-fade-mask')
    .forEach((scroller) => {
      if (!(scroller instanceof HTMLElement)) return;
      if (scroller.querySelector(`[${SLASH_ROW_ATTR}="true"]`)) {
        updateGoalSlashSelection(scroller);
        removeNoCommandsTextNodes(scroller);
        return;
      }
      const group = scroller.querySelector(":scope > div:not([data-codexpp-slash-topbar])") || scroller;
      const row = createGoalSlashRow("inline");
      if (isNoCommandsNode(group)) group.replaceChildren(row);
      else group.insertBefore(row, group.firstChild);
      hideNoCommandsNodes(scroller);
      removeNoCommandsTextNodes(scroller);
      updateGoalSlashSelection(scroller, true);
    });
}

function enhanceSlashCommandDialogs() {
  if (!shouldShowGoalSlashRow()) {
    removeGoalSlashRows();
    return;
  }
  document.querySelectorAll("[cmdk-list]").forEach((list) => {
    if (!(list instanceof HTMLElement)) return;
    if (list.querySelector(`[${SLASH_ROW_ATTR}="true"]`)) {
      updateGoalSlashSelection(list);
      removeNoCommandsTextNodes(list);
      return;
    }
    const root = list.closest("[cmdk-root]");
    if (!root && !looksLikeSlashCommandDialog(list)) return;
    const target =
      list.querySelector('[cmdk-group-items=""]') ||
      list.querySelector('[role="group"]') ||
      Array.from(list.children).find((node) => node instanceof HTMLElement && isNoCommandsNode(node)) ||
      list;
    const row = createGoalSlashRow("dialog");
    if (isNoCommandsNode(target)) target.replaceChildren(row);
    else target.insertBefore(row, target.firstChild);
    hideNoCommandsNodes(list);
    removeNoCommandsTextNodes(list);
    updateGoalSlashSelection(list, true);
  });
}

function shouldShowGoalSlashRow() {
  const query = currentSlashQuery();
  return query != null && "goal".startsWith(query);
}

function currentSlashQuery() {
  const input = findComposerInput();
  if (!input) return null;
  const text = getComposerText(input).trim();
  if (!text.startsWith("/")) return null;
  const body = text.slice(1).trim().toLowerCase();
  if (body.includes(" ")) return null;
  return body;
}

function removeGoalSlashRows(root = document) {
  root.querySelectorAll?.(`[${SLASH_ROW_ATTR}="true"]`).forEach((node) => node.remove());
}

function updateGoalSlashSelection(root = document, forceSelected = false) {
  const query = currentSlashQuery();
  root.querySelectorAll?.(`[${SLASH_ROW_ATTR}="true"]`).forEach((row) => {
    const selected = forceSelected || (
      query != null &&
      query.length > 0 &&
      !hasOtherSelectedSlashItem(root, row)
    );
    if (selected) clearOtherSlashSelections(root, row);
    row.setAttribute("aria-selected", selected ? "true" : "false");
    row.toggleAttribute("data-codexpp-goal-selected", selected);
  });
}

function handleGoalSlashKeyboard(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter" && event.key !== "Tab") return false;
  const query = currentSlashQuery();
  if (query == null || !"goal".startsWith(query)) return false;
  enhanceSlashMenus();
  const row = document.querySelector(`[${SLASH_ROW_ATTR}="true"]`);
  if (!(row instanceof HTMLElement) || !visible(row)) {
    if (event.key !== "Tab" || query.length < 2) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const input = findComposerInput();
    if (input) insertGoalMentionFromSlash(input);
    removeGoalSlashRows();
    return true;
  }
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && isGoalSlashRowSelected(row)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    deferSlashSelectionUpdate(() => moveSelectionFromGoalSlashRow(row, event.key === "ArrowDown" ? 1 : -1));
    return true;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const direction = event.key === "ArrowDown" ? 1 : -1;
    if (shouldMoveSelectionToGoalSlashRow(row, direction)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      deferSlashSelectionUpdate(() => selectGoalSlashRow(row));
      return true;
    }
  }
  if (event.key !== "Enter" && event.key !== "Tab") return false;
  if (isGoalSlashRowSelected(row) || (event.key === "Tab" && !hasOtherSelectedSlashItem(row.closest(".vertical-scroll-fade-mask, [cmdk-list]") || document, row))) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const input = findComposerInput();
    if (input) insertGoalMentionFromSlash(input);
    removeGoalSlashRows();
    return true;
  }
  return false;
}

function deferSlashSelectionUpdate(callback) {
  window.setTimeout(callback, 0);
}

function clearOtherSlashSelections(root, goalRow) {
  const items = root.querySelectorAll?.([
    '[data-list-navigation-item="true"]',
    '[cmdk-item]',
  ].join(",")) || [];
  for (const item of items) {
    if (item === goalRow) continue;
    clearSlashRowSelection(item);
  }
}

function selectGoalSlashRow(goalRow) {
  const root = goalRow.closest(".vertical-scroll-fade-mask, [cmdk-list]") || document;
  clearOtherSlashSelections(root, goalRow);
  goalRow.setAttribute("aria-selected", "true");
  goalRow.setAttribute("data-codexpp-goal-selected", "");
  goalRow.classList.add("opacity-100");
}

function hasOtherSelectedSlashItem(root, goalRow) {
  const selectedItems = root.querySelectorAll?.([
    '[data-list-navigation-item="true"][aria-selected="true"]',
    '[data-list-navigation-item="true"][data-selected="true"]',
    '[cmdk-item][aria-selected="true"]',
    '[cmdk-item][data-selected="true"]',
  ].join(",")) || [];
  return Array.from(selectedItems).some((item) => item !== goalRow);
}

function isGoalSlashRowSelected(row) {
  return row.getAttribute("aria-selected") === "true" ||
    row.hasAttribute("data-codexpp-goal-selected") ||
    row.getAttribute("data-selected") === "true";
}

function shouldMoveSelectionToGoalSlashRow(goalRow, direction) {
  const rows = getVisibleSlashRows(goalRow);
  const goalIndex = rows.indexOf(goalRow);
  if (goalIndex < 0) return false;
  const selectedIndex = rows.findIndex((row) => row !== goalRow && isSlashRowSelected(row));
  if (selectedIndex < 0) return false;
  if (direction < 0) return selectedIndex === goalIndex + 1;
  return selectedIndex === rows.length - 1 && goalIndex === 0;
}

function isSlashRowSelected(row) {
  return row.getAttribute("aria-selected") === "true" ||
    row.getAttribute("data-selected") === "true";
}

function moveSelectionFromGoalSlashRow(goalRow, direction) {
  const root = goalRow.closest(".vertical-scroll-fade-mask, [cmdk-list]") || document;
  const rows = getVisibleSlashRows(goalRow);
  const currentIndex = rows.indexOf(goalRow);
  const next = rows[currentIndex + direction] || rows[direction > 0 ? 0 : rows.length - 1];
  clearSlashRowSelection(goalRow);
  if (next && next !== goalRow) {
    clearOtherSlashSelections(root, next);
    next.setAttribute("aria-selected", "true");
    next.classList.add("bg-token-list-hover-background", "opacity-100");
  }
}

function clearSlashRowSelection(row) {
  row.setAttribute?.("aria-selected", "false");
  row.removeAttribute?.("data-selected");
  row.removeAttribute?.("data-codexpp-goal-selected");
  row.classList?.remove("bg-token-list-hover-background", "opacity-100");
}

function getVisibleSlashRows(goalRow) {
  const root = goalRow.closest(".vertical-scroll-fade-mask, [cmdk-list]") || document;
  return Array.from(root.querySelectorAll([
    '[data-list-navigation-item="true"]',
    '[cmdk-item]',
  ].join(","))).filter((row) => row instanceof HTMLElement && visible(row));
}

function isNoCommandsNode(node) {
  if (!(node instanceof HTMLElement)) return false;
  if (node.querySelector(`[${SLASH_ROW_ATTR}="true"]`)) return false;
  const text = normalize(node.textContent || "");
  return text === "no commands" || text === "no command";
}

function hideNoCommandsNodes(root) {
  const candidates = Array.from(root.querySelectorAll("[cmdk-empty], div, span"));
  for (const node of candidates) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.querySelector(`[${SLASH_ROW_ATTR}="true"]`)) continue;
    if (isNoCommandsNode(node)) {
      node.hidden = true;
      node.style.display = "none";
    }
  }
}

function removeNoCommandsTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const removals = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (normalize(node.nodeValue || "") === "no commands") removals.push(node);
  }
  for (const node of removals) node.remove();
}

function looksLikeSlashCommandDialog(node) {
  const text = normalize(node.closest("[role='dialog']")?.textContent || node.textContent || "");
  return text.includes("slash commands") || text.includes("no commands") || text.includes("search");
}

function createGoalSlashRow(kind) {
  const isDialog = kind === "dialog";
  const row = document.createElement(isDialog ? "div" : "button");
  if (!isDialog) row.type = "button";
  row.setAttribute(SLASH_ROW_ATTR, "true");
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.setAttribute("tabindex", "-1");
  row.setAttribute("data-value", "Goal");
  row.setAttribute("cmdk-item", "");
  row.setAttribute("data-list-navigation-item", "true");
  row.className = isDialog
    ? "relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none"
    : "text-token-foreground outline-hidden opacity-75 focus:bg-token-list-hover-background cursor-interaction w-full shrink-0 overflow-hidden rounded-lg px-row-x py-row-y text-left text-sm hover:bg-token-list-hover-background hover:opacity-100";
  row.innerHTML =
    '<div class="flex w-full items-center gap-2">' +
    goalIconSvg() +
    (isDialog
        ? '<div class="min-w-0 flex-1 truncate">Goal</div>'
        : '<div class="codexpp-slash-skill-copy">' +
        '<div class="max-w-[60%] flex-none truncate">Goal</div>' +
        "<span class=\"min-w-0 flex-1 truncate text-sm text-token-description-foreground\">Start or show this chat's goal</span>" +
        "</div>") +
    "</div>";
  return row;
}

function renderGoalSurface(state) {
  const goal = state.goal;
  let root = state.root;
  document.querySelectorAll(`[${ROOT_ATTR}="bar"]`).forEach((node) => {
    if (node !== root) node.remove();
  });
  if (!goal) {
    root?.remove();
    state.root = null;
    renderTranscriptGoalCompletionDividers();
    return;
  }
  renderGoalTimelineDivider(goal);
  if (goal.status === "complete") {
    root?.remove();
    state.root = null;
    return;
  }
  const slot = findGoalFooterSlot();
  if (!slot) return;
  if (!root) {
    root = document.createElement("div");
    root.setAttribute(ROOT_ATTR, "pill");
    root.setAttribute("role", "button");
    root.tabIndex = 0;
    state.root = root;
  }
  if (root.parentElement !== slot) {
    slot.append(root);
  }
  root.dataset.status = goal.status;
  root.title = "Scroll to goal message";
  root.setAttribute("aria-label", `${goalStatusLabel(goal)}. Scroll to goal message.`);
  root.onclick = () => scrollToGoalMessage(goal);
  root.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    scrollToGoalMessage(goal);
  };
  const labelText = goalStatusLabel(goal);
  if (root.dataset.status === goal.status && root.dataset.label === labelText && root.childElementCount) return;
  root.replaceChildren();

  const status = document.createElement("div");
  status.setAttribute(ROOT_ATTR, "status");
  const dot = document.createElement("span");
  dot.setAttribute(ROOT_ATTR, "dot");
  const label = document.createElement("span");
  label.setAttribute(ROOT_ATTR, "label");
  label.textContent = labelText;
  status.append(dot, label);

  root.dataset.label = labelText;
  root.append(status);
}

function renderGoalTimelineDivider(goal) {
  if (goal.status !== "complete") {
    removeGoalTimelineDivider("state");
    renderTranscriptGoalCompletionDividers();
    return;
  }
  const conversation = findConversationContainer();
  if (!conversation) return;
  if (hasTranscriptGoalCompletion(conversation)) {
    removeGoalTimelineDivider("state");
    renderTranscriptGoalCompletionDividers();
    return;
  }
  let divider = conversation.querySelector(`[${ROOT_ATTR}="achieved-divider"][data-goal-source="state"]`) ||
    document.querySelector(`[${ROOT_ATTR}="achieved-divider"][data-goal-source="state"]`);
  if (!divider) {
    divider = document.createElement("div");
    divider.setAttribute(ROOT_ATTR, "achieved-divider");
    divider.className = "flex flex-col";
    divider.setAttribute("role", "status");
  }
  divider.dataset.goalSource = "state";
  const label = `Goal achieved in ${formatDuration(goalDurationSeconds(goal))}`;
  if (divider.dataset.label !== label || divider.dataset.layout !== "compact") {
    divider.dataset.label = label;
    divider.dataset.layout = "compact";
    divider.innerHTML = goalTimelineDividerHtml(flagIconSvg(), label);
  }
  placeGoalTimelineDivider(divider, goal, conversation);
}

function removeGoalTimelineDivider(source) {
  const selector = source
    ? `[${ROOT_ATTR}="achieved-divider"][data-goal-source="${source}"]`
    : `[${ROOT_ATTR}="achieved-divider"]`;
  document.querySelectorAll(selector).forEach((node) => node.remove());
}

function renderGoalChangeDivider(state) {
  const change = state.goalChange;
  if (!change?.id) {
    document.querySelectorAll(`[${ROOT_ATTR}="changed-divider"]`).forEach((node) => {
      if (node.getAttribute("data-goal-source") !== "transcript") node.remove();
    });
    renderTranscriptGoalChangeDividers();
    return;
  }
  const currentThreadId = state.threadId || state.goal?.threadId || "";
  if (change.threadId && currentThreadId && change.threadId !== currentThreadId) return;
  const conversation = findConversationContainer();
  if (!conversation) return;
  const selector = `[${ROOT_ATTR}="changed-divider"][data-goal-change-id="${CSS.escape(change.id)}"]`;
  let divider = document.querySelector(selector);
  if (!divider) {
    divider = document.createElement("div");
    divider.setAttribute(ROOT_ATTR, "changed-divider");
    divider.dataset.goalChangeId = change.id;
    divider.className = "flex flex-col";
    divider.setAttribute("role", "status");
  }
  divider.dataset.goalSource = "state";
  divider.dataset.goalObjective = change.objective || "";
  if (divider.dataset.label !== "Goal Changed" || divider.dataset.layout !== "compact") {
    divider.dataset.label = "Goal Changed";
    divider.dataset.layout = "compact";
    divider.innerHTML = goalTimelineDividerHtml(rotateIconSvg(), "Goal Changed");
  }
  const anchor = findGoalMessageElement({ objective: change.objective });
  if (anchor?.parentElement) {
    if (divider.parentElement !== anchor.parentElement || divider.nextElementSibling !== anchor) {
      anchor.insertAdjacentElement("beforebegin", divider);
    }
    return;
  }
  const list = findTranscriptList(conversation);
  if (divider.parentElement !== list) list.append(divider);
}

function goalTimelineDividerHtml(icon, label) {
  return (
    '<div class="text-size-chat flex items-center gap-2 text-token-text-secondary">' +
    '<div class="flex-1 border-t border-token-border-default"></div>' +
    '<div class="flex items-center gap-1 whitespace-nowrap">' +
    icon +
    `<span>${escapeHtml(label)}</span>` +
    "</div>" +
    '<div class="flex-1 border-t border-token-border-default"></div>' +
    "</div>"
  );
}

async function refreshSidebarGoalIndicators(state, options = {}) {
  if (state.disposed || state.sidebarGoalRefreshInFlight) return;
  const now = Date.now();
  if (!options.force && now - Number(state.sidebarGoalLastRefreshMs || 0) < 1000) {
    renderSidebarGoalIndicators(state);
    return;
  }
  const rows = visibleSidebarThreadRows();
  const threadIds = Array.from(new Set(rows
    .map((row) => row.getAttribute("data-app-action-sidebar-thread-id") || "")
    .map((id) => id.replace(/^local:/, ""))
    .filter((id) => UUID_RE.test(id))));
  if (!threadIds.length) {
    state.sidebarGoals.clear();
    renderSidebarGoalIndicators(state);
    return;
  }
  state.sidebarGoalRefreshInFlight = true;
  state.sidebarGoalLastRefreshMs = now;
  try {
    const result = await state.api.ipc.invoke(IPC_LIST, { threadIds });
    state.sidebarGoals = new Map((Array.isArray(result?.goals) ? result.goals : [])
      .map(normalizeGoal)
      .filter(Boolean)
      .map((goal) => [goal.threadId, goal]));
  } catch (error) {
    state.api.log.warn("[goal] failed to refresh sidebar goals", error);
  } finally {
    state.sidebarGoalRefreshInFlight = false;
    renderSidebarGoalIndicators(state);
  }
}

function renderSidebarGoalIndicators(state) {
  const rows = visibleSidebarThreadRows();
  const liveRows = new Set(rows);
  document.querySelectorAll(`[${ROOT_ATTR}="sidebar-pill"]`).forEach((pill) => {
    const row = pill.closest("[data-app-action-sidebar-thread-id]");
    if (!row || !liveRows.has(row)) pill.remove();
  });
  for (const row of rows) {
    const threadId = String(row.getAttribute("data-app-action-sidebar-thread-id") || "").replace(/^local:/, "");
    const goal = state.sidebarGoals.get(threadId);
    cleanupSidebarGoalTitle(row, goal);
    const pill = row.querySelector(`[${ROOT_ATTR}="sidebar-pill"]`);
    if (!goal || !ACTIVE_STATUSES.has(goal.status)) {
      pill?.remove();
      continue;
    }
    const meta = findSidebarThreadMeta(row);
    if (!meta) {
      pill?.remove();
      continue;
    }
    let nextPill = pill;
    if (!(nextPill instanceof HTMLElement)) {
      nextPill = document.createElement("span");
      nextPill.setAttribute(ROOT_ATTR, "sidebar-pill");
      meta.insertBefore(nextPill, meta.firstChild);
    } else if (nextPill.parentElement !== meta) {
      meta.insertBefore(nextPill, meta.firstChild);
    }
    const label = formatSidebarDuration(goalDurationSeconds(goal));
    if (nextPill.dataset.label !== label) {
      nextPill.dataset.label = label;
      nextPill.setAttribute("aria-label", `Goal timer ${label}`);
      nextPill.innerHTML = goalIconSvg({ marker: true }) + `<span>${escapeHtml(label)}</span>`;
    }
  }
}

function visibleSidebarThreadRows() {
  return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
    .filter((row) => row instanceof HTMLElement && visible(row));
}

function cleanupSidebarGoalTitle(row, goal) {
  const patched = row.querySelector(`[${ROOT_ATTR}="message-command"]`);
  if (!patched && !goal) return;
  const objective = goal?.objective || patched?.getAttribute("data-goal-objective") || "";
  if (!objective) return;
  const title = findSidebarThreadTitle(row) || patched.closest("span, div");
  if (title instanceof HTMLElement) title.textContent = objective;
  else patched.replaceWith(document.createTextNode(objective));
}

function findSidebarThreadTitle(row) {
  return row.querySelector("span.min-w-0.flex-1.truncate.select-none") ||
    Array.from(row.querySelectorAll("span")).find((node) =>
      node instanceof HTMLElement &&
      node.className.includes("truncate") &&
      !node.closest(`[${ROOT_ATTR}="sidebar-pill"]`) &&
      !node.closest("[data-testid*='time' i]")
    ) || null;
}

function findSidebarThreadMeta(row) {
  return Array.from(row.querySelectorAll("div")).find((node) =>
    node instanceof HTMLElement &&
    node.className.includes("flex") &&
    node.className.includes("justify-end") &&
    (node.className.includes("ml-[3px]") || node.className.includes("min-w-[26px]") || node.className.includes("gap-1"))
  ) || null;
}

function showGoalSummary(state) {
  const goal = state.goal || state.pendingGoal;
  if (!goal) {
    state.goalSummary = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      threadId: state.threadId || "",
      status: "",
      hasGoal: false,
      rows: [
        ["Status", "No goal"],
        ["Objective", "No goal is set for this chat."],
        ["Time used", "0s"],
        ["Tokens used", "0"],
      ],
    };
  } else {
    state.goalSummary = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      threadId: goal.threadId || state.threadId || "",
      status: goal.status || "",
      hasGoal: true,
      rows: [
        ["Status", goalSummaryStatus(goal)],
        ["Objective", goal.objective || "No objective"],
        ["Time used", formatDuration(goalDurationSeconds(goal))],
        ["Tokens used", formatTokenCount(goal.tokensUsed)],
      ],
    };
  }
  renderGoalSummaryPanel(state);
}

function renderGoalSummaryPanel(state) {
  const summary = state.goalSummary;
  if (!summary?.id) {
    removeGoalSummaryPanel();
    return;
  }
  const currentThreadId = state.threadId || state.goal?.threadId || "";
  if (summary.threadId && currentThreadId && summary.threadId !== currentThreadId) {
    removeGoalSummaryPanel();
    return;
  }
  const conversation = findConversationContainer();
  if (!conversation) return;
  let panel = document.querySelector(`[${ROOT_ATTR}="summary"]`);
  if (!panel) {
    panel = document.createElement("div");
    panel.setAttribute(ROOT_ATTR, "summary");
    panel.className = "px-3";
    panel.setAttribute("role", "status");
  }
  panel.dataset.summaryId = summary.id;
  const rowsHtml = summary.rows.map(([key, value]) =>
    '<span class="contents">' +
    `<div class="text-token-description-foreground text-left whitespace-nowrap max-[260px]:hidden" ${ROOT_ATTR}="summary-key">${escapeHtml(key)}:</div>` +
    '<div class="text-left text-token-foreground">' +
    `<span class="block max-w-full truncate" ${ROOT_ATTR}="summary-value">${escapeHtml(value)}</span>` +
    "</div>" +
    "</span>"
  ).join("");
  const actionButtonClass = "border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-full text-token-text-tertiary enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent h-token-button-composer-sm px-1.5 py-0 text-sm leading-[18px]";
  const lifecycleAction = summary.status === "paused" ? "resume" : "pause";
  const lifecycleLabel = summary.status === "paused" ? "Resume" : "Pause";
  const lifecycleButton = summary.hasGoal && summary.status !== "complete"
    ? `<button type="button" class="${actionButtonClass}" title="/goal ${lifecycleAction}" ${ROOT_ATTR}="summary-${lifecycleAction}">${lifecycleLabel}</button>`
    : "";
  const clearButton = summary.hasGoal
    ? `<button type="button" class="${actionButtonClass}" title="/goal clear" ${ROOT_ATTR}="summary-clear">Clear</button>`
    : "";
  const html =
    '<div class="flex w-full flex-col gap-3 rounded-t-xl border-x border-t border-token-border bg-token-input-background px-3 py-2 text-sm [text-wrap:pretty] text-token-foreground lg:mx-auto" ' +
    `${ROOT_ATTR}="summary-card">` +
    '<div class="flex items-start justify-between gap-2">' +
    '<div class="flex items-center gap-1">' +
    '<span class="font-semibold max-[220px]:hidden">Goal</span>' +
    "</div>" +
    '<div class="flex shrink-0 items-center gap-1">' +
    lifecycleButton +
    clearButton +
    `<button type="button" class="${actionButtonClass}" ${ROOT_ATTR}="summary-close">Close</button>` +
    "</div>" +
    "</div>" +
    '<div class="font-mono text-xs leading-relaxed">' +
    '<div class="grid items-start gap-x-4 gap-y-1 grid-cols-[92px_minmax(0,1fr)]">' +
    rowsHtml +
    "</div>" +
    "</div>" +
    "</div>";
  if (panel.dataset.html !== html) {
    panel.dataset.html = html;
    panel.innerHTML = html;
  }
  const close = panel.querySelector(`[${ROOT_ATTR}="summary-close"]`);
  if (close instanceof HTMLElement) {
    close.onclick = () => {
      state.goalSummary = null;
      removeGoalSummaryPanel();
    };
  }
  const pause = panel.querySelector(`[${ROOT_ATTR}="summary-pause"]`);
  if (pause instanceof HTMLButtonElement) {
    pause.onclick = async () => {
      pause.disabled = true;
      try {
        await setGoalStatus(state, "paused");
        showGoalSummary(state);
      } catch (error) {
        pause.disabled = false;
        state.api.log.warn("[goal] pause from summary failed", error);
        showToast(error?.message || "Goal command failed.");
      }
    };
  }
  const resume = panel.querySelector(`[${ROOT_ATTR}="summary-resume"]`);
  if (resume instanceof HTMLButtonElement) {
    resume.onclick = async () => {
      resume.disabled = true;
      try {
        await setGoalStatus(state, "active");
        showGoalSummary(state);
      } catch (error) {
        resume.disabled = false;
        state.api.log.warn("[goal] resume from summary failed", error);
        showToast(error?.message || "Goal command failed.");
      }
    };
  }
  const clear = panel.querySelector(`[${ROOT_ATTR}="summary-clear"]`);
  if (clear instanceof HTMLButtonElement) {
    clear.onclick = async () => {
      clear.disabled = true;
      try {
        await clearGoal(state);
        state.goalSummary = null;
        removeGoalSummaryPanel();
      } catch (error) {
        clear.disabled = false;
        state.api.log.warn("[goal] clear from summary failed", error);
        showToast(error?.message || "Goal command failed.");
      }
    };
  }
  const host = findGoalSummaryHost();
  if (host?.parent && host.before) {
    if (panel.parentElement !== host.parent || panel.nextElementSibling !== host.before) {
      host.parent.insertBefore(panel, host.before);
    }
    return;
  }
  if (panel.parentElement !== conversation || panel.nextElementSibling) conversation.append(panel);
}

function findGoalSummaryHost() {
  const footer = findComposerFooter();
  if (!footer) return null;
  const shell = closestWithClassPart(footer, "bg-token-input-background");
  const wrapper = shell?.parentElement;
  if (wrapper && shell) return { parent: wrapper, before: shell };
  const fallback = footer.closest(".relative") || footer.parentElement;
  return fallback?.parentElement ? { parent: fallback.parentElement, before: fallback } : null;
}

function findComposerFooter() {
  return Array.from(document.querySelectorAll(".composer-footer"))
    .find((node) => node instanceof HTMLElement && visible(node)) || null;
}

function closestWithClassPart(node, part) {
  for (let current = node; current instanceof HTMLElement; current = current.parentElement) {
    if (String(current.className || "").includes(part)) return current;
  }
  return null;
}

function removeGoalSummaryPanel() {
  document.querySelectorAll(`[${ROOT_ATTR}="summary"]`).forEach((node) => node.remove());
}

function goalSummaryStatus(goal) {
  if (goal.status === "complete") return "completed";
  if (goal.status === "budget_limited") return "budget reached";
  if (goal.status === "paused") return "paused";
  return "active";
}

function findConversationContainer() {
  const candidates = Array.from(document.querySelectorAll('[data-thread-find-target="conversation"], main [class*="gap-3"]'))
    .filter((node) => node instanceof HTMLElement && visible(node));
  return candidates[0] || null;
}

function findTranscriptList(conversation = findConversationContainer()) {
  if (!conversation?.querySelectorAll) return conversation || document.body;
  const turns = Array.from(conversation.querySelectorAll("[data-turn-key]"))
    .filter((node) => node instanceof HTMLElement);
  const parent = turns.find((turn) => turn.parentElement)?.parentElement;
  return parent || conversation;
}

function renderTranscriptGoalCompletionDividers() {
  const turns = findGoalCompletionCandidateTurns();
  const valid = new Set();
  for (const turn of turns) {
    const completion = parseGoalCompletionText(turn.textContent || "");
    if (!completion) continue;
    let divider = turn.nextElementSibling;
    if (!(divider instanceof HTMLElement) || divider.getAttribute(ROOT_ATTR) !== "achieved-divider") {
      divider = document.createElement("div");
      divider.setAttribute(ROOT_ATTR, "achieved-divider");
      divider.className = "flex flex-col";
      divider.setAttribute("role", "status");
      turn.insertAdjacentElement("afterend", divider);
    }
    divider.dataset.goalSource = "transcript";
    divider.dataset.goalCompletionTurn = turn.getAttribute("data-turn-key") || "";
    const label = `Goal achieved in ${completion.label}`;
    if (divider.dataset.label !== label || divider.dataset.layout !== "compact") {
      divider.dataset.label = label;
      divider.dataset.layout = "compact";
      divider.innerHTML = goalTimelineDividerHtml(flagIconSvg(), label);
    }
    valid.add(divider);
  }
  document.querySelectorAll(`[${ROOT_ATTR}="achieved-divider"][data-goal-source="transcript"]`).forEach((divider) => {
    if (!valid.has(divider)) divider.remove();
  });
  if (valid.size) removeGoalTimelineDivider("state");
}

function hasTranscriptGoalCompletion(root = findConversationContainer()) {
  return findGoalCompletionCandidateTurns(root)
    .some((turn) => parseGoalCompletionText(turn.textContent || ""));
}

function renderTranscriptGoalChangeDividers() {
  const turns = findGoalMessageTurns();
  const valid = new Set();
  for (let index = 1; index < turns.length; index += 1) {
    const turn = turns[index];
    const previous = turn.previousElementSibling;
    let divider = previous instanceof HTMLElement && previous.getAttribute(ROOT_ATTR) === "changed-divider"
      ? previous
      : null;
    if (!divider) {
      divider = document.createElement("div");
      divider.setAttribute(ROOT_ATTR, "changed-divider");
      divider.className = "flex flex-col";
      divider.setAttribute("role", "status");
      turn.insertAdjacentElement("beforebegin", divider);
    }
    divider.dataset.goalSource = "transcript";
    divider.dataset.goalChangeTurn = turn.getAttribute("data-turn-key") || "";
    const objective = turn.querySelector(`[${ROOT_ATTR}="message-command"]`)?.getAttribute("data-goal-objective") || "";
    divider.dataset.goalObjective = objective;
    if (divider.dataset.label !== "Goal Changed" || divider.dataset.layout !== "compact") {
      divider.dataset.label = "Goal Changed";
      divider.dataset.layout = "compact";
      divider.innerHTML = goalTimelineDividerHtml(rotateIconSvg(), "Goal Changed");
    }
    valid.add(divider);
  }
  document.querySelectorAll(`[${ROOT_ATTR}="changed-divider"][data-goal-source="transcript"]`).forEach((divider) => {
    if (!valid.has(divider)) divider.remove();
  });
}

function findGoalMessageTurns(root = findConversationContainer()) {
  if (!root?.querySelectorAll) return [];
  const seen = new Set();
  return Array.from(root.querySelectorAll(`[${ROOT_ATTR}="message-command"]`))
    .map((node) => node.closest("[data-turn-key], article, [data-message-author-role]"))
    .filter((turn) => {
      if (!(turn instanceof HTMLElement) || seen.has(turn) || !visible(turn)) return false;
      seen.add(turn);
      return true;
    })
    .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
}

function findGoalCompletionCandidateTurns(root = document) {
  const seen = new Set();
  const selectors = [
    "[data-turn-key]",
    "article",
    "[data-message-author-role]",
  ];
  const turns = [];
  for (const selector of selectors) {
    root.querySelectorAll?.(selector).forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      if (seen.has(node)) return;
      if (node.closest(`[${ROOT_ATTR}="achieved-divider"]`)) return;
      if (!visible(node)) return;
      seen.add(node);
      turns.push(node);
    });
  }
  return turns;
}

function parseGoalCompletionText(text) {
  const match = String(text || "").match(/goal complete\b[\s\S]*?(?:time used|final time used|elapsed time|final elapsed time):\s*([^.\n]+)/i);
  if (!match) return null;
  return { label: formatGoalCompletionDuration(match[1]) };
}

function formatGoalCompletionDuration(text) {
  const normalized = normalize(text);
  const hours = Number(normalized.match(/(\d+)\s*h(?:our)?s?/)?.[1] || 0);
  const minutes = Number(normalized.match(/(\d+)\s*m(?:in(?:ute)?)?s?/)?.[1] || 0);
  const seconds = Number(normalized.match(/(\d+)\s*s(?:ec(?:ond)?)?s?/)?.[1] || 0);
  const total = (hours * 3600) + (minutes * 60) + seconds;
  if (total > 0 || /\b0\s*(?:s|sec|second)/.test(normalized)) return formatDuration(total);
  return String(text || "").trim();
}

function placeGoalTimelineDivider(divider, goal, conversation) {
  const anchor = findGoalCompletionTurn(goal, conversation);
  if (anchor?.parentElement) {
    if (divider.parentElement !== anchor.parentElement || divider.previousElementSibling !== anchor) {
      anchor.insertAdjacentElement("afterend", divider);
    }
    return;
  }
  if (divider.parentElement !== conversation) conversation.append(divider);
}

function findGoalCompletionTurn(goal, conversation = findConversationContainer()) {
  if (!conversation?.querySelectorAll) return null;
  const objective = normalize(goal?.objective || "");
  const turnSelector = [
    "[data-turn-key]",
    "article",
    "[data-message-author-role]",
  ].join(",");
  const turns = Array.from(conversation.querySelectorAll(turnSelector))
    .filter((node) => node instanceof HTMLElement && !node.closest(`[${ROOT_ATTR}="achieved-divider"]`));
  let fallback = null;
  for (const turn of turns) {
    const text = normalize(turn.textContent || "");
    if (!text) continue;
    const mentionsGoal = !objective || text.includes(objective) || text.includes("goal complete") || text.includes("goal achieved");
    if (!mentionsGoal) continue;
    if (text.includes("goal complete") || text.includes("goal achieved")) return turn;
    if (!fallback && text.includes("time used")) fallback = turn;
  }
  return fallback;
}

function scrollToGoalMessage(goal) {
  const message = findGoalMessageElement(goal);
  if (!message) return false;
  message.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

function findGoalMessageElement(goal) {
  const objective = normalize(goal.objective);
  const conversation = findConversationContainer() || document.body;
  const rendered = Array.from(conversation.querySelectorAll(`[${ROOT_ATTR}="message-command"]`))
    .find((node) => normalize(node.getAttribute("data-goal-objective") || "") === objective);
  if (rendered instanceof HTMLElement) {
    return rendered.closest("[data-turn-key], article, [data-message-author-role]") ||
      rendered.closest("div") ||
      rendered;
  }
  const needle = normalize(`/goal ${goal.objective}`);
  const walker = document.createTreeWalker(conversation, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!normalize(node.nodeValue || "").includes(needle)) continue;
    const element = node.parentElement;
    return element?.closest?.("[data-turn-key], article, [data-message-author-role]") ||
      element?.closest?.("div") ||
      element;
  }
  const objectiveOnly = findUserGoalObjectiveTextElement(conversation, objective);
  if (objectiveOnly instanceof HTMLElement) {
    return objectiveOnly.closest("[data-turn-key], article, [data-message-author-role]") ||
      objectiveOnly.closest("div") ||
      objectiveOnly;
  }
  return null;
}

function findUserGoalObjectiveTextElement(scope, objective) {
  if (!scope?.querySelectorAll || !objective) return null;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest(`[${ROOT_ATTR}]`)) continue;
    if (normalize(node.nodeValue || "") !== objective) continue;
    if (!isUserMessageTextElement(parent)) continue;
    return parent;
  }
  return null;
}

function isUserMessageTextElement(element) {
  const unit = element.closest?.("[data-content-search-unit-key]");
  if (unit instanceof HTMLElement && /:user$/.test(unit.getAttribute("data-content-search-unit-key") || "")) return true;
  if (unit instanceof HTMLElement) return false;
  const bubble = element.closest?.("div");
  for (let node = bubble; node instanceof HTMLElement; node = node.parentElement) {
    const className = String(node.className || "");
    if (className.includes("items-end")) return true;
    if (node.hasAttribute("data-turn-key") || node.hasAttribute("data-message-author-role")) return false;
  }
  return false;
}

function findGoalFooterSlot() {
  const footers = Array.from(document.querySelectorAll(".composer-footer"))
    .filter((node) => node instanceof HTMLElement && visible(node));
  const footer = footers.find((node) =>
    node.className.includes("grid") &&
    node.children.length >= 3 &&
    normalize(node.textContent || "").match(/auto-review|5\.5|gpt|high|medium|low|model/)
  ) || footers.find((node) => node.className.includes("grid") && node.children.length >= 3);
  if (!footer) return null;
  let slot = footer.children[1];
  if (!(slot instanceof HTMLElement)) {
    slot = document.createElement("div");
    footer.insertBefore(slot, footer.children[1] || footer.lastChild);
  }
  slot.setAttribute(ROOT_ATTR, "slot");
  return slot;
}

function isGoalCommandText(text) {
  return /^\/goal(?:\s|$)/i.test(String(text || "").trim());
}

function getGoalComposerPayload(input) {
  const text = getComposerText(input);
  if (isGoalCommandText(text)) return { commandText: text, source: "text" };
  if (!(input instanceof HTMLElement)) return null;
  const mention = input.querySelector?.(GOAL_MENTION_SELECTOR);
  if (!mention) return null;
  const objective = getTextWithoutGoalMention(input);
  return { commandText: `/goal ${objective}`.trim(), source: "mention" };
}

function getTextWithoutGoalMention(input) {
  const clone = input.cloneNode(true);
  clone.querySelectorAll?.(GOAL_MENTION_SELECTOR).forEach((node) => node.remove());
  return String(clone.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function runGoalCommand(state, rawText, input) {
  const parsed = parseGoalCommand(rawText);
  if (!parsed.ok) {
    showToast(parsed.error || "Invalid /goal command.");
    return;
  }
  const threadId = await resolveThreadId(state, { resolveThread: true });
  if (!threadId) {
    if (parsed.action === "set") {
      await createGoalConversation(state, parsed.objective, input);
      return;
    }
    if (parsed.action === "clear") {
      state.pendingGoal = null;
      state.goal = null;
      renderGoalSurface(state);
      clearComposer(input);
      return;
    }
    showToast("Start a goal by adding an objective after Goal.");
    return;
  }

  try {
    if (parsed.action === "show") {
      await refreshGoal(state);
      renderGoalSurface(state);
      showGoalSummary(state);
      clearComposer(input);
      return;
    }
    if (parsed.action === "clear") {
      await clearGoal(state);
      state.goalSummary = null;
      removeGoalSummaryPanel();
      clearComposer(input);
      return;
    }
    if (parsed.action === "pause" || parsed.action === "resume" || parsed.action === "complete") {
      const status = parsed.action === "pause" ? "paused" : parsed.action === "resume" ? "active" : "complete";
      await setGoalStatus(state, status);
      if (state.goalSummary) showGoalSummary(state);
      clearComposer(input);
      return;
    }
    const current = state.goal || normalizeGoal((await state.api.ipc.invoke(IPC_GET, { threadId }))?.goal);
    if (current) {
      await confirmReplaceGoal(state, current, parsed.objective, async () => {
        await setGoal(state, parsed.objective, { replace: true });
        markGoalChanged(state, parsed.objective, rawText);
        renderGoalChangeDivider(state);
        window.setTimeout(() => submitGoalComposerNatively(state, input, rawText), 0);
      });
      return;
    }
    try {
      await setGoal(state, parsed.objective, { replace: false });
      window.setTimeout(() => submitGoalComposerNatively(state, input, rawText), 0);
    } catch (error) {
      if (isGoalExistsError(error)) {
        const existing = normalizeGoal(error.goal) || current;
        if (existing) {
          await confirmReplaceGoal(state, existing, parsed.objective, async () => {
            await setGoal(state, parsed.objective, { replace: true });
            markGoalChanged(state, parsed.objective, rawText);
            renderGoalChangeDivider(state);
            window.setTimeout(() => submitGoalComposerNatively(state, input, rawText), 0);
          });
          return;
        }
      }
      throw error;
    }
  } catch (error) {
    state.api.log.warn("[goal] command failed", error);
    showToast(error?.message || "Goal command failed.");
  }
}

function allowNextNativeGoalSubmit(state, commandText) {
  const text = normalizeCommandText(commandText);
  const previous = state.nativeGoalPassthrough;
  if (previous?.timer) window.clearTimeout(previous.timer);
  const pass = {
    commandText: text,
    expiresAtMs: Date.now() + 3000,
    timer: null,
  };
  pass.timer = window.setTimeout(() => {
    if (state.nativeGoalPassthrough === pass) state.nativeGoalPassthrough = null;
  }, 3000);
  state.nativeGoalPassthrough = pass;
}

function shouldAllowNativeGoalSubmit(state, commandText) {
  const pass = state.nativeGoalPassthrough;
  if (!pass) return false;
  if (Date.now() > pass.expiresAtMs) {
    state.nativeGoalPassthrough = null;
    return false;
  }
  return pass.commandText === normalizeCommandText(commandText);
}

function submitGoalComposerNatively(state, input, commandText) {
  if (!input) return false;
  const text = normalizeCommandText(commandText);
  allowNextNativeGoalSubmit(state, text);
  if (normalizeCommandText(getComposerText(input)) !== text) setComposerText(input, text);
  const form = input.closest?.("form");
  const sendButton = findComposerSendButton();
  if (sendButton instanceof HTMLElement && visible(sendButton)) {
    sendButton.click();
    return true;
  }
  if (form && typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return true;
  }
  input.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  }));
  return true;
}

function normalizeCommandText(text) {
  return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function markGoalChanged(state, objective, commandText) {
  state.goalChange = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    threadId: state.goal?.threadId || state.threadId || "",
    objective: String(objective || "").trim(),
    commandText: normalizeCommandText(commandText),
    createdAtMs: Date.now(),
  };
}

function parseGoalCommand(text) {
  const rest = String(text || "").trim().replace(/^\/goal\b/i, "").trim();
  if (!rest) return { ok: true, action: "show" };
  const lower = rest.toLowerCase();
  if (lower === "clear" || lower === "cancel" || lower === "abandon") {
    return { ok: true, action: "clear" };
  }
  if (lower === "pause") return { ok: true, action: "pause" };
  if (lower === "resume") return { ok: true, action: "resume" };
  if (lower === "complete" || lower === "done" || lower === "achieved") {
    return { ok: true, action: "complete" };
  }
  return { ok: true, action: "set", objective: rest };
}

async function createGoalConversation(state, objective, input) {
  try {
    const navigateAfterCreate = findOnLocalConversationCreated(state.api);
    const result = await createGoalThreadRecord(state, {
      objective,
      ...findComposerThreadContext(state.api, input),
    });
    const threadId = String(result?.thread?.id || "").trim();
    if (!UUID_RE.test(threadId)) throw new Error("Goal thread was not created.");
    state.pendingGoal = null;
    state.threadId = threadId;
    state.goal = normalizeGoal(result?.goal);
    clearComposer(input);
    renderGoalSurface(state);
    void refreshSidebarGoalIndicators(state, { force: true });
    const navigated = await navigateToLocalThread(state.api, threadId, navigateAfterCreate);
    if (!navigated) showToast("Goal started. Open the new Set goal chat from the sidebar.");
    window.setTimeout(() => {
      void refreshGoal(state, { resolveThread: true });
    }, 350);
  } catch (error) {
    state.api.log.warn("[goal] failed to create goal conversation", error);
    showToast(error?.message || "Goal command failed.");
  }
}

function installNativeGoalThreadCapture(state, pending) {
  const slot = findOnLocalConversationCreatedSlot(state.api);
  if (!slot || slot.props.__codexppGoalWrappedCreate === pending) return;
  const original = slot.props.onLocalConversationCreated;
  const wrapped = async (...args) => {
    const threadId = String(args[0] || "").match(UUID_RE)?.[0] || "";
    if (threadId) {
      await attachGoalToThread(state, pending, threadId);
    }
    return original.apply(this, args);
  };
  try {
    slot.props.onLocalConversationCreated = wrapped;
    slot.props.__codexppGoalWrappedCreate = pending;
    window.setTimeout(() => {
      if (slot.props.onLocalConversationCreated === wrapped) {
        slot.props.onLocalConversationCreated = original;
        delete slot.props.__codexppGoalWrappedCreate;
      }
    }, 15000);
  } catch (error) {
    state.api.log.warn("[goal] failed to wrap native thread creation", error);
  }
}

async function waitForNativeGoalThread(state, pending) {
  for (let i = 0; i < 120; i += 1) {
    if (state.disposed || pending.done || state.nativeGoalSubmit !== pending) return;
    const threadId = findThreadId(state.api);
    if (threadId && await attachGoalToThread(state, pending, threadId)) return;
    await delay(100);
  }
  if (state.nativeGoalSubmit === pending) state.nativeGoalSubmit = null;
  if (state.pendingGoal?.objective === pending.objective) state.pendingGoal = null;
}

async function attachGoalToThread(state, pending, threadId) {
  if (pending.done || !UUID_RE.test(threadId)) return false;
  try {
    const result = await state.api.ipc.invoke(IPC_SET, {
      threadId,
      objective: pending.objective,
      replace: false,
      minCreatedAtMs: pending.startedAtMs - 1000,
    });
    pending.done = true;
    if (state.nativeGoalSubmit === pending) state.nativeGoalSubmit = null;
    state.pendingGoal = null;
    state.threadId = threadId;
    state.goal = normalizeGoal(result?.goal);
    renderGoalSurface(state);
    void refreshSidebarGoalIndicators(state, { force: true });
    return true;
  } catch (error) {
    if (isGoalExistsError(error)) {
      const result = await state.api.ipc.invoke(IPC_GET, { threadId });
      pending.done = true;
      if (state.nativeGoalSubmit === pending) state.nativeGoalSubmit = null;
      state.pendingGoal = null;
      state.threadId = threadId;
      state.goal = normalizeGoal(result?.goal);
      renderGoalSurface(state);
      void refreshSidebarGoalIndicators(state, { force: true });
      return true;
    }
    const message = String(error?.message || "");
    if (message.includes("THREAD_TOO_OLD_FOR_PENDING_GOAL") || message.includes("Thread was created before this pending goal")) {
      return false;
    }
    if (message.includes("Thread not found")) return false;
    state.api.log.warn("[goal] failed to attach goal to native thread", error);
    return false;
  }
}

async function createGoalThreadRecord(state, payload) {
  try {
    return await state.api.ipc.invoke(IPC_CREATE_THREAD, payload);
  } catch (error) {
    if (!String(error?.message || "").includes("No handler registered")) throw error;
    const db = openGoalDb();
    const objective = String(payload?.objective || "").trim();
    const context = normalizeThreadCreateContext(payload, db);
    const created = createGoalThread(db, context, objective);
    return {
      thread: {
        id: created.threadId,
        rolloutPath: created.rolloutPath,
      },
      goal: getGoalRow(db, created.threadId),
    };
  }
}

function findComposerThreadContext(api, input) {
  const context = {
    workspaceLabel: findVisibleWorkspaceLabel(),
  };
  const fiber = findComposerFiber(api, input);
  const seen = new WeakSet();
  for (let node = fiber, i = 0; node && i < 80; i += 1, node = node.return) {
    collectThreadContext(context, node.memoizedProps, seen);
    collectThreadContext(context, node.pendingProps, seen);
    if (context.cwd && context.model && context.reasoningEffort) break;
  }
  return context;
}

function findVisibleWorkspaceLabel() {
  const main = document.querySelector("[data-app-shell-main-content-layout]") || document.body;
  const text = String(main?.textContent || "");
  const match = text.match(/What should we work on in ([^?]+)\?/i);
  return match?.[1]?.trim() || "";
}

function findComposerFiber(api, input) {
  const node = findComposerSendButton() || input || findComposerInput();
  if (!node) return null;
  return getReactFiber(api, node);
}

function getReactFiber(api, node) {
  try {
    if (typeof api.react?.getFiber === "function") return api.react.getFiber(node);
  } catch {}
  const key = Object.keys(node).find((name) => name.startsWith("__reactFiber$"));
  return key ? node[key] : null;
}

function collectThreadContext(context, value, seen, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (child == null) continue;
    if (!context.cwd && key === "executionTargetCwd" && typeof child === "string") context.cwd = child;
    if (!context.model && key === "model" && typeof child === "string") context.model = child;
    if (!context.reasoningEffort && key === "reasoningEffort" && typeof child === "string") context.reasoningEffort = child;
    if (!context.modelProvider && key === "modelProvider" && typeof child === "string") context.modelProvider = child;
    if (!context.approvalMode && (key === "approvalMode" || key === "approvalPolicy") && typeof child === "string") {
      context.approvalMode = child;
    }
    if (!context.sandboxPolicy && key === "sandboxPolicy") {
      context.sandboxPolicy = child;
    }
  }
  for (const [, child] of Object.entries(value)) {
    if (child && typeof child === "object") collectThreadContext(context, child, seen, depth + 1);
  }
}

async function navigateToLocalThread(api, threadId, callback = null) {
  callback ||= findOnLocalConversationCreated(api);
  if (callback) {
    try {
      await callback(threadId);
      await delay(300);
      if (findActiveSidebarThreadId() === `local:${threadId}`) return true;
    } catch (error) {
      api.log.warn("[goal] onLocalConversationCreated failed", error);
    }
  }
  for (let i = 0; i < 100; i += 1) {
    const row = document.querySelector(`[data-app-action-sidebar-thread-id="local:${CSS.escape(threadId)}"]`);
    if (row instanceof HTMLElement) {
      row.click();
      if (callback) {
        try {
          await callback(threadId);
        } catch (error) {
          api.log.warn("[goal] delayed onLocalConversationCreated failed", error);
        }
      }
      return true;
    }
    await delay(100);
  }
  return false;
}

function findActiveSidebarThreadId() {
  return document
    .querySelector('[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]')
    ?.getAttribute("data-app-action-sidebar-thread-id") || "";
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function findOnLocalConversationCreated(api) {
  return findOnLocalConversationCreatedSlot(api)?.props?.onLocalConversationCreated || null;
}

function findOnLocalConversationCreatedSlot(api) {
  const fiber = findComposerFiber(api);
  for (let node = fiber, i = 0; node && i < 80; i += 1, node = node.return) {
    const props = node.memoizedProps || node.pendingProps;
    if (typeof props?.onLocalConversationCreated === "function") return { props };
  }
  return null;
}

async function setGoal(state, objective, options) {
  const threadId = await resolveThreadId(state, { resolveThread: true });
  const result = await state.api.ipc.invoke(IPC_SET, {
    threadId,
    objective,
    replace: Boolean(options?.replace),
    minCreatedAtMs: options?.minCreatedAtMs,
  });
  state.goal = normalizeGoal(result?.goal);
  state.pendingGoal = null;
  renderGoalSurface(state);
  void refreshSidebarGoalIndicators(state, { force: true });
}

function isGoalExistsError(error) {
  const message = String(error?.message || "");
  return error?.code === "GOAL_EXISTS" ||
    Boolean(error?.goal) ||
    message.includes("GOAL_EXISTS") ||
    /goal already exists|already has .*goal|already active/i.test(message);
}

async function setGoalStatus(state, status) {
  const threadId = await resolveThreadId(state, { resolveThread: true });
  if (!threadId) return;
  const result = await state.api.ipc.invoke(IPC_STATUS, { threadId, status });
  state.goal = normalizeGoal(result?.goal);
  renderGoalSurface(state);
  void refreshSidebarGoalIndicators(state, { force: true });
}

async function clearGoal(state) {
  const threadId = await resolveThreadId(state, { resolveThread: true });
  if (!threadId) return;
  await state.api.ipc.invoke(IPC_CLEAR, { threadId });
  state.pendingGoal = null;
  state.goal = null;
  renderGoalSurface(state);
  void refreshSidebarGoalIndicators(state, { force: true });
}

function confirmReplaceGoal(state, current, nextObjective, onReplace) {
  return new Promise((resolve) => {
    state.modal?.remove();
    const backdrop = document.createElement("div");
    backdrop.setAttribute(ROOT_ATTR, "modal-backdrop");
    const modal = document.createElement("div");
    modal.setAttribute(ROOT_ATTR, "modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "codexpp-goal-replace-title");
    modal.setAttribute("aria-describedby", "codexpp-goal-replace-description");
    modal.tabIndex = -1;
    modal.className = "codex-dialog z-50 outline-none bg-token-dropdown-background/90 text-token-foreground ring-token-border max-w-[92vw] rounded-3xl ring-[0.5px] ring-token-border shadow-lg backdrop-blur-xl w-[420px]";
    modal.innerHTML =
      '<div>' +
      '<form class="flex flex-col gap-0 px-5 py-5 text-base leading-normal tracking-normal">' +
      '<div class="flex w-full flex-col pt-3 first:pt-0">' +
      '<div class="flex flex-col items-start gap-3">' +
      '<div class="flex min-w-0 flex-1 flex-col gap-1 self-stretch">' +
      `<div id="codexpp-goal-replace-title" class="heading-dialog min-w-0 font-semibold" ${ROOT_ATTR}="modal-title">Replace goal</div>` +
      `<div id="codexpp-goal-replace-description" class="text-token-description-foreground text-base leading-normal tracking-normal" ${ROOT_ATTR}="modal-copy">${escapeHtml(replaceGoalCopy(current, nextObjective))}</div>` +
      "</div>" +
      "</div>" +
      "</div>" +
      `<div class="flex w-full flex-col pt-3 first:pt-0"><div class="flex w-full items-center justify-end gap-3" ${ROOT_ATTR}="modal-actions"></div></div>` +
      "</form>" +
      "</div>";
    const actions = modal.querySelector(`[${ROOT_ATTR}="modal-actions"]`);
    const cancel = modalButton("Cancel", false, () => done(false));
    const replace = modalButton("Replace goal", true, async () => {
      await onReplace();
      done(true);
    });
    actions.append(cancel, replace);
    modal.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      replace.click();
    });
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute(ROOT_ATTR, "modal-close");
    close.setAttribute("aria-label", "Close");
    close.className = "no-drag absolute top-4 right-4 cursor-interaction rounded p-1 leading-none text-token-foreground/80 hover:bg-token-toolbar-hover-background focus:ring-1 focus:ring-token-focus-border focus:outline-none";
    close.innerHTML = closeIconSvg();
    close.addEventListener("click", (event) => {
      event.preventDefault();
      done(false);
    });
    modal.append(close);
    backdrop.append(modal);
    state.modal = backdrop;
    document.body.append(backdrop);
    window.setTimeout(() => modal.focus(), 0);
    let settled = false;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      done(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    function done(value) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      backdrop.remove();
      if (state.modal === backdrop) state.modal = null;
      resolve(value);
    }
  });
}

function replaceGoalCopy(current, nextObjective) {
  const objective = current?.objective || "the current goal";
  const next = nextObjective || "the new goal";
  if (current?.status === "complete") {
    return `This thread already has a completed goal: "${objective}". Replace it with "${next}"?`;
  }
  if (current?.status === "paused") {
    return `This thread already has a paused goal: "${objective}". Replace it with "${next}"?`;
  }
  if (current?.status === "budget_limited") {
    return `This thread already has a budget-limited goal: "${objective}". Replace it with "${next}"?`;
  }
  return `This thread is already pursuing "${objective}". Replace it with "${next}"?`;
}

function modalButton(label, primary, onClick) {
  const button = document.createElement("button");
  button.type = primary ? "submit" : "button";
  button.setAttribute(ROOT_ATTR, "modal-button");
  if (primary) button.dataset.primary = "true";
  button.className = primary
    ? "border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg bg-token-foreground enabled:hover:bg-token-foreground/80 data-[state=open]:bg-token-foreground/80 text-token-dropdown-background px-4 py-1.5 text-base leading-[18px]"
    : "border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg border-token-border text-token-button-tertiary-foreground bg-token-bg-fog enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border px-4 py-1.5 text-base leading-[18px]";
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    void onClick();
  });
  return button;
}

function normalizeGoal(goal) {
  if (!goal) return null;
  return {
    threadId: String(goal.threadId || ""),
    goalId: String(goal.goalId || ""),
    objective: String(goal.objective || ""),
    status: GOAL_STATUSES.has(goal.status) ? goal.status : "active",
    tokenBudget: goal.tokenBudget == null ? null : Number(goal.tokenBudget),
    tokensUsed: Number(goal.tokensUsed || 0),
    timeUsedSeconds: Number(goal.timeUsedSeconds || 0),
    createdAtMs: Number(goal.createdAtMs || 0),
    updatedAtMs: Number(goal.updatedAtMs || 0),
  };
}

function createPendingGoal(objective) {
  const now = Date.now();
  return {
    threadId: "",
    goalId: `pending-${now}`,
    objective: String(objective || "").trim(),
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function goalStatusLabel(goal) {
  if (goal.status === "complete") return "Goal achieved";
  if (goal.status === "paused") return `Goal paused (${formatDuration(goalDurationSeconds(goal))})`;
  if (goal.status === "budget_limited") return `Goal budget reached (${formatDuration(goalDurationSeconds(goal))})`;
  return `Pursuing goal (${formatDuration(goalDurationSeconds(goal))})`;
}

function goalDurationSeconds(goal) {
  const base = Math.max(0, Number(goal.timeUsedSeconds || 0));
  if (goal.status !== "active") return base;
  const updatedAt = Number(goal.updatedAtMs || goal.createdAtMs || 0);
  if (!updatedAt) return base;
  return base + Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function formatSidebarDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function formatTokenCount(value) {
  const tokens = Math.max(0, Math.floor(Number(value) || 0));
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${trimTrailingZero(millions.toFixed(millions >= 10 ? 0 : 1))}M`;
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000;
    return `${trimTrailingZero(thousands.toFixed(thousands >= 10 ? 1 : 1))}K`;
  }
  return String(tokens);
}

function trimTrailingZero(text) {
  return String(text).replace(/\\.0$/, "");
}

function findComposerInput(scope = document) {
  const root = scope instanceof Element ? scope : document;
  const nodes = Array.from(root.querySelectorAll?.([
    "textarea",
    "input[type='text']",
    "[contenteditable='true']",
    "[role='textbox']",
  ].join(",")) || []);
  const visibleNodes = nodes.filter((node) => node instanceof HTMLElement && visible(node));
  return visibleNodes.find((node) => {
    const label = normalize(`${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""}`);
    return label.includes("message") ||
      label.includes("prompt") ||
      label.includes("ask") ||
      node.closest("[data-testid*='composer' i]") ||
      node.closest("[class*='composer' i]") ||
      node.tagName === "TEXTAREA";
  }) || visibleNodes[0] || null;
}

function findComposerSendButton() {
  const buttons = Array.from(document.querySelectorAll("button"))
    .filter((node) => node instanceof HTMLElement && visible(node));
  return buttons.find((button) =>
    button.closest(".composer-footer") &&
    String(button.className || "").includes("bg-token-foreground")
  ) || buttons
    .filter((button) => button.closest(".composer-footer"))
    .sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x)[0] || null;
}

function getComposerText(input) {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) return input.value;
  return input.textContent || "";
}

function setComposerText(input, text) {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (input instanceof HTMLElement && input.isContentEditable) {
    input.focus();
    document.execCommand("selectAll", false);
    if (text) {
      document.execCommand("insertText", false, text);
    } else {
      document.execCommand("delete", false);
    }
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: text ? "insertText" : "deleteContentBackward", data: text || null }));
    return true;
  }
  return false;
}

function insertGoalMentionFromSlash(input) {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    return setComposerText(input, "/goal ");
  }
  if (!(input instanceof HTMLElement) || !input.isContentEditable) return false;
  input.focus();
  document.execCommand("selectAll", false);
  document.execCommand("insertHTML", false, createGoalMentionHtml());
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: "Goal " }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  window.setTimeout(() => patchGoalMentions(input), 0);
  window.setTimeout(() => patchGoalMentions(input), 100);
  return true;
}

function createGoalMentionHtml() {
  return (
    `<span class="${goalMentionClassName()}" ` +
    `skill-mention-name="${GOAL_MENTION_NAME}" ` +
    'skill-mention-display-name="Goal" ' +
    `skill-mention-path="${escapeHtml(goalMentionPath())}" ` +
    `skill-mention-icon="${escapeHtml(goalIconDataUrl())}" ` +
    'skill-mention-brand-color="" ' +
    'contenteditable="false">' +
    '<span class="inline-flex h-[1lh] shrink-0 self-start items-center">' +
    goalIconSvg() +
    "</span>" +
    '<span class="min-w-0 break-words">Goal</span>' +
    "</span> "
  );
}

function goalMentionPath() {
  try {
    return require("path").join(__dirname, "README.md");
  } catch {
    return "";
  }
}

function goalMentionClassName(options = {}) {
  const classes = [
    "inline-flex",
    "min-w-0",
    "items-baseline",
    "gap-1",
    "px-0.5",
    "inline-mention-brand-aware",
    "font-medium",
    "text-[color:var(--inline-mention-color)]",
    "[--inline-mention-color:var(--inline-mention-resolved-base-color,var(--inline-mention-base-color))]",
    "[--inline-mention-base-color:color-mix(in_srgb,var(--color-token-text-link-foreground)_80%,var(--color-token-foreground)_20%)]",
    "group-hover/inline-mention:underline",
    "group-hover/inline-mention:decoration-current",
    "group-hover/inline-mention:decoration-dashed",
    "group-hover/inline-mention:decoration-[0.5px]",
    "group-hover/inline-mention:underline-offset-2",
  ];
  if (options.interactive !== false) classes.push("cursor-interaction");
  return classes.join(" ");
}

function patchGoalMentions(root = document) {
  root.querySelectorAll?.(GOAL_MENTION_SELECTOR).forEach((mention) => {
    const iconSlot = mention.querySelector("span");
    if (!(iconSlot instanceof HTMLElement)) return;
    const currentSvg = iconSlot.querySelector("svg");
    if (currentSvg && currentSvg.getAttribute("data-codexpp-goal-icon") === "true") return;
    iconSlot.innerHTML = goalIconSvg({ marker: true });
  });
}

function patchGoalMessages(root = document, state = null) {
  const conversation = findConversationContainer();
  const scope = root instanceof Element && conversation?.contains(root) ? root : conversation;
  if (!scope?.querySelectorAll) return;
  const objectives = goalMessageObjectives(state);
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const replacements = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent) continue;
    if (parent.closest("[contenteditable='true'], textarea, [role='textbox'], script, style")) continue;
    if (parent.closest(`[${ROOT_ATTR}]`)) continue;
    const text = String(node.nodeValue || "");
    const match = text.match(/^(\s*)\/goal\s+(.+?)(\s*)$/i);
    const objective = match?.[2]?.trim() || findMatchingGoalObjective(text, objectives, parent);
    if (!objective) continue;
    replacements.push({ node, before: match?.[1] || "", objective, after: match?.[3] || "" });
  }
  for (const replacement of replacements) {
    const fragment = document.createDocumentFragment();
    if (replacement.before) fragment.append(document.createTextNode(replacement.before));
    fragment.append(createGoalMessageCommand(replacement.objective));
    if (replacement.after) fragment.append(document.createTextNode(replacement.after));
    replacement.node.replaceWith(fragment);
  }
  renderTranscriptGoalCompletionDividers();
}

function goalMessageObjectives(state) {
  const values = [
    state?.goal?.objective,
    state?.pendingGoal?.objective,
    state?.goalChange?.objective,
  ];
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function findMatchingGoalObjective(text, objectives, parent) {
  if (!objectives.length || !isUserMessageTextElement(parent)) return "";
  const normalized = normalize(text);
  const match = objectives.find((objective) => normalize(objective) === normalized);
  return match || "";
}

function createGoalMessageCommand(objective) {
  const command = document.createElement("span");
  command.setAttribute(ROOT_ATTR, "message-command");
  command.setAttribute("data-goal-objective", objective);
  command.title = `/goal ${objective}`;

  const mentionWrap = document.createElement("span");
  mentionWrap.className = "break-words whitespace-normal";

  const mention = document.createElement("span");
  mention.className = goalMentionClassName({ interactive: false });

  const iconSlot = document.createElement("span");
  iconSlot.className = "inline-flex h-[1lh] shrink-0 self-start items-center";
  iconSlot.innerHTML = goalIconSvg({ marker: true });

  const label = document.createElement("span");
  label.className = "min-w-0 break-words";
  label.textContent = "Goal";

  mention.append(iconSlot, label);
  mentionWrap.append(mention);

  const objectiveNode = document.createElement("span");
  objectiveNode.setAttribute(ROOT_ATTR, "message-objective");
  objectiveNode.textContent = objective;

  command.append(mentionWrap, document.createTextNode(" "), objectiveNode);
  return command;
}

function clearComposer(input) {
  if (input) setComposerText(input, "");
}

function visible(node) {
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showToast(message) {
  const node = document.createElement("div");
  node.textContent = message;
  node.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:24px",
    "z-index:2147483647",
    "transform:translateX(-50%)",
    "max-width:min(520px,calc(100vw - 32px))",
    "border:1px solid color-mix(in srgb,currentColor 14%,transparent)",
    "border-radius:8px",
    "background:var(--color-token-main-surface-primary,Canvas)",
    "color:var(--color-token-text-primary,CanvasText)",
    "box-shadow:0 12px 40px rgb(0 0 0 / 0.28)",
    "padding:8px 10px",
    "font:13px system-ui,sans-serif",
  ].join(";");
  document.body.append(node);
  window.setTimeout(() => node.remove(), 2600);
}

function goalIconSvg(options = {}) {
  const marker = options.marker ? ' data-codexpp-goal-icon="true"' : "";
  return (
    `<svg class="icon-xs shrink-0" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"${marker}>` +
    '<circle cx="10" cy="10" r="6.75" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="10" cy="10" r="2.25" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M10 3.25V1.75M10 18.25v-1.5M16.75 10h1.5M1.75 10h1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    "</svg>"
  );
}

function flagIconSvg() {
  return (
    '<svg class="icon-xs shrink-0" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M5.25 17V3.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M6 4.25 14.5 7.1 6 9.95V4.25Z" fill="currentColor"/>' +
    "</svg>"
  );
}

function rotateIconSvg() {
  return (
    '<svg class="icon-xs shrink-0" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M15.25 6.25A6 6 0 1 0 16 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M15.25 2.75v3.5h-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>"
  );
}

function closeIconSvg() {
  return (
    '<svg width="21" height="21" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs" aria-hidden="true">' +
    '<path d="M14.6549 5.57307C14.9283 5.2997 15.3718 5.2997 15.6451 5.57307C15.9185 5.84643 15.9185 6.28993 15.6451 6.5633L11.3903 10.8182L15.6451 15.0731L15.735 15.1834C15.9141 15.4551 15.8842 15.8242 15.6451 16.0633C15.4061 16.3024 15.0369 16.3322 14.7653 16.1531L14.6549 16.0633L10.4 11.8084L6.14515 16.0633C5.87178 16.3367 5.42828 16.3367 5.15492 16.0633C4.88155 15.7899 4.88155 15.3464 5.15492 15.0731L9.4098 10.8182L5.15492 6.5633L5.06507 6.45295C4.88597 6.18128 4.91584 5.81214 5.15492 5.57307C5.39399 5.33399 5.76313 5.30413 6.0348 5.48322L6.14515 5.57307L10.4 9.82795L14.6549 5.57307Z" fill="currentColor"></path>' +
    "</svg>"
  );
}

function goalIconDataUrl() {
  const svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none">' +
    '<circle cx="10" cy="10" r="6.75" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="10" cy="10" r="2.25" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M10 3.25V1.75M10 18.25v-1.5M16.75 10h1.5M1.75 10h1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    "</svg>"
  );
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

module.exports._internals = {
  parseGoalCommand,
  formatDuration,
  formatSidebarDuration,
  formatTokenCount,
  normalizeGoal,
  goalStatusLabel,
  goalDurationSeconds,
  parseGoalCompletionText,
  replaceGoalCopy,
  isGoalExistsError,
  resolveThreadIdFromTurnIds,
  positiveIntegerOrNull,
};
