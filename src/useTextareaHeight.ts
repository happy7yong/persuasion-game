import { useLayoutEffect, type RefObject } from "react";

/** 한 줄에서 시작해 최대 두 줄까지만 늘어나는 입력창 높이. */
export function useTextareaHeight(ref: RefObject<HTMLTextAreaElement>, value: string) {
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const styles = window.getComputedStyle(textarea);
    const line = Number.parseFloat(styles.lineHeight);
    const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const maxHeight = line * 2 + verticalPadding;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [ref, value]);
}
