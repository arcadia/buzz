import * as React from "react";
import { CheckCheck } from "lucide-react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { cn } from "@/shared/lib/cn";
import { useProfilePanel } from "@/shared/context/ProfilePanelContext";
import { Markdown } from "@/shared/ui/markdown";
import { useAgentSessionTranscriptVariant } from "../agentSessionTranscriptContext";
import type { AgentActivityAction } from "../agentSessionTypes";
import { AgentByline } from "../activityRenderClasses/AgentByline";
import { MessageLinkHoverCue } from "../activityRenderClasses/MessageLinkHoverCue";
import { TranscriptTimestamp } from "../activityRenderClasses/TranscriptTimestamp";
import { useTranscriptBubbleOverflow } from "../activityRenderClasses/useTranscriptBubbleOverflow";
import { compactSummaryTone } from "./CompactToolSummaryRow";
import type { SentMessageLink } from "./messageLinks";
import { SentMessageContextDialog } from "./SentMessageContextDialog";
import { useSentMessageBody } from "./useSentMessageBody";

export function CompactMessageSummary({
  action,
  args,
  avatarUrl,
  description,
  displayName,
  duration,
  hasArgs,
  hasResult,
  isError,
  label,
  messageLink,
  preview,
  pubkey,
  result,
  timestamp,
}: {
  action: AgentActivityAction | null;
  args: Record<string, unknown>;
  avatarUrl: string | null;
  description?: string;
  displayName: string;
  duration: string | null;
  hasArgs: boolean;
  hasResult: boolean;
  isError: boolean;
  label: string;
  messageLink: SentMessageLink | null;
  preview: string | null;
  pubkey: string;
  result: string;
  timestamp: string;
}) {
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const resolvedContent = useSentMessageBody(messageLink, preview);
  const variant = useAgentSessionTranscriptVariant();
  const { goChannel } = useAppNavigation();
  const { openProfilePanel } = useProfilePanel();
  const isCompactPreview = variant === "compactPreview";
  const shouldClampBubble = !isCompactPreview;
  const [bubbleRef, hasBubbleOverflow] =
    useTranscriptBubbleOverflow(shouldClampBubble);
  const canOpenMessage = shouldClampBubble && messageLink !== null;
  const mutedTone = compactSummaryTone();
  // The classifier's verb reads as an event ("Sent message"), matching every
  // other verb on the timeline; the tool's own `label` ("Send Message") reads
  // as a capability the agent has rather than one it used. The action's object
  // is deliberately dropped: for a relay send it is the message content, which
  // is already the bubble directly below. This presenter only ever renders a
  // message send, so "message" is accurate by construction.
  const bylineDetail = action ? `${action.verb} message` : label;
  const handleBubbleClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!messageLink || isNestedInteractiveTarget(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void goChannel(messageLink.channelId, {
        messageId: messageLink.messageId,
      });
    },
    [goChannel, messageLink],
  );
  const handleBubbleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        !messageLink ||
        isNestedInteractiveTarget(event) ||
        (event.key !== "Enter" && event.key !== " ")
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void goChannel(messageLink.channelId, {
        messageId: messageLink.messageId,
      });
    },
    [goChannel, messageLink],
  );
  const bubbleLinkProps = canOpenMessage
    ? {
        onClick: handleBubbleClick,
        onKeyDown: handleBubbleKeyDown,
        role: "link" as const,
        tabIndex: 0,
      }
    : {};
  return (
    <>
      <div className="flex max-w-full flex-col items-start gap-1">
        {isCompactPreview ? null : (
          <AgentByline
            avatarUrl={avatarUrl}
            detail={bylineDetail}
            displayName={displayName}
            onOpenProfile={
              openProfilePanel ? () => openProfilePanel(pubkey) : null
            }
            testId="transcript-agent-sent-byline"
          />
        )}
        <div className="flex w-full min-w-0 flex-col items-start gap-1">
          <div
            className={cn(
              "w-full min-w-0 rounded-2xl border px-3 py-2 shadow-sm",
              isCompactPreview
                ? "text-xs leading-4"
                : "text-sm leading-relaxed",
              shouldClampBubble && "relative max-h-36 overflow-hidden",
              canOpenMessage &&
                "group/bubble cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isCompactPreview
                ? isError
                  ? "border-destructive/25 bg-destructive/10 text-destructive"
                  : "border-transparent bg-muted text-foreground"
                : isError
                  ? "border-destructive/25 bg-destructive/10 text-destructive"
                  : "border-transparent bg-muted text-foreground",
              canOpenMessage &&
                (isError ? "hover:bg-destructive/15" : "hover:bg-muted/90"),
            )}
            data-testid="transcript-tool-message-preview"
            ref={bubbleRef}
            {...bubbleLinkProps}
          >
            <Markdown
              className={isCompactPreview ? "text-xs leading-4" : "leading-5"}
              content={resolvedContent || "Message content unavailable."}
            />
            {hasBubbleOverflow ? (
              <span
                className={cn(
                  "pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-2xl bg-linear-to-b from-transparent",
                  isError
                    ? "to-destructive/10"
                    : isCompactPreview
                      ? "to-muted"
                      : "to-muted",
                )}
              />
            ) : null}
            {canOpenMessage ? <MessageLinkHoverCue /> : null}
          </div>
          <div className="inline-flex max-w-full items-center gap-1.5 px-1">
            <TranscriptTimestamp
              messageLink={messageLink}
              timestamp={timestamp}
            />
            <button
              aria-label="Show sent message context"
              className={cn(
                "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                mutedTone,
              )}
              data-testid="transcript-sent-message-context-button"
              onClick={() => setDetailsOpen(true)}
              title="Show sent message context"
              type="button"
            >
              <CheckCheck className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
      <SentMessageContextDialog
        args={args}
        description={description}
        duration={duration}
        hasArgs={hasArgs}
        hasResult={hasResult}
        isError={isError}
        label={label}
        onOpenChange={setDetailsOpen}
        open={detailsOpen}
        preview={preview}
        result={result}
      />
    </>
  );
}

function isNestedInteractiveTarget(
  event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
) {
  const target =
    event.target instanceof Element
      ? event.target.closest(
          "a,button,input,select,textarea,summary,[role='button'],[role='link']",
        )
      : null;

  return target !== null && target !== event.currentTarget;
}
