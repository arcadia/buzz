import type { TranscriptItem } from "./agentSessionTypes";

/**
 * What the foot of the transcript should claim.
 *
 * "Working" and "waiting on you" are different states with different owners,
 * and the liveness indicator used to animate through both — telling the
 * requester the agent was making progress while it was actually parked on a
 * decision only they can make. They get distinct feet.
 */
export type TranscriptTurnState = "idle" | "working" | "awaiting-approval";

type LifecycleItem = Extract<TranscriptItem, { type: "lifecycle" }>;

function isPermission(item: TranscriptItem): item is LifecycleItem {
  return item.type === "lifecycle" && item.renderClass === "permission";
}

/** A permission with no recorded outcome is still owed an answer. */
export function isUnresolvedPermission(item: TranscriptItem) {
  return isPermission(item) && !item.outcome;
}

/**
 * Scoped to the newest turn: a permission left unanswered in an older turn is
 * history, not a demand. Trailing status frames (usage, mode) can land after
 * the request, so this asks "does the current turn owe an answer" rather than
 * "is the request the last row".
 */
export function hasPendingApproval(items: TranscriptItem[]) {
  const last = items.at(-1);
  if (!last) return false;

  // The last row's own turn is the best scope, but trailing status frames and
  // archive-ingested events can arrive without one. Walk back for the newest
  // turn id rather than giving up on scoping: an unanswered request abandoned
  // in an old session would otherwise pin the foot to "awaiting approval"
  // forever, suppressing the liveness signal for every turn after it.
  const turnId = newestTurnId(items);
  if (turnId == null) {
    // Genuinely unscoped (no row anywhere carries a turn id). Fall back to the
    // newest permission row within the newest session, so the answer is still
    // about current work rather than about anything the transcript ever held.
    const sessionId = last.sessionId ?? null;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if ((item.sessionId ?? null) !== sessionId) break;
      if (isPermission(item)) return !item.outcome;
    }
    return false;
  }

  return items.some(
    (item) => item.turnId === turnId && isUnresolvedPermission(item),
  );
}

/** The turn id of the newest row that carries one. */
function newestTurnId(items: TranscriptItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const turnId = items[index].turnId;
    if (turnId) return turnId;
  }
  return null;
}

export function deriveTranscriptTurnState(
  items: TranscriptItem[],
  isTurnLive: boolean,
): TranscriptTurnState {
  if (hasPendingApproval(items)) return "awaiting-approval";
  return isTurnLive ? "working" : "idle";
}
