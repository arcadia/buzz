import { expect, test, type Page } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

/**
 * Visual baselines for the approve/deny control — the highest-stakes surface in
 * the product, where a wrong tap executes something real.
 *
 * The states below are the ones that decide whether the control is honest:
 * who is allowed to answer, what is being authorized, what is in flight, and
 * what a failed send looks like. The thread panel needs room to open beside the
 * channel, so these run at the width the panel is actually used at.
 */
const SHOTS = "test-results/approval-control";

const OBSERVER_AGENT_PUBKEY = TEST_IDENTITIES.tyler.pubkey;
const OTHER_REQUESTER = TEST_IDENTITIES.alice.pubkey;
const CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301"; // #agents
const THEME_STORAGE_KEY = "buzz-theme";
const START = Date.now() - 40_000;
const PERMISSION_RPC_ID = 77;

const MANAGED_AGENTS = [
  {
    pubkey: OBSERVER_AGENT_PUBKEY,
    name: "Observer Agent",
    status: "running" as const,
    channelNames: ["agents"],
  },
];

type SeedEvent = {
  seq: number;
  timestamp: string;
  kind: string;
  agentIndex: number | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  payload: unknown;
};

function at(offsetSeconds: number) {
  return new Date(START + offsetSeconds * 1000).toISOString();
}

async function waitForSeedHook(page: Page) {
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
    null,
    { timeout: 10_000 },
  );
}

async function openObserverFeedPanel(page: Page, agentPubkey: string) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForSeedHook(page);

  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");

  const messageRow = page
    .getByTestId("message-row")
    .filter({ has: page.getByText("Observer Agent", { exact: false }) });
  await expect(messageRow.first()).toBeVisible({ timeout: 8_000 });
  await messageRow.first().getByRole("button").first().click();

  await expect(page.getByTestId("user-profile-panel")).toBeVisible({
    timeout: 10_000,
  });

  const activityBtn = page.getByTestId(
    `user-profile-view-activity-${agentPubkey}`,
  );
  await expect(activityBtn).toBeVisible({ timeout: 5_000 });
  await activityBtn.click();

  const feedPanel = page.getByTestId("agent-session-thread-panel");
  await expect(feedPanel).toBeVisible({ timeout: 10_000 });
  return feedPanel;
}

async function seedTheme(page: Page, theme: string) {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: THEME_STORAGE_KEY, value: theme },
  );
}

async function seedObserverEvents(
  page: Page,
  agentPubkey: string,
  events: SeedEvent[],
) {
  await page.evaluate(
    ({ pubkey, evts }) => {
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey: pubkey,
        events: evts,
      });
    },
    { pubkey: agentPubkey, evts: events },
  );
  await page.waitForTimeout(400);
}

/** Ask the app who it thinks it is, so requester-vs-observer is never guessed. */
async function viewerPubkey(page: Page): Promise<string> {
  const identity = await page.evaluate(async () => {
    const invoke = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
    if (!invoke) throw new Error("mock bridge not installed");
    return (await invoke("get_identity", null)) as { pubkey: string };
  });
  return identity.pubkey;
}

