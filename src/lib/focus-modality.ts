/** Focus stays semantic; only its presentation follows the last input method. */
export function installFocusModality(document: Document) {
  const root = document.documentElement;
  const set = (value: "pointer" | "keyboard") => { root.dataset.inputModality = value; };
  let forwardedControl: EventTarget | null = null;
  let forwardingTimer: number | undefined;
  const clearForwarding = () => {
    forwardedControl = null;
    if (forwardingTimer !== undefined) document.defaultView?.clearTimeout(forwardingTimer);
    forwardingTimer = undefined;
  };
  const pointer = () => { clearForwarding(); set("pointer"); };
  const keyboard = (event: KeyboardEvent) => {
    if (!event.metaKey && !event.altKey && !event.ctrlKey && !["Shift", "Control", "Alt", "Meta"].includes(event.key)) { clearForwarding(); set("keyboard"); }
  };
  // Native assistive activation can have no preceding key/pointer event.
  // Scripted .click() calls must not reclassify a pointer-origin action.
  const activate = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const forwarded = event.detail === 0 && root.dataset.inputModality === "pointer" && event.target === forwardedControl;
    clearForwarding();
    if (forwarded) return;
    if (event.detail === 0) { set("keyboard"); return; }
    if (root.dataset.inputModality !== "pointer") return;
    const target = event.target as Element | null;
    const control = target?.closest?.<HTMLLabelElement>("label")?.control;
    // A native label activation may forward a trusted detail=0 click to its
    // control. Keep that one causal click pointer-origin, not all detail=0 clicks.
    if (control && control !== target) {
      forwardedControl = control;
      forwardingTimer = document.defaultView?.setTimeout(clearForwarding, 0);
    }
  };
  const reset = () => { clearForwarding(); delete root.dataset.inputModality; };
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
