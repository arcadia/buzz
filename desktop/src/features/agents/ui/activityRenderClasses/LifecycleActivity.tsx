import { AlertCircle } from "lucide-react";

import { formatTranscriptTimestampTitle } from "../agentSessionUtils";
import { ActivityRow, ActivityRowLabel } from "./ActivityRow";
import { PermissionActivity } from "./PermissionActivity";
import { ToolActivity } from "./ToolActivity";
import type { ActivityRenderClassItemProps } from "./types";

export function LifecycleActivity(props: ActivityRenderClassItemProps) {
  if (props.item.type === "tool") {
    return <ToolActivity {...props} />;
  }
  if (props.item.type !== "lifecycle") {
    return null;
  }

  const isError =
    props.item.renderClass === "error" ||
    props.item.title.toLowerCase().includes("error");
  const timestampTitle = formatTranscriptTimestampTitle(props.item.timestamp);

  if (props.item.renderClass === "permission") {
    return (
      <PermissionActivity item={props.item} timestampTitle={timestampTitle} />
    );
  }

  if (isError) {
    return (
      <div
        className="rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-left text-xs text-destructive"
        data-testid="transcript-lifecycle-item"
        title={timestampTitle}
      >
        <div className="flex items-start gap-2">
          <AlertCircle aria-hidden="true" className="mt-px size-4 shrink-0" />
          <p className="min-w-0 flex-1 leading-5">
            <span className="font-semibold">{props.item.title}</span>
            {props.item.text ? (
              <span className="text-foreground"> · {props.item.text}</span>
            ) : null}
          </p>
        </div>
      </div>
    );
  }

  return (
    <ActivityRow testId="transcript-lifecycle-item" title={timestampTitle}>
      <ActivityRowLabel
        object={props.item.text || undefined}
        openToneScope="none"
        verb={props.item.title}
      />
    </ActivityRow>
  );
}
