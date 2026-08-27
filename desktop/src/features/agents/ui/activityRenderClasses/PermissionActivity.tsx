import { CheckCircle2, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";

import { resolveUserLabel } from "@/features/profile/lib/identity";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { cn } from "@/shared/lib/cn";
import { PubKey } from "@/shared/ui/PubKey";
import {
  orderPermissionOptions,
  viewerIsRequester,
} from "../agentPermissionDecision";
import type { TranscriptItem } from "../agentSessionTypes";
import { useAgentPermissionDecisionContext } from "../useAgentPermissionDecisions";
import { ActivityRow, ActivityRowLabel } from "./ActivityRow";
import {
  PermissionDecisionControl,
  PermissionDecisionStatusLine,
  PermissionStopControl,
} from "./PermissionDecisionControl";
import { PermissionRequestScope } from "./PermissionRequestScope";

type PermissionItem = Extract<TranscriptItem, { type: "lifecycle" }>;

/**
 * Split the permission item's text into the request description lines and the
 * options line.  The text is newline-joined by describePermissionRequest:
 *   [request title?] [toolCallId?] ["Options: ..."]
 * We surface the options line separately so the render can style it distinctly
 * — and so it can be dropped entirely once the options are offered as buttons,
 * where restating them as prose would just be noise.
 */
export function splitPermissionText(text: string): {
  requestLines: string;
  optionsLine: string | null;
} {
  const lines = text.split("\n");
  const optionsIdx = lines.findIndex((l) => l.startsWith("Options: "));
  if (optionsIdx === -1) {
    return { requestLines: text, optionsLine: null };
  }
  return {
    requestLines: lines.slice(0, optionsIdx).join("\n"),
    optionsLine: lines[optionsIdx],
  };
}

/**
 * Derive the visual tone and icon for a resolved permission outcome string.
 * Outcome strings come from describePermissionOutcome:
 *   "Approved (...)" | "Denied (...)" | "Cancelled"
 */
export function permissionOutcomeTone(
  outcome: string,
): "approve" | "deny" | "cancel" {
  if (outcome.startsWith("Approved")) return "approve";
  if (outcome.startsWith("Denied")) return "deny";
  return "cancel";
}

/**
 * A permission request, in the two states that read completely differently.
 *
 * **Unanswered** is a demand on the person reading, not a log line: the agent
 * has stopped, and staying silent is itself a decision — the request expires
 * into a denial. It gets the surface's only warning-toned block, a breathing
 * mark, and copy that names the consequence.
 *
 * It is also the highest-stakes control in the product, so the block answers
 * three questions before it offers a button: what will run, who is allowed to
 * answer, and what happens if nobody does. Only the requester gets the buttons
 * — a non-requester sees the same request and is told whose answer it is
 * waiting on, rather than a live-looking control that would refuse them.
 *
 * **Answered** is history. It collapses to an ordinary timeline row so a run
 * with a dozen resolved approvals does not read as a dozen open alarms — the
 * previous treatment kept every one of them in a full amber box forever.
 */
export function PermissionActivity({
  agentName,
  item,
  profiles,
  timestampTitle,
}: {
  agentName: string;
  item: PermissionItem;
  profiles: UserProfileLookup | undefined;
  timestampTitle: string | undefined;
}) {
  const { requestLines, optionsLine } = splitPermissionText(item.text);
  const outcome = item.outcome;
  const {
    canDecide,
    decide,
    decisions,
    requesterByItemId,
    stopTurn,
    toolByItemId,
    viewerPubkey,
  } = useAgentPermissionDecisionContext();

  if (outcome) {
    return (
      <ResolvedPermissionRow
        outcome={outcome}
        requestLines={requestLines}
        timestampTitle={timestampTitle}
      />
    );
  }

  const requesterPubkey = requesterByItemId.get(item.id) ?? null;
  const isRequester = viewerIsRequester(requesterPubkey, viewerPubkey);
  const requesterLabel = requesterPubkey
    ? resolveUserLabel({ pubkey: requesterPubkey, profiles })
    : null;
  const decision = decisions.get(item.id);
  const options = item.permission?.options ?? [];
  const showButtons = isRequester && canDecide && options.length > 0;
  // The request's own words, not the reducer's row label. `item.title` is the
  // constant "Permission requested", which is what the headline above already
  // says — repeating it here pushed the thing being authorized into a
  // subordinate clause.
  const requestTitle = requestLines || item.title;

  const headline = isRequester
    ? "Waiting for your decision"
    : requesterLabel
      ? `Waiting on ${requesterLabel}`
      : "Waiting for a decision";

  return (
    <div
      className="rounded-md border border-warning/40 bg-warning-bg px-2.5 py-2 text-left text-xs text-warning"
      data-testid="transcript-permission-item"
      title={timestampTitle}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert
          aria-hidden="true"
          className="buzz-activity-await mt-px size-4 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p
            className="font-semibold"
            data-testid="transcript-permission-headline"
          >
            {headline}
          </p>
          {!isRequester && requesterPubkey ? (
            // A display name is forgeable — vanity grinding buys any name — and
            // this row decides who is allowed to authorize execution. The key
            // travels with the name so the reader can tell two "Morgan"s apart.
            <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1 leading-5 text-muted-foreground">
              <span>Only {requesterLabel} can answer this.</span>
              <PubKey
                className="text-2xs"
                pubkey={requesterPubkey}
                testId="transcript-permission-requester-pubkey"
              />
            </p>
          ) : null}
          <p className="mt-0.5 font-medium leading-5 text-foreground">
            {requestTitle}
          </p>
          <PermissionRequestScope
            toolCallId={item.permission?.toolCallId ?? null}
            toolItem={toolByItemId.get(item.id) ?? null}
          />
          {optionsLine && !showButtons ? (
            // Same fixed reading order the buttons use, rather than the wire
            // order — the two must never disagree about which answer is which.
            <p className="mt-1 leading-5 opacity-70">
              {options.length > 0
                ? `Options: ${orderPermissionOptions(options)
                    .map((option) => option.name)
                    .join(", ")}`
                : optionsLine}
            </p>
          ) : null}
          {/* Product truth, not a countdown: the runtime denies on timeout, and
              the frames carry no deadline we could honestly display. This is
              what makes the block time-sensitive, so it outranks the options
              line rather than fading below it. */}
          <p className="mt-1 font-medium leading-5">
            No answer denies this request.
          </p>
          {decision ? (
            <PermissionDecisionStatusLine
              agentLabel={agentName}
              decision={decision}
            />
          ) : null}
          {showButtons ? (
            <PermissionDecisionControl
              decision={decision}
              disabled={false}
              onDecide={(option) =>
                decide(item.id, item.permission?.requestId ?? null, option)
              }
              options={options}
              requestTitle={requestTitle}
            />
          ) : null}
          {isRequester && !canDecide ? (
            <p
              className="mt-1.5 leading-5 text-muted-foreground"
              data-testid="transcript-permission-unavailable"
            >
              Answering from Buzz is not available for this agent yet
              {stopTurn ? ", but stopping the turn denies the request" : null}.
            </p>
          ) : null}
          {stopTurn ? (
            <PermissionStopControl
              agentLabel={agentName}
              answersAvailable={showButtons}
              // Never disabled while an answer is in flight: a send that hangs
              // is exactly when the reader needs the interrupt, and it is the
              // one control here whose transport is fully connected.
              disabled={false}
              requestTitle={requestTitle}
              onStop={stopTurn}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ResolvedPermissionRow({
  outcome,
  requestLines,
  timestampTitle,
}: {
  outcome: string;
  requestLines: string;
  timestampTitle: string | undefined;
}) {
  const tone = permissionOutcomeTone(outcome);
  const Icon =
    tone === "approve" ? CheckCircle2 : tone === "deny" ? XCircle : ShieldCheck;

  return (
    <ActivityRow
      state={{ state: "done", tone: tone === "approve" ? "admin" : "neutral" }}
      testId="transcript-permission-item"
      title={timestampTitle}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0",
          tone === "approve"
            ? "text-status-added"
            : tone === "deny"
              ? "text-destructive"
              : "text-muted-foreground",
        )}
      />
      <ActivityRowLabel
        object={requestLines || undefined}
        openToneScope="none"
        testId="transcript-permission-outcome"
        verb={outcome}
      />
    </ActivityRow>
  );
}
