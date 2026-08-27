import {
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Markdown } from "@/shared/ui/markdown";
import { useAgentSessionTranscriptVariant } from "../agentSessionTranscriptContext";
import { formatTranscriptTimestampTitle } from "../agentSessionUtils";
import type { TranscriptItem } from "../agentSessionTypes";
import { AgentByline } from "./AgentByline";
import { ToolActivity } from "./ToolActivity";
import { TranscriptTimestamp } from "./TranscriptTimestamp";
import type {
  ActivityRenderClassItemProps,
  AgentTranscriptIdentityProps,
} from "./types";
import { UserMessageBubble } from "./UserMessageBubble";

export function MessageActivity(props: ActivityRenderClassItemProps) {
  if (props.item.type === "tool") {
    return <ToolActivity {...props} />;
  }
  if (props.item.type !== "message") {
    return null;
  }

  return (
    <MessageItem
      agentAvatarUrl={props.agentAvatarUrl}
      agentName={props.agentName}
      agentPubkey={props.agentPubkey}
      item={props.item}
      profiles={props.profiles}
    />
  );
}

function MessageItem({
  agentAvatarUrl,
  agentName,
  agentPubkey,
  item,
  profiles,
}: AgentTranscriptIdentityProps & {
  item: Extract<TranscriptItem, { type: "message" }>;
  profiles?: UserProfileLookup;
}) {
  const variant = useAgentSessionTranscriptVariant();
  const isCompactPreview = variant === "compactPreview";
  const isAssistant = item.role === "assistant";
  const text = item.text.trim();
  const messageLink = getTranscriptMessageLink(item);

  if (!isAssistant) {
    return (
      <UserMessageBubble
        footer={
          <TranscriptTimestamp
            messageLink={messageLink}
            timestamp={item.timestamp}
          />
        }
        item={item}
        profiles={profiles}
      />
    );
  }

  return (
    <div
      className="flex flex-row animate-in fade-in duration-200 motion-reduce:animate-none"
      data-role="assistant-message"
      data-testid="transcript-assistant-message"
    >
      <div className="group relative flex w-full min-w-0 flex-col items-start gap-1">
        {isCompactPreview ? null : (
          <AssistantByline
            agentAvatarUrl={agentAvatarUrl}
            agentName={agentName}
            agentPubkey={agentPubkey}
            profiles={profiles}
          />
        )}
        <div
          className={
            isCompactPreview
              ? "w-full min-w-0 text-xs leading-4"
              : "w-full min-w-0 text-sm"
          }
          title={formatTranscriptTimestampTitle(item.timestamp)}
        >
          <Markdown
            className={isCompactPreview ? "text-xs leading-4" : "leading-5"}
            content={text || " "}
          />
        </div>
      </div>
    </div>
  );
}

function AssistantByline({
  agentAvatarUrl,
  agentName,
  agentPubkey,
  profiles,
}: AgentTranscriptIdentityProps & { profiles?: UserProfileLookup }) {
  const profile = profiles?.[normalizePubkey(agentPubkey)] ?? null;
  return (
    <AgentByline
      avatarUrl={profile?.avatarUrl ?? agentAvatarUrl}
      displayName={resolveUserLabel({
        pubkey: agentPubkey,
        fallbackName: agentName,
        profiles,
        preferResolvedSelfLabel: true,
      })}
      testId="transcript-assistant-byline"
    />
  );
}

function getTranscriptMessageLink(
  item: Extract<TranscriptItem, { type: "message" }>,
) {
  if (!item.channelId || !item.messageId) return null;
  return {
    channelId: item.channelId,
    messageId: item.messageId,
  };
}
