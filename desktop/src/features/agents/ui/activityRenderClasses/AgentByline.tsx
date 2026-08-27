import { cn } from "@/shared/lib/cn";
import { UserAvatar } from "@/shared/ui/UserAvatar";

/**
 * Attribution for anything the agent produced as prose.
 *
 * Two rows on this surface render as message bubbles: the model's own reply,
 * and a relay `send_message` call. Both used to arrive as bare text — the
 * reply flush in the panel's body type, the sent message in a filled bubble
 * beside an avatar, which is the app's chat idiom exactly. Read on their own,
 * neither said a machine wrote it.
 *
 * The byline is the fix, and it is deliberately stated rather than implied by
 * layout: the name, the fact that the name belongs to an agent, and — for a
 * relay send — what the agent did with the text.
 */
export function AgentByline({
  avatarUrl,
  className,
  detail,
  displayName,
  onOpenProfile,
  testId,
}: {
  avatarUrl: string | null;
  className?: string;
  /** What the agent did with this text, when it is not simply a reply. */
  detail?: string | null;
  displayName: string;
  /** Keeps the avatar a profile ingress where the surface already had one. */
  onOpenProfile?: (() => void) | null;
  testId?: string;
}) {
  const avatar = (
    <UserAvatar
      avatarUrl={avatarUrl}
      className="size-4 shrink-0 text-3xs"
      displayName={displayName}
      size="sm"
      testId="transcript-agent-byline-avatar"
    />
  );

  return (
    <div
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      data-testid={testId}
    >
      {onOpenProfile ? (
        <button
          aria-label={`Open ${displayName} profile`}
          className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenProfile();
          }}
          type="button"
        >
          {avatar}
        </button>
      ) : (
        avatar
      )}
      <span className="min-w-0 truncate text-2xs font-semibold text-muted-foreground">
        {displayName}
      </span>
      <span className="shrink-0 rounded-full bg-muted px-1.5 pb-px pt-0.5 text-3xs font-semibold uppercase leading-none tracking-[0.14em] text-muted-foreground">
        agent
      </span>
      {detail ? (
        <span className="min-w-0 truncate text-2xs text-muted-foreground">
          · {detail}
        </span>
      ) : null}
    </div>
  );
}
