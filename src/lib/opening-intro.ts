/** Fresh home and survey entries only; never a question-step or history replay. */
export type OpeningContext = {
  href: string;
  navigationHref: string | undefined;
  navigationType: string | undefined;
  reducedMotion: boolean;
  visible: boolean;
  alreadyPlayed: boolean;
};

export function shouldShowOpening(context: OpeningContext): boolean {
  if (context.reducedMotion || !context.visible || context.alreadyPlayed) return false;
  if (context.navigationType !== "navigate" && context.navigationType !== "reload") return false;
  try {
    const current = new URL(context.href);
    const initial = new URL(context.navigationHref ?? "");
    if (current.origin !== initial.origin || current.pathname !== initial.pathname) return false;
    // These are the four questionnaire slugs in reconstructed survey C3.
    // Survey links may carry campaign parameters or an anchor without losing the intro.
    const surveyEntry = /^\/survey(?:\/(?:consumer|consumer-interview|business-interview|vendor-interview))?\/?$/.test(current.pathname);
    if (surveyEntry) return true;
    return current.pathname === "/" && !current.search && !current.hash &&
      !initial.search && !initial.hash;
  } catch {
    return false;
  }
}
