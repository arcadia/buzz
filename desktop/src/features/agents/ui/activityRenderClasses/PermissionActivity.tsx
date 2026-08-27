import { CheckCircle2, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import type { TranscriptItem } from "../agentSessionTypes";
import { ActivityRow, ActivityRowLabel } from "./ActivityRow";

type PermissionItem = Extract<TranscriptItem, { type: "lifecycle" }>;

/**
 * Split the permission item's text into the request description lines and the
 * options line.  The text is newline-joined by describePermissionRequest:
 *   [request title?] [toolCallId?] ["Options: ..."]
 * We surface the options line separately so the render can style it distinctly.
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
 * **Answered** is history. It collapses to an ordinary timeline row so a run
 * with a dozen resolved approvals does not read as a dozen open alarms — the
 * previous treatment kept every one of them in a full amber box forever.
 */
export function PermissionActivity({
  item,
  timestampTitle,
}: {
  item: PermissionItem;
  timestampTitle: string | undefined;
}) {
  const { requestLines, optionsLine } = splitPermissionText(item.text);
  const outcome = item.outcome;

  if (outcome) {
    return (
      <ResolvedPermissionRow
        outcome={outcome}
        requestLines={requestLines}
        timestampTitle={timestampTitle}
      />
    );
  }

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
          <p className="font-semibold">Waiting for your decision</p>
          <p className="mt-0.5 leading-5 text-foreground">
            {item.title}
            {requestLines ? ` · ${requestLines}` : null}
          </p>
          {optionsLine ? (
            <p className="mt-1 leading-5 opacity-70">{optionsLine}</p>
          ) : null}
          {/* Product truth, not a countdown: the runtime denies on timeout, and
              the frames carry no deadline we could honestly display. This is
              what makes the block time-sensitive, so it outranks the options
              line rather than fading below it. */}
          <p className="mt-1 font-medium leading-5">
            No answer denies this request.
          </p>
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
