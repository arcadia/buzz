import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { safeNpub } from "@/shared/lib/nostrUtils";
import { PermissionActivity } from "./PermissionActivity.tsx";
import { AgentPermissionDecisionContext } from "../useAgentPermissionDecisions.tsx";

const timestamp = "2026-06-14T19:00:00.000Z";
const REQUESTER =
  "aa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899";
const VIEWER =
  "1111111111111111111111111111111111111111111111111111111111111111";
const ITEM_ID = "permission:ch:sess:s:req-1";

function permissionItem(overrides = {}) {
  return {
    id: ITEM_ID,
    type: "lifecycle",
    renderClass: "permission",
    title: "Permission requested",
    text: "Apply Terraform change\nOptions: Allow once, Deny",
    timestamp,
    turnId: "turn-1",
    channelId: "ch",
    permission: {
      requestId: "req-1",
      toolCallId: null,
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "no", kind: "reject_once", name: "Deny" },
      ],
    },
    ...overrides,
  };
}

function render(item, contextOverrides = {}) {
  const value = {
    canDecide: true,
    canStopTurn: false,
    decide: () => {},
    decisions: new Map(),
    requesterByItemId: new Map([[item.id, REQUESTER]]),
    stopTurn: null,
    toolByItemId: new Map(),
    viewerPubkey: REQUESTER,
    ...contextOverrides,
  };
  return renderToStaticMarkup(
    React.createElement(
      AgentPermissionDecisionContext.Provider,
      { value },
      React.createElement(PermissionActivity, {
        agentName: "Observer Agent",
        item,
        profiles: undefined,
        timestampTitle: undefined,
      }),
    ),
  );
}

test("the requester gets the answer buttons", () => {
  const html = render(permissionItem());
  assert.ok(html.includes("transcript-permission-actions"));
  assert.ok(!html.includes("transcript-permission-unavailable"));
});

test("an approval demand with no answerable options still says why", () => {
  // Every option arrived without an optionId and was dropped, so there is
  // nothing to press — and the transport is fine, so the transport copy does
  // not fire either. Silence denies the request, so the card has to say so.
  const html = render(
    permissionItem({
      text: "Apply Terraform change",
      permission: { requestId: "req-1", toolCallId: null, options: [] },
    }),
  );
  assert.ok(
    !html.includes("transcript-permission-actions"),
    "no options means no buttons",
  );
  assert.ok(
    html.includes("transcript-permission-unavailable"),
    "the requester must be told why the card has no controls",
  );
  assert.match(html, /no answerable options/);
});

test("a transport that cannot deliver keeps its own copy", () => {
  const html = render(permissionItem(), { canDecide: false });
  assert.ok(html.includes("transcript-permission-unavailable"));
  assert.match(html, /not available for this agent yet/);
});

test("an observer sees the requester's key in full, never truncated", () => {
  // PubKey's own contract for security-decision surfaces: a truncated key is
  // forgeable by vanity grinding, which is the exact attack the key is printed
  // here to defeat, so the whole key has to be on screen.
  const html = render(permissionItem(), { viewerPubkey: VIEWER });
  assert.ok(
    html.includes("transcript-permission-requester-pubkey"),
    "the observer view names whose answer it is waiting on",
  );
  const npub = safeNpub(REQUESTER);
  assert.ok(npub, "the fixture key should encode to an npub");
  assert.ok(
    html.includes(npub),
    "the requester's key must render whole, not as a forgeable prefix",
  );
});

test("the resolved row says what was authorised, not only how it ended", () => {
  const html = render(permissionItem({ outcome: "Approved (allow_once)" }), {});
  assert.ok(html.includes("Approved (allow_once)"));
  assert.match(html, /Apply Terraform change/);
});

test("a resolved row for a request that named nothing still names something", () => {
  const html = render(
    permissionItem({ outcome: "Approved (allow_once)", text: "" }),
    {},
  );
  assert.match(
    html,
    /Permission requested/,
    "an outcome with no object leaves the audit row saying nothing",
  );
});
