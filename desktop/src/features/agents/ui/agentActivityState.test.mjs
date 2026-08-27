import assert from "node:assert/strict";
import test from "node:test";

import {
  activityStateForItem,
  activityStateForItems,
  isNotableActivityState,
  toolRunState,
} from "./agentActivityState.ts";

const timestamp = "2026-06-14T19:00:00.000Z";

function makeTool(overrides = {}) {
  return {
    id: "tool:1",
    type: "tool",
    renderClass: "shell",
    title: "Ran command",
    toolName: "buzz_dev_mcp__shell",
    buzzToolName: null,
    status: "completed",
    args: {},
    result: "",
    isError: false,
    timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    descriptor: {
      renderClass: "shell",
      label: "Ran command",
      preview: null,
    },
    ...overrides,
  };
}

test("toolRunState maps each wire status", () => {
  assert.equal(toolRunState(makeTool({ status: "completed" })), "done");
  assert.equal(toolRunState(makeTool({ status: "executing" })), "running");
  assert.equal(toolRunState(makeTool({ status: "pending" })), "queued");
  assert.equal(toolRunState(makeTool({ status: "failed" })), "failed");
});

test("toolRunState treats an error payload on a completed call as failed", () => {
  assert.equal(
    toolRunState(makeTool({ status: "completed", isError: true })),
    "failed",
  );
});

test("activityStateForItem reads tone from the classifier descriptor", () => {
  const edited = makeTool({
    descriptor: {
      renderClass: "file-edit",
      label: "Edited file",
      preview: null,
      tone: "write",
    },
  });
  assert.deepEqual(activityStateForItem(edited), {
    state: "done",
    tone: "write",
  });
});

test("activityStateForItem stays neutral when the descriptor has no tone", () => {
  assert.deepEqual(activityStateForItem(makeTool()), {
    state: "done",
    tone: "neutral",
  });
});

test("activityStateForItem treats non-tool rows as finished neutral steps", () => {
  assert.deepEqual(
    activityStateForItem({
      id: "thought:1",
      type: "thought",
      renderClass: "thought",
      title: "Thinking",
      text: "…",
      timestamp,
    }),
    { state: "done", tone: "neutral" },
  );
});

test("activityStateForItems surfaces a failure hidden inside a collapsed run", () => {
  const state = activityStateForItems([
    makeTool({ id: "a" }),
    makeTool({ id: "b", status: "failed" }),
    makeTool({ id: "c" }),
  ]);
  assert.equal(state.state, "failed");
});

test("activityStateForItems surfaces an in-flight child over finished ones", () => {
  const state = activityStateForItems([
    makeTool({ id: "a" }),
    makeTool({ id: "b", status: "executing" }),
  ]);
  assert.equal(state.state, "running");
});

test("activityStateForItems keeps the strongest tone in the run", () => {
  const read = {
    renderClass: "file-read",
    label: "Read file",
    preview: null,
    tone: "read",
  };
  const write = {
    renderClass: "file-edit",
    label: "Edited file",
    preview: null,
    tone: "write",
  };
  const state = activityStateForItems([
    makeTool({ id: "a", descriptor: read }),
    makeTool({ id: "b", descriptor: write }),
    makeTool({ id: "c", descriptor: read }),
  ]);
  assert.equal(state.tone, "write");
});

test("activityStateForItems is done+neutral for an empty run", () => {
  assert.deepEqual(activityStateForItems([]), {
    state: "done",
    tone: "neutral",
  });
});

test("isNotableActivityState is false only for a finished read", () => {
  assert.equal(isNotableActivityState({ state: "done", tone: "read" }), false);
  assert.equal(
    isNotableActivityState({ state: "done", tone: "neutral" }),
    false,
  );
  assert.equal(isNotableActivityState({ state: "done", tone: "write" }), true);
  assert.equal(isNotableActivityState({ state: "failed", tone: "read" }), true);
  assert.equal(
    isNotableActivityState({ state: "running", tone: "neutral" }),
    true,
  );
});
