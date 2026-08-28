import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveTranscriptTurnState,
  hasPendingApproval,
  isUnresolvedPermission,
} from "./agentSessionTurnState.ts";
import { buildTranscript } from "./agentSessionTranscript.ts";

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

test("hasPendingApproval scopes to the newest turn even when the last row has none", () => {
  // Archive-ingested rows and trailing status frames can arrive without a turn
  // id. Giving up on scoping there let an abandoned request from an old
  // session pin the foot to "awaiting approval" forever, suppressing the
  // liveness signal for every turn that followed it.
  const stale = permission({
    id: "permission:old",
    sessionId: "session-old",
    turnId: "turn-old",
  });
  const current = tool({
    id: "tool:new",
    sessionId: "session-new",
    turnId: "turn-new",
  });
  const trailing = {
    id: "usage:new",
    type: "lifecycle",
    renderClass: "status",
    title: "Usage",
    text: "Tokens: 10/100",
    timestamp,
    sessionId: "session-new",
    turnId: null,
  };

  assert.equal(hasPendingApproval([stale, current, trailing]), false);
});

test("hasPendingApproval's unscoped fallback stays inside the newest session", () => {
  const stale = permission({
    id: "permission:old",
    sessionId: "session-old",
    turnId: null,
  });
  const current = tool({
    id: "tool:new",
    sessionId: "session-new",
    turnId: null,
  });

  assert.equal(hasPendingApproval([stale, current]), false);
});

// --- integration: the reducer must not merge two requests into one row ---

function permissionFrame(seq, requestId, title) {
  return {
    seq,
    timestamp,
    kind: "acp_read",
    agentIndex: 0,
    channelId: "channel-1",
    sessionId: "session-1",
    turnId: "turn-1",
    payload: {
      jsonrpc: "2.0",
      id: requestId,
      method: "session/request_permission",
      params: {
        title,
        toolCallId: `call-${requestId}`,
        options: [{ optionId: "once", kind: "allow_once", name: "Allow" }],
      },
    },
  };
}

test("a second request in a turn keeps the foot on 'awaiting approval'", () => {
  // The foot animating liveness while the turn is parked on an unanswered
  // permission is exactly the false claim this module exists to prevent — and
  // it is what a per-turn card key produced, because the second request
  // inherited the first's outcome.
  const items = buildTranscript([
    permissionFrame(1, "req-a", "Push to origin"),
    {
      seq: 2,
      timestamp,
      kind: "acp_write",
      agentIndex: 0,
      channelId: "channel-1",
      sessionId: "session-1",
      turnId: "turn-1",
      payload: {
        jsonrpc: "2.0",
        id: "req-a",
        result: { outcome: { outcome: "selected", optionId: "once" } },
      },
    },
    permissionFrame(3, "req-b", "Delete the production bucket"),
  ]);

  assert.equal(hasPendingApproval(items), true);
  assert.equal(deriveTranscriptTurnState(items, true), "awaiting-approval");
});
