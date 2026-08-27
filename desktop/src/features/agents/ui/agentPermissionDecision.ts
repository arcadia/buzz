import { normalizePubkey } from "@/shared/lib/pubkey";
import type {
  AgentActivityTone,
  PermissionOption,
  TranscriptItem,
} from "./agentSessionTypes";

type LifecycleItem = Extract<TranscriptItem, { type: "lifecycle" }>;
type ToolItem = Extract<TranscriptItem, { type: "tool" }>;

/**
 * What answering with a given option actually does.
 *
 * ACP names four kinds — `allow_once`, `allow_always`, `reject_once`,
 * `reject_always`. We classify on the `kind` prefix exactly as
 * `describePermissionOutcome` already does for the resolved label, so the
 * button that sends an answer and the row that reports it can never disagree
 * about which direction an option points.
 *
 * A kind we do not recognise stays `unknown` rather than being guessed into
 * allow or deny. On a control that authorizes execution, a mislabelled button
 * is the worst possible failure, so an unrecognised option renders neutrally
 * with its own wire name and no borrowed affirmative styling.
 */
export type PermissionOptionIntent =
  | "allow-once"
  | "allow-always"
  | "deny-once"
  | "deny-always"
  | "unknown";

export function permissionOptionIntent(
  option: PermissionOption,
): PermissionOptionIntent {
  const kind = option.kind?.toLowerCase() ?? "";
  const persistent = kind.endsWith("always");
  if (kind.startsWith("allow")) {
    return persistent ? "allow-always" : "allow-once";
  }
  if (kind.startsWith("reject")) {
    return persistent ? "deny-always" : "deny-once";
  }
  return "unknown";
}

export function isDenyIntent(intent: PermissionOptionIntent) {
  return intent === "deny-once" || intent === "deny-always";
}

export function isAllowIntent(intent: PermissionOptionIntent) {
  return intent === "allow-once" || intent === "allow-always";
}

const INTENT_ORDER: Record<PermissionOptionIntent, number> = {
  "allow-once": 0,
  "allow-always": 1,
  unknown: 2,
  "deny-once": 3,
  "deny-always": 4,
};

/**
 * Put the options in one fixed reading order regardless of the order the
 * harness happened to send them: the narrow approval first, the broad one
 * next, denial last.
 *
 * The wire order is the agent's, and it is not stable across harnesses. A
 * control whose buttons move between requests trains the muscle memory that
 * makes a wrong tap likely, which on this surface executes something real.
 */
export function orderPermissionOptions(
  options: readonly PermissionOption[],
): PermissionOption[] {
  return [...options].sort(
    (a, b) =>
      INTENT_ORDER[permissionOptionIntent(a)] -
      INTENT_ORDER[permissionOptionIntent(b)],
  );
}

/**
 * The tool call this request is gating, when the frame names one.
 *
 * The request itself carries only a title and a message. The scope the reader
 * actually needs — the command, the path, the arguments — lives on the tool
 * row the harness already announced under the same `toolCallId`, so we join to
 * it rather than re-deriving anything from the request text.
 */
export function findPermissionToolItem(
  items: readonly TranscriptItem[],
  toolCallId: string | null | undefined,
): ToolItem | null {
  if (!toolCallId) return null;
  for (const item of items) {
    if (item.type === "tool" && item.id.endsWith(`:${toolCallId}`)) {
      return item;
    }
  }
  return null;
}

/**
 * A plain-language line naming the consequence of approving, for a reader who
 * cannot read a shell command fluently.
 *
 * The tone comes from the tool classifier's descriptor — the single place that
 * decides what a call means — so this never becomes a rival source of truth
 * about what a tool does. A call whose descriptor carries no tone returns
 * null: a bare shell command genuinely can be either a read or a write, and
 * asserting one on an approval control would be worse than saying nothing.
 */
export function permissionConsequenceLine(
  tone: AgentActivityTone | undefined,
): string | null {
  switch (tone) {
    case "write":
      return "Approving lets it change files or data.";
    case "admin":
      return "Approving lets it change access or membership.";
    case "read":
      return "Approving lets it read data. It will not change anything.";
    default:
      return null;
  }
}

/**
 * Who asked for the turn this request belongs to.
 *
 * Per the approval contract only the requester may answer, so the surface has
 * to be able to name them. The pubkey rides the turn's own user message
 * (`From: … hex:` on the prompt frame); there is no separate requester field
 * on the permission frame itself.
 *
 * Falls back to null rather than to the first user message in the transcript —
 * attributing a request to the wrong person on a control that authorizes
 * execution is worse than declining to name anyone.
 */
export function findTurnRequesterPubkey(
  items: readonly TranscriptItem[],
  turnId: string | null | undefined,
): string | null {
  if (!turnId) return null;
  for (const item of items) {
    if (
      item.type === "message" &&
      item.role === "user" &&
      item.turnId === turnId &&
      item.authorPubkey
    ) {
      return normalizePubkey(item.authorPubkey);
    }
  }
  return null;
}

/**
 * Whether the viewer is the person this request is waiting on.
 *
 * Unknown on either side is **not** permission. A viewer whose identity has
 * not resolved, or a turn whose requester cannot be determined, reads as an
 * observer: the control is withheld and the block says who it is waiting on.
 * Failing open here would hand the answer to whoever happened to be looking.
 */
export function viewerIsRequester(
  requesterPubkey: string | null,
  viewerPubkey: string | null | undefined,
): boolean {
  if (!requesterPubkey || !viewerPubkey) return false;
  return requesterPubkey === normalizePubkey(viewerPubkey);
}

/** Stable key for one request's in-flight decision state. */
export function permissionDecisionKey(item: LifecycleItem): string {
  return item.id;
}

/**
 * The accessible name for one decision button.
 *
 * Screen-reader users get the option and the thing it applies to in one
 * string, because the visible button label ("Allow once") is meaningless on
 * its own and the request title sits several nodes away in the DOM.
 */
export function permissionOptionAccessibleName(
  option: PermissionOption,
  requestTitle: string,
): string {
  return `${option.name} — ${requestTitle}`;
}
