// Builds the per-tab part of the 诊断 report. Pure (DOM + injected helpers only) and free of
// runtime imports so node tests can load it directly.

export interface SelectorCount {
  selector: string;
  total: number;
  visible: number;
}

export interface DiagnosticSelectors {
  input: readonly string[];
  send: readonly string[];
  stop: readonly string[];
  thinking: readonly string[];
  response: readonly string[];
  userMessage: readonly string[];
}

export interface ContentDiagnosticInput {
  provider: string;
  root: Document;
  selectors: DiagnosticSelectors;
  isVisible: (element: Element) => boolean;
  generation: { active: boolean; signal: string | null };
  tracking: Record<string, unknown>;
  log: unknown[];
  blockSelectors?: readonly string[];
}

export interface MessageBlock {
  selector: string;
  tag: string;
  visible: boolean;
  text: string;
  outerHTML: string;
}

export interface ContentDiagnosticReport {
  provider: string;
  url: string;
  title: string;
  collectedAt: string;
  selectors: Record<keyof DiagnosticSelectors, SelectorCount[]>;
  generation: { active: boolean; signal: string | null };
  tracking: Record<string, unknown>;
  lastBlocks: MessageBlock[];
  log: unknown[];
}

export const BLOCK_HTML_LIMIT = 4000;
export const BLOCK_TEXT_LIMIT = 2000;

function count(selectors: readonly string[], root: ParentNode, isVisible: (element: Element) => boolean): SelectorCount[] {
  return selectors.map((selector) => {
    let matches: Element[] = [];
    try {
      matches = Array.from(root.querySelectorAll(selector));
    } catch {
      matches = [];
    }
    return { selector, total: matches.length, visible: matches.filter((element) => isVisible(element)).length };
  });
}

function cut(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…(+${value.length - limit} chars)` : value;
}

/** The last `limit` message-like blocks (outermost matches, document order). */
export function lastMessageBlocks(
  root: ParentNode,
  selectors: readonly string[],
  isVisible: (element: Element) => boolean,
  limit = 3,
): MessageBlock[] {
  const found: { element: Element; selector: string }[] = [];
  for (const selector of selectors) {
    let matches: Element[];
    try {
      matches = Array.from(root.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const element of matches) {
      if (!found.some((item) => item.element === element)) found.push({ element, selector });
    }
  }
  const outer = found.filter((item) => !found.some((other) => other.element !== item.element && Boolean(other.element.contains?.(item.element))));
  try {
    outer.sort((a, b) => (a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1));
  } catch {}
  return outer.slice(-limit).map(({ element, selector }) => ({
    selector,
    tag: String(element.tagName ?? '').toLowerCase(),
    visible: isVisible(element),
    text: cut((element.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), BLOCK_TEXT_LIMIT),
    outerHTML: cut(element.outerHTML ?? '', BLOCK_HTML_LIMIT),
  }));
}

export function collectContentDiagnostics(input: ContentDiagnosticInput, now = new Date()): ContentDiagnosticReport {
  const { root, selectors, isVisible } = input;
  const view = root.defaultView;
  const blockSelectors = input.blockSelectors ?? [...selectors.userMessage, ...selectors.response];
  return {
    provider: input.provider,
    url: view?.location?.href ?? '',
    title: root.title ?? '',
    collectedAt: now.toISOString(),
    selectors: {
      input: count(selectors.input, root, isVisible),
      send: count(selectors.send, root, isVisible),
      stop: count(selectors.stop, root, isVisible),
      thinking: count(selectors.thinking, root, isVisible),
      response: count(selectors.response, root, isVisible),
      userMessage: count(selectors.userMessage, root, isVisible),
    },
    generation: input.generation,
    tracking: input.tracking,
    lastBlocks: lastMessageBlocks(root, blockSelectors, isVisible),
    log: input.log,
  };
}
