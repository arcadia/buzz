import { normalizePubkey } from "@/shared/lib/pubkey";
import type {
  AgentActivityTone,
  PermissionOption,
  TranscriptItem,
} from "./agentSessionTypes";

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
 * The channel token the reducer embeds in every transcript item id.
 *
 * Ids are built as `<kind>:<channel>:<rest>`, where `<channel>` is the channel
 * id or the literal "global" for an unscoped frame. Channel ids are UUIDs, so
 * the second segment is unambiguous.
 */
function itemChannelKey(itemId: string): string | null {
  const start = itemId.indexOf(":");
  if (start === -1) return null;
  const end = itemId.indexOf(":", start + 1);
  if (end === -1) return null;
  return itemId.slice(start + 1, end);
}

/**
 * The tool call this request is gating, when the frame names one.
 *
 * The request itself carries only a title and a message. The scope the reader
 * actually needs — the command, the path, the arguments — lives on the tool
 * row the harness already announced under the same `toolCallId`, so we join to
 * it rather than re-deriving anything from the request text.
 *
 * Anchored on the permission item's own channel, not just the call id.
 * Harnesses number tool calls per session (`p3`, `call_1`, `1`), so the same
 * id exists in every channel, and the unscoped panel holds every channel's
 * rows at once. An unanchored match handed the first one to the card, putting
 * another channel's command under "Show the exact command" — the one thing
 * that block exists to get right.
 */
export function findPermissionToolItem(
  items: readonly TranscriptItem[],
  toolCallId: string | null | undefined,
  permissionItemId: string,
): ToolItem | null {
  if (!toolCallId) return null;
  const channelKey = itemChannelKey(permissionItemId);
  if (!channelKey) return null;
  const toolItemId = `tool:${channelKey}:${toolCallId}`;
  for (const item of items) {
    if (item.type === "tool" && item.id === toolItemId) {
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
 * Turn id → the pubkey of whoever asked for that turn.
 *
 * Per the approval contract only the requester may answer, so the surface has
 * to be able to name them. The pubkey rides the turn's own user message
 * (`From: … hex:` on the prompt frame); there is no separate requester field
 * on the permission frame itself.
 *
 * A turn with no attributed user message is simply absent rather than falling
 * back to the first user message in the transcript — attributing a request to
 * the wrong person on a control that authorizes execution is worse than
 * declining to name anyone.
 *
 * Built once per transcript rather than searched per permission row: the
 * per-row search made requester resolution quadratic over a stream that grows
 * for as long as the agent runs.
 */
export function buildTurnRequesterIndex(
  items: readonly TranscriptItem[],
): ReadonlyMap<string, string> {
  const byTurn = new Map<string, string>();
  for (const item of items) {
    if (
      item.type !== "message" ||
      item.role !== "user" ||
      !item.turnId ||
      !item.authorPubkey ||
      byTurn.has(item.turnId)
    ) {
      continue;
    }
    byTurn.set(item.turnId, normalizePubkey(item.authorPubkey));
  }
  return byTurn;
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

/**
 * Whether the Stop control may be offered on a permission card.
 *
 * Stopping is the only way to answer when the buttons cannot be delivered, so
 * the card carries it — but `cancelManagedAgentTurn` names no turn: it
 * interrupts whatever the agent is doing *now*. Offering it on a card whose
 * turn has already ended would therefore kill an unrelated turn, so the gate
 * is the panel menu's gate exactly, `isWorking && canInterruptTurn`, plus the
 * channel scope a control frame needs to be addressed at all.
 */
export function canStopPermissionTurn({
  canInterruptTurn,
  hasChannelScope,
  isWorking,
}: {
  canInterruptTurn: boolean;
  hasChannelScope: boolean;
  isWorking: boolean;
}): boolean {
  return isWorking && canInterruptTurn && hasChannelScope;
}

/**
 * Why the requester is being shown no answer buttons, if they are not.
 *
 * Every path that withholds the control has to name its reason. Silence is
 * itself an answer here — the runtime denies a request nobody answers — so an
 * approval demand with no affordance and no explanation leaves the reader
 * with nothing to do and no way to find out why.
 *
 * `no-options` is the case where every option the frame offered arrived
 * without an `optionId` and was dropped as unanswerable. It used to render as
 * a bare demand: no buttons, no options line, and no unavailable copy either,
 * because the transport was fine.
 *
 * A non-requester needs nothing here — the block already names who the answer
 * belongs to.
 */
export function permissionUnavailableReason({
  canDecide,
  isRequester,
  optionCount,
}: {
  canDecide: boolean;
  isRequester: boolean;
  optionCount: number;
}): "transport" | "no-options" | null {
  if (!isRequester) return null;
  if (!canDecide) return "transport";
  if (optionCount === 0) return "no-options";
  return null;
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
