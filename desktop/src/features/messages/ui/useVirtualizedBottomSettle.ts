import * as React from "react";
import type { VListHandle } from "virtua";

const SCROLL_INTENT_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}

export function useVirtualizedBottomSettle(
  hostRef: React.RefObject<HTMLDivElement | null>,
  listRef: React.RefObject<VListHandle | null>,
  itemsLengthRef: React.RefObject<number>,
) {
  const bottomIntentRef = React.useRef(false);
  const frameRef = React.useRef<number | null>(null);

  const cancelFrame = React.useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const cancel = React.useCallback(() => {
    bottomIntentRef.current = false;
    cancelFrame();
  }, [cancelFrame]);

  const pinToBottom = React.useCallback(() => {
    if (!bottomIntentRef.current) return;
    const scroller = hostRef.current?.firstElementChild;
    const lastIndex = itemsLengthRef.current - 1;
    if (!(scroller instanceof HTMLDivElement) || lastIndex < 0) return;
    listRef.current?.scrollToIndex(lastIndex, { align: "end" });
  }, [hostRef, itemsLengthRef, listRef]);

  const schedulePinToBottom = React.useCallback(() => {
    if (!bottomIntentRef.current || frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      pinToBottom();
    });
  }, [pinToBottom]);

  React.useLayoutEffect(() => {
    const scroller = hostRef.current?.firstElementChild;
    if (!(scroller instanceof HTMLDivElement)) return;
    const retire = () => cancel();
    const retireForScrollKey = (event: KeyboardEvent) => {
      if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !isEditableKeyboardTarget(event.target) &&
        SCROLL_INTENT_KEYS.has(event.key)
      ) {
        cancel();
      }
    };
    scroller.addEventListener("pointerdown", retire, { passive: true });
    scroller.addEventListener("touchstart", retire, { passive: true });
    scroller.addEventListener("wheel", retire, { passive: true });
    window.addEventListener("keydown", retireForScrollKey, true);
    return () => {
      scroller.removeEventListener("pointerdown", retire);
      scroller.removeEventListener("touchstart", retire);
      scroller.removeEventListener("wheel", retire);
      window.removeEventListener("keydown", retireForScrollKey, true);
    };
  }, [cancel, hostRef]);

  React.useLayoutEffect(() => {
    const scroller = hostRef.current?.firstElementChild;
    if (!(scroller instanceof HTMLDivElement)) return;
    const content = scroller.firstElementChild;
    if (
      !(content instanceof HTMLElement) ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    // Virtua updates this inner element's extent whenever measured row geometry
    // changes. Bottom intent therefore follows the physical floor for as long
    // as it remains active, rather than guessing that layout is done after an
    // arbitrary timeout. Reader input and explicit target/prepend navigation
    // retire the intent through `cancel`.
    const observer = new ResizeObserver(schedulePinToBottom);
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [hostRef, schedulePinToBottom]);

  const settle = React.useCallback(() => {
    bottomIntentRef.current = true;
    cancelFrame();
    pinToBottom();
  }, [cancelFrame, pinToBottom]);

  React.useEffect(() => cancel, [cancel]);
  return { cancel, settle };
}
