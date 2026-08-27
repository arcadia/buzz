import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveTranscriptTurnState,
  hasPendingApproval,
  isUnresolvedPermission,
} from "./agentSessionTurnState.ts";

const timestamp = "2026-06-14T19:00:00.000Z";

function permission(overrides = {}) {
  return {
    id: "permission:1",
    type: "lifecycle",
    renderClass: "permission",
    title: "Permission requested",
    text: "Options: Allow once, Deny",
    timestamp,
    turnId: "turn-1",
    ...overrides,
  };
}

function tool(overrides = {}) {
  return {
    id: "tool:1",
    type: "tool",
    renderClass: "shell",
    title: "Ran command",
    toolName: "shell",
    buzzToolName: null,
    status: "completed",
    args: {},
    result: "",
    isError: false,
    timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    turnId: "turn-1",
    ...overrides,
  };
}

test("isUnresolvedPermission only matches permissions without an outcome", () => {
  assert.equal(isUnresolvedPermission(permission()), true);
  assert.equal(
    isUnresolvedPermission(permission({ outcome: "Approved (allow_once)" })),
    false,
  );
  assert.equal(isUnresolvedPermission(tool()), false);
});

test("hasPendingApproval is true while the current turn owes an answer", () => {
  assert.equal(hasPendingApproval([tool(), permission()]), true);
});

test("hasPendingApproval survives status frames landing after the request", () => {
  const usage = {
    id: "usage:1",
    type: "lifecycle",
    renderClass: "status",
    title: "Usage",
    text: "Tokens: 10/100",
    timestamp,
    turnId: "turn-1",
  };
  assert.equal(hasPendingApproval([permission(), usage]), true);
});

test("hasPendingApproval is false once the permission resolves", () => {
  assert.equal(
    hasPendingApproval([
      tool(),
      permission({ outcome: "Approved (allow_once)" }),
    ]),
    false,
  );
});

test("hasPendingApproval ignores an unanswered request from an older turn", () => {
  assert.equal(
    hasPendingApproval([
      permission({ id: "permission:old", turnId: "turn-0" }),
      tool({ id: "tool:new", turnId: "turn-1" }),
    ]),
    false,
  );
});

test("hasPendingApproval falls back to the newest permission without turn ids", () => {
  assert.equal(
    hasPendingApproval([
      permission({ id: "p1", turnId: null, outcome: "Denied (reject_once)" }),
      permission({ id: "p2", turnId: null }),
      tool({ turnId: null }),
    ]),
    true,
  );
  assert.equal(
    hasPendingApproval([
      permission({ id: "p1", turnId: null }),
      permission({ id: "p2", turnId: null, outcome: "Approved (allow_once)" }),
      tool({ turnId: null }),
    ]),
    false,
  );
});

test("hasPendingApproval is false for an empty transcript", () => {
  assert.equal(hasPendingApproval([]), false);
});

test("deriveTranscriptTurnState separates waiting from working and idle", () => {
  assert.equal(
    deriveTranscriptTurnState([tool(), permission()], true),
    "awaiting-approval",
  );
  // A live turn that is blocked still owes the reader a decision, not a
  // progress animation — even when the observer reports the turn as active.
  assert.equal(
    deriveTranscriptTurnState([tool(), permission()], false),
    "awaiting-approval",
  );
  assert.equal(deriveTranscriptTurnState([tool()], true), "working");
  assert.equal(deriveTranscriptTurnState([tool()], false), "idle");
});