async function settleAnimations(
  panel: import("@playwright/test").Locator,
): Promise<void> {
  // Only await finite animations — the awaiting-approval mark breathes forever
  // and its `finished` promise never resolves.
  //
  // Swallow per-animation rejections: swapping a button's icon for the spinner
  // cancels the outgoing icon's transition, and a cancelled animation *rejects*
  // `finished` with AbortError. Without the catch, settling the in-flight state
  // fails on the very frame it exists to capture.
  await panel.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter(
          (a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
        )
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

// ── Fixture builders ────────────────────────────────────────────────────────

let seq = 0;

function reset() {
  seq = 0;
}

function update(
  turnId: string,
  offset: number,
  body: Record<string, unknown>,
): SeedEvent {
  seq += 1;
  return {
    seq,
    timestamp: at(offset),
    kind: "acp_read",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: "session-approval",
    turnId,
    payload: {
      method: "session/update",
      params: { sessionId: "session-approval", update: body },
    },
  };
}

function turnStarted(turnId: string, offset: number): SeedEvent {
  seq += 1;
  return {
    seq,
    timestamp: at(offset),
    kind: "turn_started",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: "session-approval",
    turnId,
    payload: { source: "channel", triggeringEventIds: [] },
  };
}

/**
 * The prompt frame carries the requester on a `From: … hex: …` line, which is
 * the only place the requester's identity appears — there is no requester field
 * on the permission frame itself.
 */
function prompt(
  turnId: string,
  offset: number,
  text: string,
  authorPubkey: string,
): SeedEvent {
  seq += 1;
  return {
    seq,
    timestamp: at(offset),
    kind: "acp_write",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: "session-approval",
    turnId,
    payload: {
      jsonrpc: "2.0",
      id: seq,
      method: "session/prompt",
      params: {
        prompt: [
          {
            type: "text",
            text: `[Buzz event: Kind 9]\nFrom: Requester (hex: ${authorPubkey})\nContent: ${text}`,
          },
        ],
      },
    },
  };
}

function tool(
  turnId: string,
  offset: number,
  id: string,
  title: string,
  args: Record<string, unknown>,
  result: string,
): SeedEvent[] {
  return [
    update(turnId, offset, {
      sessionUpdate: "tool_call",
      toolCallId: id,
      title,
      status: "executing",
      rawInput: args,
    }),
    update(turnId, offset + 1, {
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      title,
      status: "completed",
      rawInput: args,
      content: [{ type: "content", content: { type: "text", text: result } }],
    }),
  ];
}

const SHELL = "buzz_dev_mcp__shell";
const READ = "buzz_dev_mcp__read_file";
/** The call the request gates — announced, pending, never run. */
const GATED_TOOL_CALL_ID = "p3";

function permissionRequest(turnId: string, offset: number): SeedEvent {
  seq += 1;
  return {
    seq,
    timestamp: at(offset),
    kind: "acp_read",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: "session-approval",
    turnId,
    payload: {
      jsonrpc: "2.0",
      id: PERMISSION_RPC_ID,
      method: "session/request_permission",
      params: {
        title: "Apply Terraform change",
        toolCallId: GATED_TOOL_CALL_ID,
        options: [
          { optionId: "opt-deny", kind: "reject_once", name: "Deny" },
          { optionId: "opt-always", kind: "allow_always", name: "Always" },
          { optionId: "opt-allow", kind: "allow_once", name: "Allow once" },
        ],
      },
    },
  };
}

/** The harness's own answer, which is what actually resolves the block. */
function permissionResponse(
  turnId: string,
  offset: number,
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" },
): SeedEvent {
  seq += 1;
  return {
    seq,
    timestamp: at(offset),
    kind: "acp_write",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: "session-approval",
    turnId,
    payload: {
      jsonrpc: "2.0",
      id: PERMISSION_RPC_ID,
      result: { outcome },
    },
  };
}

/**
 * A turn parked on a permission: some real work, then the gated call announced
 * as pending, then the request. `requesterPubkey` decides whether the viewer is
 * the person who may answer.
 */
function pendingPermissionEvents(requesterPubkey: string): SeedEvent[] {
  reset();
  const t = "turn-approval";
  return [
    turnStarted(t, 0),
    prompt(
      t,
      1,
      "@Observer Agent apply the IAM fix from SDAA-100888.",
      requesterPubkey,
    ),
    ...tool(
      t,
      2,
      "p1",
      READ,
      { path: "infra/iam/exports.tf" },
      'resource "aws_iam_role_policy" "exports" {}',
    ),
    ...tool(
      t,
      4,
      "p2",
      SHELL,
      { command: "terraform plan -target=aws_iam_role_policy.exports" },
      "Plan: 0 to add, 1 to change, 0 to destroy.",
    ),
    // Announced but not run — this is the call the request is gating, and the
    // card joins to it to show what approving would actually execute.
    update(t, 6, {
      sessionUpdate: "tool_call",
      toolCallId: GATED_TOOL_CALL_ID,
      title: SHELL,
      status: "pending",
      rawInput: {
        command: "terraform apply -target=aws_iam_role_policy.exports",
      },
    }),
    permissionRequest(t, 7),
  ];
}

function resolvedEvents(
  requesterPubkey: string,
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" },
): SeedEvent[] {
  const events = pendingPermissionEvents(requesterPubkey);
  events.push(permissionResponse("turn-approval", 9, outcome));
  return events;
}

async function seedPending(page: Page, requesterPubkey: string) {
  await seedObserverEvents(
    page,
    OBSERVER_AGENT_PUBKEY,
    pendingPermissionEvents(requesterPubkey),
  );
}

async function expectPermissionBlock(
  panel: import("@playwright/test").Locator,
) {
  await expect(panel.getByTestId("transcript-permission-item")).toBeVisible({
    timeout: 5_000,
  });
}

async function shoot(panel: import("@playwright/test").Locator, name: string) {
  await settleAnimations(panel);
  await panel.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe("agent approval control", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error("CONSOLE ERROR:", msg.text().slice(0, 400));
      }
    });
  });

  for (const theme of ["light", "dark"] as const) {
    const suffix = theme === "dark" ? "-dark" : "";

    test(`pending as the requester${suffix}`, async ({ page }) => {
      if (theme === "dark") await seedTheme(page, "buzz-dark");
      await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
      const panel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
      await seedPending(page, await viewerPubkey(page));
      await expectPermissionBlock(panel);
      await expect(
        panel.getByTestId("transcript-permission-actions"),
      ).toBeVisible();
      await shoot(panel, `01-pending-requester${suffix}`);
    });

    test(`pending as an observer${suffix}`, async ({ page }) => {
      if (theme === "dark") await seedTheme(page, "buzz-dark");
      await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
      const panel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
      await seedPending(page, OTHER_REQUESTER);
      await expectPermissionBlock(panel);
      // The control must be absent, not disabled: a non-requester never sees a
      // button that would refuse them.
      await expect(
        panel.getByTestId("transcript-permission-actions"),
      ).toHaveCount(0);
      await shoot(panel, `02-pending-observer${suffix}`);
    });

    test(`answer in flight${suffix}`, async ({ page }) => {
      if (theme === "dark") await seedTheme(page, "buzz-dark");
      await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
      const panel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
      await seedPending(page, await viewerPubkey(page));
      await expectPermissionBlock(panel);
      // Wedge the relay send so the in-flight state holds still.
      await page.evaluate(() =>
        window.__BUZZ_E2E_SET_STALL_WEBSOCKET_SENDS__?.(true),
      );
      await panel.getByTestId("transcript-permission-option-opt-allow").click();
      await expect(
        panel.getByTestId("transcript-permission-decision-status"),
      ).toContainText("Sending", { timeout: 5_000 });
      await shoot(panel, `03-in-flight${suffix}`);
    });

    test(`answer sent, awaiting confirmation${suffix}`, async ({ page }) => {
      if (theme === "dark") await seedTheme(page, "buzz-dark");
      await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
      const panel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
      await seedPending(page, await viewerPubkey(page));
      await expectPermissionBlock(panel);
      await panel.getByTestId("transcript-permission-option-opt-allow").click();
      await expect(
        panel.getByTestId("transcript-permission-decision-status"),
      ).toContainText("Answer sent", { timeout: 10_000 });
      // The frame the harness would have to act on.
      const frames = await page.evaluate(
        () =>
          window.__BUZZ_E2E_COMMAND_PAYLOADS__?.filter(
            (entry) => entry.command === "build_observer_control_event",
          ) ?? [],
      );
      expect(frames).toHaveLength(1);
      expect(
        (frames[0].payload as { payload: Record<string, unknown> }).payload,
      ).toMatchObject({
        type: "permission_decision",
        channelId: CHANNEL_ID,
        requestId: JSON.stringify(PERMISSION_RPC_ID),
        optionId: "opt-allow",
      });
      await shoot(panel, `04-sent${suffix}`);
    });

    test(`send failed${suffix}`, async ({ page }) => {
      if (theme === "dark") await seedTheme(page, "buzz-dark");
      await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
      const panel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
      await seedPending(page, await viewerPubkey(page));
      await expectPermissionBlock(panel);
      await page.evaluate(() =>
        window.__BUZZ_E2E_FAIL_OBSERVER_CONTROL__?.(
          "The relay rejected the control frame.",
        ),
      );
      await panel.getByTestId("transcript-permission-option-opt-allow").click();
      await expect(
        panel.getByTestId("transcript-permission-decision-status"),
      ).toContainText("did not reach", { timeout: 10_000 });
      await shoot(panel, `05-send-failed${suffix}`);
    });

    test(`resolved outcomes${suffix}`, async ({ page }) => {
      if (theme === "dark") await seedTheme(page, "buzz-dark");
      await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
      await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
      const viewer = await viewerPubkey(page);

      for (const [name, outcome] of [
        ["06-approved", { outcome: "selected", optionId: "opt-allow" }],
        ["07-denied", { outcome: "selected", optionId: "opt-deny" }],
        // A request nobody answered is cancelled by the runtime, which is what
        // the timeout path looks like on the wire — there is no separate
        // "timed out" frame to render.
        ["08-timed-out", { outcome: "cancelled" }],
      ] as const) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForSeedHook(page);
        const reopened = await openObserverFeedPanel(
          page,
          OBSERVER_AGENT_PUBKEY,
        );
        await seedObserverEvents(
          page,
          OBSERVER_AGENT_PUBKEY,
          resolvedEvents(viewer, outcome),
        );
        await expect(
          reopened.getByTestId("transcript-permission-outcome"),
        ).toBeVisible({ timeout: 5_000 });
        await shoot(reopened, `${name}${suffix}`);
      }
    });
  }

  test("pending as the requester, narrow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    const panel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
    await seedPending(page, await viewerPubkey(page));
    await expectPermissionBlock(panel);
    await shoot(panel, "09-pending-requester-narrow");
  });

  /**
   * What a real user sees today, and the reason this spec cannot simply assume
   * the button states above are the product.
   *
   * `canSendAgentPermissionDecision()` is false in every shipped build — the
   * harness answers permission requests itself and ignores any decision frame —
   * and only the mock bridge turns it on. Dropping `__BUZZ_E2E__` after the
   * bridge has installed leaves mock IPC working while putting that capability
   * check back on its production answer, so the shipped branch is exercised
   * without adding a test-only seam to production code.
   */
  test("pending as the requester, transport not connected", async ({
    page,
  }) => {
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    const panel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
    const viewer = await viewerPubkey(page);
    await page.evaluate(() => {
      delete (window as Window & { __BUZZ_E2E__?: unknown }).__BUZZ_E2E__;
    });
    await seedPending(page, viewer);
    await expectPermissionBlock(panel);
    await expect(
      panel.getByTestId("transcript-permission-actions"),
    ).toHaveCount(0);
    await expect(
      panel.getByTestId("transcript-permission-unavailable"),
    ).toBeVisible();
    // The interrupt is the one control that genuinely works, so it must survive
    // the capability being off.
    await expect(panel.getByTestId("transcript-permission-stop")).toBeVisible();
    await shoot(panel, "11-pending-requester-no-transport");
  });

  test("pending as an observer, narrow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    const panel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
    await seedPending(page, OTHER_REQUESTER);
    await expectPermissionBlock(panel);
    await shoot(panel, "10-pending-observer-narrow");
  });
});
