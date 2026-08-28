import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

/**
 * Visual baselines for the streaming tool-call timeline — the surface a
 * requester watches while an agent works. The fixtures below are the states
 * that matter for supervision: a long mixed run, a run that failed part-way,
 * and a turn parked on a permission the requester has to answer.
 *
 * The thread panel needs room to open beside the channel, so each spec sets
 * its own viewport to the width the panel is actually used at.
 */
const SHOTS = "test-results/tool-timeline";

const OBSERVER_AGENT_PUBKEY = TEST_IDENTITIES.tyler.pubkey;
const CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301"; // #agents
const THEME_STORAGE_KEY = "buzz-theme";
// Anchored to the run, not to a fixed date: the in-flight row shows a live
// elapsed readout, and a fixed-date fixture would render it as months old.
const START = Date.now() - 40_000;

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

async function waitForSeedHook(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
    null,
    { timeout: 10_000 },
  );
}

async function openObserverFeedPanel(
  page: import("@playwright/test").Page,
  agentPubkey: string,
) {
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

async function seedTheme(page: import("@playwright/test").Page, theme: string) {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: THEME_STORAGE_KEY, value: theme },
  );
}

async function seedObserverEvents(
  page: import("@playwright/test").Page,
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

async function settleAnimations(panel: import("@playwright/test").Locator) {
  // Only await finite animations — the liveness indicator loops forever and
  // its `finished` promise never resolves.
  await panel.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter(
          (a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
        )
        .map((a) => a.finished),
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
    sessionId: "session-timeline",
    turnId,
    payload: {
      method: "session/update",
      params: { sessionId: "session-timeline", update: body },
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
    sessionId: "session-timeline",
    turnId,
    payload: { source: "channel", triggeringEventIds: [] },
  };
}

function prompt(turnId: string, offset: number, text: string): SeedEvent {
  seq += 1;
  return {
    seq,
    timestamp: at(offset),
    kind: "acp_write",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: "session-timeline",
    turnId,
    payload: {
      jsonrpc: "2.0",
      id: seq,
      method: "session/prompt",
      params: {
        prompt: [
          { type: "text", text: `[Buzz event: Kind 9]\nContent: ${text}` },
        ],
      },
    },
  };
}

/** A tool that starts and then completes, two frames. */
function tool(
  turnId: string,
  offset: number,
  id: string,
  title: string,
  args: Record<string, unknown>,
  result: string,
  status: "completed" | "failed" = "completed",
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
      status,
      rawInput: args,
      content: [{ type: "content", content: { type: "text", text: result } }],
    }),
  ];
}

/** A tool that is still running when the capture happens. */
function runningTool(
  turnId: string,
  offset: number,
  id: string,
  title: string,
  args: Record<string, unknown>,
): SeedEvent {
  return update(turnId, offset, {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title,
    status: "executing",
    rawInput: args,
  });
}

const SHELL = "buzz_dev_mcp__shell";
const READ = "buzz_dev_mcp__read_file";
const EDIT = "buzz_dev_mcp__str_replace";

/**
 * A long triage run: prompt → thinking → a burst of reads and greps → an edit
 * → a failed command → recovery → a running command. This is the state a
 * requester actually stares at, and the one "what is it doing / is it stuck /
 * did anything fail" has to survive.
 */
function longRunEvents(): SeedEvent[] {
  reset();
  const t = "turn-long";
  const events: SeedEvent[] = [
    turnStarted(t, 0),
    prompt(
      t,
      1,
      "@Observer Agent SDAA-100888 came in overnight — the nightly export is failing for Evergreen. Can you work out what broke and post a summary in the thread?",
    ),
    update(t, 2, {
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: "Starting from the failing export job — I want the error before I touch any config.",
      },
    }),
    ...tool(
      t,
      3,
      "c1",
      SHELL,
      { command: "buzz messages get --channel ops --limit 40" },
      "40 messages",
    ),
    ...tool(
      t,
      5,
      "c2",
      SHELL,
      { command: "grep -rn 'evergreen' config/exports/" },
      "config/exports/evergreen.yaml:12:  schedule: nightly",
    ),
    ...tool(
      t,
      7,
      "c3",
      READ,
      { path: "config/exports/evergreen.yaml" },
      "schedule: nightly\ndestination: s3://evergreen-exports/\n",
    ),
    ...tool(
      t,
      9,
      "c4",
      READ,
      { path: "config/exports/defaults.yaml" },
      "retries: 3\ntimeout: 900\n",
    ),
    ...tool(
      t,
      11,
      "c5",
      READ,
      { path: "src/exports/runner.py" },
      "def run_export(config):\n    ...\n",
    ),
    ...tool(
      t,
      13,
      "c6",
      SHELL,
      { command: "tail -n 200 /var/log/exports/evergreen-2025-06-14.log" },
      "ERROR botocore.exceptions.ClientError: An error occurred (AccessDenied)",
    ),
    ...tool(
      t,
      15,
      "c7",
      SHELL,
      { command: "aws s3 ls s3://evergreen-exports/ --profile exports" },
      "An error occurred (AccessDenied) when calling the ListObjectsV2 operation",
      "failed",
    ),
    update(t, 17, {
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: "AccessDenied on the bucket, not on the job. The export role lost its policy binding — checking when that changed.",
      },
    }),
    ...tool(
      t,
      18,
      "c8",
      SHELL,
      { command: "git log --oneline -20 -- infra/iam/exports.tf" },
      "9f2c1ab chore(iam): tighten export role scope",
    ),
    ...tool(
      t,
      20,
      "c9",
      READ,
      { path: "infra/iam/exports.tf" },
      'resource "aws_iam_role_policy" "exports" {\n  ...\n}\n',
    ),
    ...tool(
      t,
      22,
      "c10",
      EDIT,
      {
        path: "infra/iam/exports.tf",
        old_str: '    resources = ["arn:aws:s3:::arcadia-exports/*"]',
        new_str:
          '    resources = [\n      "arn:aws:s3:::arcadia-exports/*",\n      "arn:aws:s3:::evergreen-exports/*",\n    ]',
      },
      "edited infra/iam/exports.tf",
    ),
    ...tool(
      t,
      24,
      "c11",
      SHELL,
      { command: "terraform plan -target=aws_iam_role_policy.exports" },
      "Plan: 0 to add, 1 to change, 0 to destroy.",
    ),
    ...tool(
      t,
      26,
      "c12",
      SHELL,
      { command: "buzz messages send --channel ops --content 'SDAA-100888…'" },
      "sent",
    ),
    update(t, 28, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: {
        type: "text",
        text: "The nightly export is failing on **AccessDenied**, not on the job itself.\n\n`9f2c1ab` narrowed the export role to `arcadia-exports` only, so the Evergreen bucket dropped out of the policy. I've put `evergreen-exports` back in `infra/iam/exports.tf` — the plan is a single in-place change.",
      },
    }),
    runningTool(t, 29, "c13", SHELL, {
      command: "terraform apply -target=aws_iam_role_policy.exports",
    }),
  ];
  return events;
}

