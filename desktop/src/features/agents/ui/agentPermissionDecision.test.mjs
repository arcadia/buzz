import assert from "node:assert/strict";
import test from "node:test";

import { buildTranscript } from "./agentSessionTranscript.ts";
import {
  buildTurnRequesterIndex,
  canStopPermissionTurn,
  findPermissionToolItem,
  isAllowIntent,
  isDenyIntent,
  orderPermissionOptions,
  permissionConsequenceLine,
  permissionOptionAccessibleName,
  permissionOptionIntent,
  permissionUnavailableReason,
  viewerIsRequester,
} from "./agentPermissionDecision.ts";

const timestamp = "2026-06-14T19:00:00.000Z";
const REQUESTER =
  "aa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899";
const OTHER =
  "1111111111111111111111111111111111111111111111111111111111111111";

function userMessage(overrides = {}) {
  return {
    id: "user:1",
    type: "message",
    renderClass: "message",
    role: "user",
    title: "User",
    text: "apply the fix",
    timestamp,
    turnId: "turn-1",
    authorPubkey: REQUESTER,
    ...overrides,
  };
}

function tool(overrides = {}) {
  return {
    id: "tool:ch:call-7",
    type: "tool",
    renderClass: "shell",
    descriptor: { renderClass: "shell", label: "Shell", preview: null },
    title: "Ran command",
    toolName: "shell",
    buzzToolName: null,
    status: "pending",
    args: {},
    result: "",
    isError: false,
    timestamp,
    startedAt: timestamp,
    completedAt: null,
    turnId: "turn-1",
    ...overrides,
  };
}

test("option intent is read from the ACP kind, not the label", () => {
  assert.equal(
    permissionOptionIntent({ optionId: "a", kind: "allow_once", name: "Yes" }),
    "allow-once",
  );
  assert.equal(
    permissionOptionIntent({
      optionId: "b",
      kind: "allow_always",
      name: "Always",
    }),
    "allow-always",
  );
  assert.equal(
    permissionOptionIntent({ optionId: "c", kind: "reject_once", name: "No" }),
    "deny-once",
  );
  assert.equal(
    permissionOptionIntent({
      optionId: "d",
      kind: "reject_always",
      name: "Never",
    }),
    "deny-always",
  );
});

test("an unrecognised kind is never guessed into allow or deny", () => {
  // A label that reads affirmative must not buy affirmative styling: the wire
  // kind is the only thing that decides which direction a button points.
  const option = { optionId: "x", kind: "escalate_to_owner", name: "Approve" };
  assert.equal(permissionOptionIntent(option), "unknown");
  assert.equal(isAllowIntent(permissionOptionIntent(option)), false);
  assert.equal(isDenyIntent(permissionOptionIntent(option)), false);
});

test("a missing kind stays unknown rather than defaulting", () => {
  assert.equal(
    permissionOptionIntent({ optionId: "y", kind: null, name: "Allow once" }),
    "unknown",
  );
});

test("options are ordered narrow-allow, broad-allow, then deny", () => {
  const wireOrder = [
    { optionId: "deny", kind: "reject_once", name: "Deny" },
    { optionId: "always", kind: "allow_always", name: "Always" },
    { optionId: "once", kind: "allow_once", name: "Allow once" },
  ];
  assert.deepEqual(
    orderPermissionOptions(wireOrder).map((option) => option.optionId),
    ["once", "always", "deny"],
  );
  // The input is not mutated — the transcript item owns that array.
  assert.equal(wireOrder[0].optionId, "deny");
});

test("consequence copy comes from the classifier tone, and stays silent without one", () => {
  assert.match(permissionConsequenceLine("write"), /change files or data/);
  assert.match(
    permissionConsequenceLine("admin"),
    /change access or membership/,
  );
  assert.match(permissionConsequenceLine("read"), /will not change anything/);
  assert.equal(permissionConsequenceLine("neutral"), null);
  assert.equal(permissionConsequenceLine(undefined), null);
});

