import assert from "node:assert/strict";
import test from "node:test";

import {
  findPermissionToolItem,
  findTurnRequesterPubkey,
  isAllowIntent,
  isDenyIntent,
  orderPermissionOptions,
  permissionConsequenceLine,
  permissionOptionAccessibleName,
  permissionOptionIntent,
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

test("the gated tool call is found by toolCallId suffix", () => {
  const items = [tool(), tool({ id: "tool:ch:call-8" })];
  assert.equal(findPermissionToolItem(items, "call-7")?.id, "tool:ch:call-7");
  assert.equal(findPermissionToolItem(items, "call-9"), null);
  assert.equal(findPermissionToolItem(items, null), null);
});

test("a partial toolCallId does not match a longer id", () => {
  // Suffix matching is anchored on the ":" separator so "call-7" cannot
  // collide with "recall-7".
  const items = [tool({ id: "tool:ch:recall-7" })];
  assert.equal(findPermissionToolItem(items, "call-7"), null);
});

test("the requester is the author of the same turn's user message", () => {
  const items = [
    userMessage({ id: "user:0", turnId: "turn-0", authorPubkey: OTHER }),
    userMessage(),
  ];
  assert.equal(findTurnRequesterPubkey(items, "turn-1"), REQUESTER);
  assert.equal(findTurnRequesterPubkey(items, "turn-0"), OTHER);
});

test("an unscoped or unattributed turn yields no requester", () => {
  assert.equal(findTurnRequesterPubkey([userMessage()], null), null);
  assert.equal(
    findTurnRequesterPubkey([userMessage({ authorPubkey: null })], "turn-1"),
    null,
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