/** A turn parked on a permission the requester has to answer. */
function pendingPermissionEvents(): SeedEvent[] {
  reset();
  const t = "turn-perm";
  const events: SeedEvent[] = [
    turnStarted(t, 0),
    prompt(t, 1, "@Observer Agent apply the IAM fix from SDAA-100888."),
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
  ];
  seq += 1;
  events.push({
    seq,
    timestamp: at(6),
    kind: "acp_read",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: "session-timeline",
    turnId: t,
    payload: {
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: {
        title: "Apply Terraform change",
        message:
          "Agent wants to run `terraform apply -target=aws_iam_role_policy.exports` against prd",
        options: [
          { optionId: "opt-allow", kind: "allow_once", name: "Allow once" },
          { optionId: "opt-always", kind: "allow_always", name: "Always" },
          { optionId: "opt-deny", kind: "reject_once", name: "Deny" },
        ],
      },
    },
  });
  return events;
}

test.describe("agent tool timeline", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error("CONSOLE ERROR:", msg.text().slice(0, 400));
      }
    });
  });

  test("01 — long run, collapsed", async ({ page }) => {
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    const feedPanel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
    await seedObserverEvents(page, OBSERVER_AGENT_PUBKEY, longRunEvents());
    await expect(
      feedPanel.getByTestId("transcript-same-kind-summary").first(),
    ).toBeVisible({ timeout: 5_000 });
    await settleAnimations(feedPanel);
    await feedPanel.screenshot({ path: `${SHOTS}/01-long-run.png` });
  });

  test("02 — long run, burst expanded", async ({ page }) => {
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    const feedPanel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
    await seedObserverEvents(page, OBSERVER_AGENT_PUBKEY, longRunEvents());
    await feedPanel.evaluate((el) => {
      for (const details of el.querySelectorAll(
        "[data-testid='transcript-same-kind-summary']",
      )) {
        (details as HTMLDetailsElement).open = true;
      }
    });
    await page.waitForTimeout(300);
    await settleAnimations(feedPanel);
    await feedPanel.screenshot({ path: `${SHOTS}/02-burst-expanded.png` });
  });

  test("03 — waiting on the requester", async ({ page }) => {
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    const feedPanel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
    await seedObserverEvents(
      page,
      OBSERVER_AGENT_PUBKEY,
      pendingPermissionEvents(),
    );
    await expect(
      feedPanel.getByTestId("transcript-permission-item"),
    ).toBeVisible({ timeout: 5_000 });
    await settleAnimations(feedPanel);
    await feedPanel.screenshot({ path: `${SHOTS}/03-awaiting-approval.png` });
  });

  test("04 — long run, dark theme", async ({ page }) => {
    await seedTheme(page, "buzz-dark");
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    const feedPanel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
    await seedObserverEvents(page, OBSERVER_AGENT_PUBKEY, longRunEvents());
    await expect(
      feedPanel.getByTestId("transcript-same-kind-summary").first(),
    ).toBeVisible({ timeout: 5_000 });
    await settleAnimations(feedPanel);
    await feedPanel.screenshot({ path: `${SHOTS}/04-long-run-dark.png` });
  });

  test("05 — waiting on the requester, dark theme", async ({ page }) => {
    await seedTheme(page, "buzz-dark");
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    const feedPanel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
    await seedObserverEvents(
      page,
      OBSERVER_AGENT_PUBKEY,
      pendingPermissionEvents(),
    );
    await expect(
      feedPanel.getByTestId("transcript-permission-item"),
    ).toBeVisible({ timeout: 5_000 });
    await settleAnimations(feedPanel);
    await feedPanel.screenshot({
      path: `${SHOTS}/05-awaiting-approval-dark.png`,
    });
  });

  test("06 — long run at narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installMockBridge(page, { managedAgents: MANAGED_AGENTS });
    const feedPanel = await openObserverFeedPanel(page, OBSERVER_AGENT_PUBKEY);
    await seedObserverEvents(page, OBSERVER_AGENT_PUBKEY, longRunEvents());
    await expect(
      feedPanel.getByTestId("transcript-same-kind-summary").first(),
    ).toBeVisible({ timeout: 5_000 });
    await settleAnimations(feedPanel);
    await feedPanel.screenshot({ path: `${SHOTS}/06-long-run-narrow.png` });
  });
});
