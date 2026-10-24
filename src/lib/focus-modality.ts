/** Focus stays semantic; only its presentation follows the last input method. */
export function installFocusModality(document: Document) {
  const root = document.documentElement;
  const set = (value: "pointer" | "keyboard") => { root.dataset.inputModality = value; };
  const pointer = () => set("pointer");
  const keyboard = (event: KeyboardEvent) => {
    if (!event.metaKey && !event.altKey && !event.ctrlKey && !["Shift", "Control", "Alt", "Meta"].includes(event.key)) set("keyboard");
  };
  // Native assistive activation can have no preceding key/pointer event.
  // Scripted .click() calls must not reclassify a pointer-origin action.
  const activate = (event: MouseEvent) => { if (event.isTrusted && event.detail === 0) set("keyboard"); };
  const reset = () => { delete root.dataset.inputModality; };
  // Browser-chrome keys may never reach this document. Return to native focus.
  document.defaultView?.addEventListener("blur", reset);
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", keyboard, true);
  document.addEventListener("click", activate, true);
  return () => {
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("keydown", keyboard, true);
    document.removeEventListener("click", activate, true);
    document.defaultView?.removeEventListener("blur", reset);
    reset();
  };
}
