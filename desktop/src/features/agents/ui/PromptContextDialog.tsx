import { CheckCheck } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import type { PromptSection, TranscriptItem } from "./agentSessionTypes";
import {
  formatTurnSetupLabel,
  turnSetupDetail,
} from "./agentSessionTranscriptGrouping";
import { PromptSectionList as PromptContextSections } from "./PromptSectionAccordion";

export function PromptContextDialog({
  onOpenChange,
  open,
  sections,
  setup,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  sections: PromptSection[];
  setup: Extract<TranscriptItem, { type: "lifecycle" }>[];
}) {
  if (!open || sections.length === 0) {
    return null;
  }

  const setupText = formatPromptSetupSummary(setup);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <div className="flex max-h-[85vh] flex-col">
          <DialogHeader className="px-6 pb-3 pt-5 pr-14">
            <DialogTitle>Prompt context</DialogTitle>
            {setupText ? (
              <div className="flex items-center gap-1.5">
                <CheckCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <DialogDescription>{setupText}</DialogDescription>
              </div>
            ) : null}
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2">
            <PromptContextSections sections={sections} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function formatPromptSetupSummary(
  items: Extract<TranscriptItem, { type: "lifecycle" }>[],
) {
  const label = formatTurnSetupLabel(items);
  const detail = turnSetupDetail(items);
  return [label, detail].filter(Boolean).join(" · ");
}