const PERMISSION_ID = "permission:ch:sess:s:req-1";

test("the gated tool call is found by toolCallId within the card's channel", () => {
  const items = [tool(), tool({ id: "tool:ch:call-8" })];
  assert.equal(
    findPermissionToolItem(items, "call-7", PERMISSION_ID)?.id,
    "tool:ch:call-7",
  );
  assert.equal(findPermissionToolItem(items, "call-9", PERMISSION_ID), null);
  assert.equal(findPermissionToolItem(items, null, PERMISSION_ID), null);
});

test("a partial toolCallId does not match a longer id", () => {
  // The id is reconstructed whole, so "call-7" cannot collide with "recall-7".
  const items = [tool({ id: "tool:ch:recall-7" })];
  assert.equal(findPermissionToolItem(items, "call-7", PERMISSION_ID), null);
});

test("the requester is the author of the same turn's user message", () => {
  const index = buildTurnRequesterIndex([
    userMessage({ id: "user:0", turnId: "turn-0", authorPubkey: OTHER }),
    userMessage(),
  ]);
  assert.equal(index.get("turn-1"), REQUESTER);
  assert.equal(index.get("turn-0"), OTHER);
});

test("the first attributed message in a turn owns it", () => {
  const index = buildTurnRequesterIndex([
    userMessage(),
    userMessage({ id: "user:2", authorPubkey: OTHER }),
  ]);
  assert.equal(index.get("turn-1"), REQUESTER);
});

test("an unscoped or unattributed turn yields no requester", () => {
  assert.equal(
    buildTurnRequesterIndex([userMessage({ turnId: null })]).get("turn-1"),
    undefined,
  );
  assert.equal(
    buildTurnRequesterIndex([userMessage({ authorPubkey: null })]).get(
      "turn-1",
    ),
    undefined,
  );
});

test("requester matching is case-insensitive on both sides", () => {
  assert.equal(viewerIsRequester(REQUESTER, REQUESTER.toUpperCase()), true);
});

test("unknown identity on either side is not permission", () => {
  // Failing open here would hand the answer to whoever happened to be looking.
  assert.equal(viewerIsRequester(null, REQUESTER), false);
  assert.equal(viewerIsRequester(REQUESTER, null), false);
  assert.equal(viewerIsRequester(REQUESTER, undefined), false);
  assert.equal(viewerIsRequester(null, null), false);
  assert.equal(viewerIsRequester(REQUESTER, OTHER), false);
});

test("the accessible name carries what is being approved", () => {
  assert.equal(
    permissionOptionAccessibleName(
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      "Apply Terraform change",
    ),
    "Allow once — Apply Terraform change",
  );
});

// --- the tool join is channel-anchored (review finding 2) ---

test("the tool join is scoped to the permission item's own channel", () => {
  // Harnesses number tool calls per session, so `p3` exists in every channel.
  // The unscoped panel holds every channel's rows, and an unanchored suffix
  // match hands the first one to the card — putting another channel's command
  // under "Show the exact command" on the surface that exists to get exactly
  // that right.
  const items = [
    tool({ id: "tool:channel-a:p3", args: { command: "rm -rf /srv/a" } }),
    tool({ id: "tool:channel-b:p3", args: { command: "ls /srv/b" } }),
  ];

  assert.equal(
    findPermissionToolItem(items, "p3", "permission:channel-b:s:req-1")?.id,
    "tool:channel-b:p3",
  );
  assert.equal(
    findPermissionToolItem(items, "p3", "permission:channel-a:s:req-1")?.id,
    "tool:channel-a:p3",
  );
});

test("the join shows nothing rather than another channel's call", () => {
  const items = [tool({ id: "tool:channel-a:p3" })];
  assert.equal(
    findPermissionToolItem(items, "p3", "permission:channel-b:s:req-1"),
    null,
  );
});

