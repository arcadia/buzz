import { sendAgentObserverControl } from "@/shared/api/observerRelay";
import type { CancelManagedAgentTurnResult } from "@/shared/api/types";

/**
 * One answer to a pending `session/request_permission`.
 *
 * `requestId` is the JSON-RPC id of the request being answered — the harness
 * needs it to match the parked request, and it is what stops a stale click on
 * a request the agent has already resolved from landing on the next one.
 * `optionId` is copied verbatim from the request's own options; it is never
 * reconstructed from a `kind`, because the harness's own comment is emphatic
 * that option ids are not fixed strings.
 *
 * Declared beside its only sender rather than in `types.ts`, which is at its
 * ratcheted size ceiling.
 */
export type PermissionDecisionInput = {
  requestId: string;
  optionId: string;
};

export async function cancelManagedAgentTurn(
  pubkey: string,
  channelId: string,
): Promise<CancelManagedAgentTurnResult> {
  await sendAgentObserverControl(pubkey, {
    type: "cancel_turn",
    channelId,
  });
  return { status: "sent" };
}

/**
 * Send a live model-switch control frame to a running agent. The switch rides
 * the harness's cancel-switch-requeue path (busy turn) or invalidate-and-reapply
 * (idle); the outcome arrives asynchronously as a `control_result` observer
 * frame, not as the return value here. This is fire-and-forget on the send side.
 */
export async function switchManagedAgentModel(
  pubkey: string,
  channelId: string,
  modelId: string,
): Promise<void> {
  await sendAgentObserverControl(pubkey, {
    type: "switch_model",
    channelId,
    modelId,
  });
}

/**
 * Whether a permission decision can actually reach a running agent.
 *
 * **This is `false`, and it is not a feature flag — it is a statement of fact
 * about the harness.** `crates/buzz-acp/src/acp.rs` answers every
 * `session/request_permission` itself, synchronously inside its read loop
 * (`handle_permission_request`, auto-selecting `allow_once`), and its control
 * dispatch (`crates/buzz-acp/src/lib.rs`) matches exactly `cancel_turn` and
 * `switch_model` — every other frame type is debug-logged and dropped. A
 * `permission_decision` frame sent today would publish successfully to the
 * relay and then be silently ignored, which is the one failure this surface
 * must never present: a decision control that reports success and does
 * nothing.
 *
 * Flip this to `true` in the same change that lands the harness side (a defer
 * path in `handle_permission_request` plus a `permission_decision` arm beside
 * `cancel_turn`). Nothing else on the client needs to move: the owner-signed,
 * NIP-44 encrypted, replay-guarded control channel this rides is already
 * payload-agnostic end to end.
 */
const PERMISSION_DECISION_TRANSPORT_LANDED = false;

/**
 * The mock bridge implements the harness half, so the full control is
 * exercisable in specs. Mirrors `installE2eBridgeIfConfigured`'s posture: the
 * global alone is never enough — a production build cannot be talked into
 * enabling this by setting a window property.
 */
function isE2EBridgeActive() {
  if (!(import.meta.env.DEV || import.meta.env.MODE === "e2e")) {
    return false;
  }
  return Boolean((window as Window & { __BUZZ_E2E__?: unknown }).__BUZZ_E2E__);
}

export function canSendAgentPermissionDecision() {
  return PERMISSION_DECISION_TRANSPORT_LANDED || isE2EBridgeActive();
}

/**
 * Answer a pending `session/request_permission` on a running agent.
 *
 * Fire-and-forget on the send side, deliberately: the authoritative outcome is
 * the harness's own response, which arrives back through the observer stream
 * as the `acp_write` frame that stamps the request's resolved outcome. A
 * resolved return value here would let the UI claim an outcome the agent has
 * not confirmed.
 *
 * Throws rather than resolving when the transport is not connected, so a
 * caller that forgets to gate on `canSendAgentPermissionDecision` surfaces an
 * error instead of a false success.
 */
export async function sendAgentPermissionDecision(
  pubkey: string,
  channelId: string,
  decision: PermissionDecisionInput,
): Promise<void> {
  if (!canSendAgentPermissionDecision()) {
    throw new Error(
      "This build cannot deliver approvals to a running agent yet.",
    );
  }
  await sendAgentObserverControl(pubkey, {
    type: "permission_decision",
    channelId,
    requestId: decision.requestId,
    optionId: decision.optionId,
  });
}
