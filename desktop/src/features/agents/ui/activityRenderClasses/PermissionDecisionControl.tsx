import { Check, Loader2, Octagon, ShieldCheck, X } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  isDenyIntent,
  orderPermissionOptions,
  permissionOptionAccessibleName,
  permissionOptionIntent,
  type PermissionOptionIntent,
} from "../agentPermissionDecision";
import type { PermissionOption } from "../agentSessionTypes";
import type { PermissionDecisionState } from "../useAgentPermissionDecisions";

const INTENT_ICON = {
  "allow-once": Check,
  "allow-always": ShieldCheck,
  "deny-once": X,
  "deny-always": X,
  unknown: ShieldCheck,
} as const satisfies Record<PermissionOptionIntent, typeof Check>;

/**
 * Button weight follows how far the answer reaches, not how affirmative it is.
 *
 * The narrow approval is the primary action because approving is the common
 * case and the direction this surface is allowed to lean fast in. The
 * *persistent* approval is deliberately quieter than the one-shot: it is the
 * most consequential button on the card, and a reader tapping through at speed
 * should land on `allow_once` by weight, never on `allow_always`.
 */
function variantForIntent(intent: PermissionOptionIntent) {
  if (intent === "allow-once") return "default" as const;
  if (isDenyIntent(intent)) return "destructive" as const;
  return "outline" as const;
}

export function PermissionDecisionControl({
  decision,
  disabled,
  onDecide,
  options,
  requestTitle,
}: {
  decision: PermissionDecisionState | undefined;
  disabled: boolean;
  onDecide: (option: PermissionOption) => void;
  options: readonly PermissionOption[];
  requestTitle: string;
}) {
  const ordered = orderPermissionOptions(options);
  if (ordered.length === 0) return null;

  const inFlight = decision?.status === "sending";
  const settled = decision?.status === "sent";

  return (
    // A fieldset rather than a div+role: these buttons are one set of mutually
    // exclusive answers to a single question, which is exactly what the element
    // means. Tailwind's preflight already strips its default chrome.
    <fieldset
      aria-label={`Answer: ${requestTitle}`}
      className="mt-2.5 flex flex-wrap items-center gap-1.5"
      data-testid="transcript-permission-actions"
    >
      {ordered.map((option) => {
        const intent = permissionOptionIntent(option);
        const Icon = INTENT_ICON[intent];
        const isChosen = decision?.optionId === option.optionId;
        const variant = variantForIntent(intent);
        return (
          <Button
            aria-label={permissionOptionAccessibleName(option, requestTitle)}
            className={cn(variant === "outline" && "text-foreground")}
            data-testid={`transcript-permission-option-${option.optionId}`}
            disabled={disabled || inFlight || settled}
            key={option.optionId}
            onClick={() => onDecide(option)}
            size="sm"
            type="button"
            variant={variant}
          >
            {isChosen && inFlight ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Icon aria-hidden="true" />
            )}
            {option.name}
          </Button>
        );
      })}
    </fieldset>
  );
}

/**
 * The interrupt, offered beside the answer rather than buried in the panel
 * menu.
 *
 * This is the one half of the decision that is fully connected today, and per
 * the cancellation contract it is not merely an escape hatch: stopping denies
 * any outstanding approval and *then* interrupts the turn. That makes it the
 * honest "no" on this card, which is why it sits next to the answer and reads
 * as an action rather than as a warning.
 */
export function PermissionStopControl({
  agentLabel,
  answersAvailable,
  disabled,
  onStop,
  requestTitle,
}: {
  agentLabel: string;
  /** Whether the reader also has real answer buttons on this card. */
  answersAvailable: boolean;
  disabled: boolean;
  onStop: () => void;
  requestTitle: string;
}) {
  // Beside a working Deny button, "Stop and deny" reads as a second, subtly
  // different denial and invites the reader to work out which one they want.
  // It only earns the stronger label when it is the *only* way to say no.
  const label = answersAvailable ? "Stop the turn" : "Stop and deny";
  return (
    <Button
      aria-label={`${label} — denies "${requestTitle}" and interrupts ${agentLabel}`}
      className="mt-2.5 text-foreground"
      data-testid="transcript-permission-stop"
      disabled={disabled}
      onClick={onStop}
      size="sm"
      title={`Denies this request and interrupts ${agentLabel}'s turn.`}
      type="button"
      variant="outline"
    >
      <Octagon aria-hidden="true" />
      {label}
    </Button>
  );
}

/** Icons carry the sending/sent/failed distinction alongside the copy. */
export function PermissionDecisionStatusLine({
  agentLabel,
  decision,
}: {
  agentLabel: string;
  decision: PermissionDecisionState;
}) {
  if (decision.status === "sending") {
    return (
      <p
        className="mt-1.5 flex items-center gap-1.5 leading-5 text-muted-foreground"
        data-testid="transcript-permission-decision-status"
      >
        <Loader2 aria-hidden="true" className="size-3 animate-spin" />
        Sending your answer…
      </p>
    );
  }

  if (decision.status === "sent") {
    // Not "Approved". The agent has not confirmed yet, and the resolved row
    // that replaces this block is what says the answer actually landed.
    return (
      <p
        className="mt-1.5 flex items-center gap-1.5 leading-5 text-muted-foreground"
        data-testid="transcript-permission-decision-status"
      >
        <Check aria-hidden="true" className="size-3" />
        Answer sent — waiting for {agentLabel} to confirm.
      </p>
    );
  }

  return (
    <p
      className="mt-1.5 flex items-start gap-1.5 font-medium leading-5 text-destructive"
      data-testid="transcript-permission-decision-status"
      role="alert"
    >
      <X aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0">
        Your answer did not reach {agentLabel}.
        {decision.message ? ` ${decision.message}` : null} Nothing was approved.
      </span>
    </p>
  );
}