test("the reducer's own permission and tool ids line up for the join", () => {
  // The join reconstructs a tool id from the permission id. That coupling is
  // invisible to both sides, so it is asserted against real reducer output
  // rather than hand-written ids.
  const channelA = "11111111-1111-1111-1111-111111111111";
  const channelB = "22222222-2222-2222-2222-222222222222";
  const sharedToolCallId = "p3";

  function toolCall(seq, channelId, command) {
    return {
      seq,
      timestamp,
      kind: "acp_read",
      agentIndex: 0,
      channelId,
      sessionId: "session-1",
      turnId: `turn-${channelId}`,
      payload: {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: sharedToolCallId,
            title: "dev__shell",
            status: "pending",
            rawInput: { command },
          },
        },
      },
    };
  }

  function permissionFrame(seq, channelId) {
    return {
      seq,
      timestamp,
      kind: "acp_read",
      agentIndex: 0,
      channelId,
      sessionId: "session-1",
      turnId: `turn-${channelId}`,
      payload: {
        jsonrpc: "2.0",
        id: seq,
        method: "session/request_permission",
        params: {
          title: "Run it",
          toolCallId: sharedToolCallId,
          options: [{ optionId: "once", kind: "allow_once", name: "Allow" }],
        },
      },
    };
  }

  const items = buildTranscript([
    toolCall(1, channelA, "rm -rf /srv/a"),
    permissionFrame(2, channelA),
    toolCall(3, channelB, "ls /srv/b"),
    permissionFrame(4, channelB),
  ]);

  const permissions = items.filter((item) => item.renderClass === "permission");
  assert.equal(permissions.length, 2);
  for (const permission of permissions) {
    const joined = findPermissionToolItem(
      items,
      permission.permission.toolCallId,
      permission.id,
    );
    assert.ok(joined, "every permission should join to a tool row");
    assert.equal(joined.channelId, permission.channelId);
  }
});

// --- the Stop gate matches the panel menu's gate (review finding 4) ---

test("stopping a turn needs a live turn, the capability, and a channel", () => {
  // The panel menu gates its Stop on `isWorking && canInterruptTurn`. This
  // card claims the same gate, and a Stop offered on a dead turn interrupts
  // whatever unrelated turn is running by then.
  assert.equal(
    canStopPermissionTurn({
      canInterruptTurn: true,
      hasChannelScope: true,
      isWorking: true,
    }),
    true,
  );
  assert.equal(
    canStopPermissionTurn({
      canInterruptTurn: true,
      hasChannelScope: true,
      isWorking: false,
    }),
    false,
  );
  assert.equal(
    canStopPermissionTurn({
      canInterruptTurn: false,
      hasChannelScope: true,
      isWorking: true,
    }),
    false,
  );
  assert.equal(
    canStopPermissionTurn({
      canInterruptTurn: true,
      hasChannelScope: false,
      isWorking: true,
    }),
    false,
  );
});

// --- no silent dead end when there is nothing to press (review finding 5) ---

test("the requester is always told why there are no buttons", () => {
  assert.equal(
    permissionUnavailableReason({
      canDecide: true,
      isRequester: true,
      optionCount: 2,
    }),
    null,
  );
  assert.equal(
    permissionUnavailableReason({
      canDecide: false,
      isRequester: true,
      optionCount: 2,
    }),
    "transport",
  );
  // Every option arrived without an `optionId`, so none can be answered with.
  // Without this the card is an approval demand with zero affordance and zero
  // reason, and silence denies it.
  assert.equal(
    permissionUnavailableReason({
      canDecide: true,
      isRequester: true,
      optionCount: 0,
    }),
    "no-options",
  );
});

test("a non-requester gets no unavailable copy — the block already names the owner", () => {
  assert.equal(
    permissionUnavailableReason({
      canDecide: false,
      isRequester: false,
      optionCount: 0,
    }),
    null,
  );
});
