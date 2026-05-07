const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { _internals } = require("../index.js");

test("parseGoalCommand parses display and lifecycle commands", () => {
  assert.deepEqual(_internals.parseGoalCommand("/goal"), { ok: true, action: "show" });
  assert.deepEqual(_internals.parseGoalCommand("/goal pause"), { ok: true, action: "pause" });
  assert.deepEqual(_internals.parseGoalCommand("/goal resume"), { ok: true, action: "resume" });
  assert.deepEqual(_internals.parseGoalCommand("/goal clear"), { ok: true, action: "clear" });
  assert.deepEqual(_internals.parseGoalCommand("/goal achieved"), { ok: true, action: "complete" });
});

test("parseGoalCommand treats other text as the objective", () => {
  assert.deepEqual(_internals.parseGoalCommand("/goal improve benchmark coverage"), {
    ok: true,
    action: "set",
    objective: "improve benchmark coverage",
  });
});

test("formatDuration uses compact time labels", () => {
  assert.equal(_internals.formatDuration(0), "0s");
  assert.equal(_internals.formatDuration(7), "7s");
  assert.equal(_internals.formatDuration(67), "1m 07s");
  assert.equal(_internals.formatDuration(3667), "1h 01m");
});

test("formatSidebarDuration keeps sidebar goal timers terse", () => {
  assert.equal(_internals.formatSidebarDuration(32), "32s");
  assert.equal(_internals.formatSidebarDuration(932), "15m");
  assert.equal(_internals.formatSidebarDuration(3667), "1h");
});

test("formatTokenCount uses compact token labels", () => {
  assert.equal(_internals.formatTokenCount(0), "0");
  assert.equal(_internals.formatTokenCount(17600), "17.6K");
  assert.equal(_internals.formatTokenCount(1200000), "1.2M");
});

test("goalStatusLabel renders requested status text", () => {
  assert.equal(
    _internals.goalStatusLabel({
      status: "active",
      timeUsedSeconds: 67,
      updatedAtMs: Date.now(),
      createdAtMs: Date.now(),
      objective: "ship it",
    }),
    "Pursuing goal (1m 07s)",
  );
  assert.equal(
    _internals.goalStatusLabel({ status: "complete", timeUsedSeconds: 67, objective: "ship it" }),
    "Goal achieved",
  );
});

test("completed goal replacement copy asks to replace the existing goal", () => {
  assert.equal(
    _internals.replaceGoalCopy(
      { status: "complete", objective: "count to 10" },
      "count from -5 to 5",
    ),
    'This thread already has a completed goal: "count to 10". Replace it with "count from -5 to 5"?',
  );
});

test("goal completion transcript text parses compact duration", () => {
  assert.deepEqual(
    _internals.parseGoalCompletionText("Goal complete. Time used: 2 seconds."),
    { label: "2s" },
  );
});

test("goal exists detection survives IPC error serialization", () => {
  assert.equal(_internals.isGoalExistsError(new Error("GOAL_EXISTS: A goal already exists for this thread.")), true);
  assert.equal(_internals.isGoalExistsError(new Error("Could not find the current thread id.")), false);
});

test("resolveThreadIdFromTurnIds maps visible turn ids back to a thread rollout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexpp-goal-"));
  const rolloutPath = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(
    rolloutPath,
    '{"type":"event_msg","payload":{"turn_id":"019e01af-8d69-72d1-97f2-8f78bb9aecf4"}}\n',
    "utf8",
  );
  const db = {
    prepare() {
      return {
        all() {
          return [{ id: "019e01af-7b59-7673-b3d7-28657eaf90e0", rolloutPath }];
        },
      };
    },
  };
  assert.equal(
    _internals.resolveThreadIdFromTurnIds(db, ["019e01af-8d69-72d1-97f2-8f78bb9aecf4"]),
    "019e01af-7b59-7673-b3d7-28657eaf90e0",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
