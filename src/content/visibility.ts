// Visibility test shared by every generation/stop signal. Sites keep many busy indicators
// mounted but hidden (display:none, zero size, aria-hidden, opacity 0), so a bare
// querySelector() hit must never count as "still generating".
// No runtime imports: this module is loaded directly by node tests.

export interface VisibilityStyle {
  display?: string;
  visibility?: string;
  opacity?: string;
}

export type StyleReader = (element: Element) => VisibilityStyle | null | undefined;

const MAX_ANCESTORS = 40;

function defaultStyle(element: Element): VisibilityStyle | null {
  const view = element.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return null;
  try {
    return view.getComputedStyle(element);
  } catch {
    return null;
  }
}

function hasBox(element: Element): boolean {
  const target = element as Element & {
    getBoundingClientRect?: () => { width: number; height: number };
    getClientRects?: () => { length: number };
  };
  if (typeof target.getClientRects === 'function' && target.getClientRects().length === 0) return false;
  if (typeof target.getBoundingClientRect === 'function') {
    const rect = target.getBoundingClientRect();
    if (!(rect.width > 0 || rect.height > 0)) return false;
  }
  return true;
}

/** True only for an element a person could actually see right now. */
export function isElementVisible(element: Element | null | undefined, readStyle: StyleReader = defaultStyle): boolean {
  if (!element) return false;
  if ((element as Node).isConnected === false) return false;
  let node: Element | null = element;
  for (let depth = 0; node && depth < MAX_ANCESTORS; depth += 1) {
    if (node.hasAttribute?.('hidden')) return false;
    if (node.getAttribute?.('aria-hidden') === 'true') return false;
    const style = readStyle(node);
    if (style) {
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (style.opacity !== undefined && style.opacity !== '' && Number(style.opacity) === 0) return false;
    }
    node = node.parentElement;
  }
  return hasBox(element);
}

export interface SignalMatch {
  selector: string;
  total: number;
  visible: number;
}

/** Per-selector match counts (all vs. visible), for diagnostics. */
export function selectorReport(
  selectors: readonly string[],
  root: ParentNode,
  isVisible: (element: Element) => boolean,
  filter: (element: Element) => boolean = () => true,
): SignalMatch[] {
  return selectors.map((selector) => {
    let matches: Element[] = [];
    try {
      matches = Array.from(root.querySelectorAll(selector)).filter(filter);
    } catch {
      matches = [];
    }
    return { selector, total: matches.length, visible: matches.filter(isVisible).length };
  });
}

/** The first selector with a visible (and accepted) match, or null. */
export function firstVisibleSelector(
  selectors: readonly string[],
  root: ParentNode,
  isVisible: (element: Element) => boolean,
  filter: (element: Element) => boolean = () => true,
): string | null {
  for (const selector of selectors) {
    let matches: Element[];
    try {
      matches = Array.from(root.querySelectorAll(selector));
    } catch {
      continue;
    }
    if (matches.some((element) => filter(element) && isVisible(element))) return selector;
  }
  return null;
}
