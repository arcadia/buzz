import { ChevronDown } from "lucide-react";

import { formatCodeValue } from "../agentSessionUtils";
import { buildCompactToolSummary } from "../agentSessionToolSummary";
import { permissionConsequenceLine } from "../agentPermissionDecision";
import type { TranscriptItem } from "../agentSessionTypes";
import { ShellCommandBlock } from "../AgentSessionToolItem/ShellCommandBlock";

type ToolItem = Extract<TranscriptItem, { type: "tool" }>;

/**
 * What the reader is actually being asked to authorize.
 *
 * The request frame carries only a title and a sentence. The scope that
 * matters — the command, the path, the arguments — belongs to the tool call
 * the harness already announced, so this joins to that row rather than parsing
 * anything out of the request text a second time.
 *
 * Two audiences, one block. The consequence line is for a reader who cannot
 * parse a shell command and needs to know what approving *does*; the exact
 * command sits one interaction away for a reader who wants to check it. The
 * plain sentence is never a substitute for the command — it is the thing that
 * makes the command's absence survivable when the frame does not name a tool.
 */
export function PermissionRequestScope({
  toolCallId,
  toolItem,
}: {
  toolCallId: string | null;
  toolItem: ToolItem | null;
}) {
  if (!toolItem) {
    // Say which kind of blind spot this is rather than implying the request's
    // own sentence is the full scope. A frame that names no call and a frame
    // whose call has not arrived are different problems, and only the second
    // one might resolve on its own.
    return (
      <p
        className="mt-1 leading-5 text-muted-foreground"
        data-testid="transcript-permission-scope-unknown"
      >
        {toolCallId
          ? "Buzz has not seen the tool call this request names, so the exact command cannot be shown here."
          : "This request does not name a tool call, so the exact command cannot be shown here."}
      </p>
    );
  }

  const summary = buildCompactToolSummary(toolItem);
  const consequence = permissionConsequenceLine(summary.descriptor.tone);
  const shellCommand = summary.shellContent;
  const hasArgs = Object.keys(toolItem.args).length > 0;

  return (
    <div data-testid="transcript-permission-scope">
      {consequence ? (
        <p className="mt-1 leading-5 text-foreground">{consequence}</p>
      ) : (
        // The classifier declines to call an unrecognised call a read or a
        // write, and guessing on an approval control would be worse than
        // saying nothing. Name the uncertainty instead.
        <p className="mt-1 leading-5 text-foreground">
          Buzz cannot tell what this will change. Read the command before
          approving.
        </p>
      )}
      {shellCommand || hasArgs ? (
        // Collapsed is the right default when the consequence line already
        // answered "what does this do" — approving stays one tap. When it
        // could not, the copy tells the reader to read the command, so hiding
        // it behind a disclosure would be instructing them to do something and
        // then getting in the way.
        <details className="group mt-1.5" open={!consequence}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-2xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring">
            <ChevronDown
              aria-hidden="true"
              className="size-3 transition-transform group-open:rotate-180"
            />
            {shellCommand ? "Show the exact command" : "Show the parameters"}
          </summary>
          <div className="mt-1.5">
            {shellCommand ? (
              // No result yet — the whole point is that this has not run.
              <ShellCommandBlock command={shellCommand} result="" />
            ) : (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted/50 px-3 py-2 font-mono text-xs leading-5 text-foreground">
                {formatCodeValue(JSON.stringify(toolItem.args, null, 2))}
              </pre>
            )}
          </div>
        </details>
      ) : null}
    </div>
  );
}
