// Provider-agnostic reply detection, used when a site's specific selectors stop matching.
//
// Strategy: find the user's own message (the newest bubble that loosely matches the text we
// sent), then read whatever conversation content follows it. Completion is decided by the
// caller (no visible Stop control + text unchanged for a stability window).

export const GENERIC_USER_MESSAGE_SELECTORS = [
  '[data-testid="user-message"]',
  '[data-message-author-role="user"]',
  '[data-testid*="user-message"]',
  'user-query',
  '[class*="user-message"]',
  '[class*="user-query"]',
  '[class*="items-end"] .message-bubble',
  '.flex-row-reverse .message-bubble',
];

// Never treat these as part of a reply: the composer, navigation chrome, hidden helpers.
const EXCLUDED_REGION = 'form, textarea, [contenteditable="true"], nav, header, footer, aside, [role="navigation"], [aria-hidden="true"]';
// Do not climb past the conversation container while looking for content after the echo.
const CONVERSATION_BOUNDARY = 'main, [role="main"], body';

const STOP_LABEL = /\bstop\b|停止|中止|终止|終止|중지|anhalten|stopp|arrêter|detener|stop response|stop generating/i;
// Most stop buttons sit next to the composer. Only count buttons near a text input so an
// unrelated "Stop" (e.g. voice playback) elsewhere on the page does not look like generation.
export function isGenericStopButton(button: Element): boolean {
  const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${button.getAttribute('data-testid') ?? ''}`;
  if (!STOP_LABEL.test(label) && !/stop/i.test(button.getAttribute('data-testid') ?? '')) return false;
  const area = button.closest('form, [class*="composer"], [class*="query-bar"], [class*="input"]');
  return Boolean(area?.querySelector('textarea, [contenteditable="true"]')) || /stop/i.test(button.getAttribute('data-testid') ?? '');
}

export function promptKey(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[^\r\n]*[\r\n]?/g, '')
    .toLowerCase()
    // Rendered Markdown drops list numbers, bullets, emphasis and punctuation.
    .replace(/[\p{P}\p{S}\s\d]+/gu, '');
}

const LONG_PROMPT_KEY = 40;
const SHORT_PROMPT_KEY = 12;
const TAIL_KEY = 30;
const LABEL_ALLOWANCE = 24;

// Assistant-message containers across providers, used to spot "a new reply element appeared
// after we sent" when the provider-specific selectors miss.
export const GENERIC_RESPONSE_SELECTORS = [
  'model-response',
  '.model-response-text',
  'message-content',
  '[data-message-author-role="assistant"]',
  '[data-testid="assistant-message"]',
  '[data-testid*="assistant"]',
  '.font-claude-response',
  '.font-claude-message',
  '[data-is-streaming]',
  '[class*="assistant-message"]',
  '[class*="model-response"]',
  '[class*="items-start"] .message-bubble',
];

/**
 * True when a rendered user bubble shows the prompt we sent. Short prompts must match
 * exactly (after normalization); long prompts only need their opening to appear, because
 * sites render Markdown, fold long messages ("Show more") or add labels.
 */
export function looseMatchesPrompt(content: string, prompt: string): boolean {
  const actual = promptKey(content);
  const expected = promptKey(prompt);
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  // Sites prefix the bubble with a short label ("You said", "你说", "Edited") and collapse
  // newlines; the normalized key still contains the whole prompt.
  if (expected.length >= SHORT_PROMPT_KEY && actual.includes(expected) && actual.length <= expected.length + LABEL_ALLOWANCE) return true;
  if (expected.length <= LONG_PROMPT_KEY) return false;
  // A distinctive tail (the human's actual words usually end the relayed prompt).
  if (actual.includes(expected.slice(-TAIL_KEY))) return true;
  const head = expected.slice(0, LONG_PROMPT_KEY);
  if (actual.includes(head)) return true;
  // A folded bubble may show only the beginning of the prompt.
  return actual.length >= LONG_PROMPT_KEY && expected.startsWith(actual.slice(0, LONG_PROMPT_KEY));
}

const NOISE_LINES: RegExp[] = [
  /^(thought for|thinking|reasoned for|searching|searched|思考了|已思考|已深度思考|深度思考中|思考中|正在思考|正在搜索|已搜索)\b.{0,60}$/i,
  /^(thought for|reasoned for)\s.*$/i,
  /^(思考了|已思考|已深度思考)(\s|$|\d|（).{0,40}$/,
  /^(copy|copied|copy code|edit|share|retry|regenerate|like|dislike|read aloud|more|show more|show less|good response|bad response|复制|已复制|复制代码|编辑|分享|重试|重新生成|朗读|更多|显示更多|收起|赞|踩)$/i,
  /^\d+(\.\d+)?\s*(s|sec|secs|seconds|秒)$/i,
  // Grok's reasoning header in its zh UIs ("運作了12s", "任職於 2s") and English ("Worked for 8s").
  /^(運作了|运作了|运行了|運行了|任職於|任职于|worked for|已推理|推理了|已运行)\s*\d+(\.\d+)?\s*(s|秒|m|分钟|分鐘|min)?$/i,
  /^\d+\s*\/\s*\d+$/,
  /^(grok|chatgpt|claude|gemini|meta ai)\s+(can|may)\s+make mistakes.*$/i,
];

/** Remove UI chrome (buttons, "Thought for 12s", copy/regenerate labels) from extracted text. */
export function cleanReplyText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    return !NOISE_LINES.some((pattern) => pattern.test(trimmed));
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface GenericReplyOptions {
  prompt: string;
  userSelectors: readonly string[];
  responseSelectors?: readonly string[];
  readText: (element: Element) => string | null;
}

function isExcluded(element: Element): boolean {
  return Boolean(element.matches?.(EXCLUDED_REGION) || element.closest?.(EXCLUDED_REGION) || element.querySelector?.('textarea, [contenteditable="true"]'));
}

/** Every element currently showing the prompt we sent (outermost user containers). */
export function collectPromptEchoes(root: ParentNode, options: Pick<GenericReplyOptions, 'prompt' | 'userSelectors'>): Set<Element> {
  const found = new Set<Element>();
  const selectors = [...new Set([...options.userSelectors, ...GENERIC_USER_MESSAGE_SELECTORS])];
  for (const element of Array.from(root.querySelectorAll(selectors.join(', ')))) {
    if (element.closest('form, [contenteditable="true"]')) continue;
    if (looseMatchesPrompt(element.textContent ?? '', options.prompt)) found.add(outermostUserContainer(element, selectors));
  }
  const textHit = findPromptEcho(root, options);
  if (textHit) found.add(textHit);
  return found;
}

/**
 * The newest element showing the prompt we sent (our own message in the conversation).
 * `skip` holds echoes that already existed before sending, so re-sending the same text in an
 * already-used chat never anchors on the old copy.
 */
export function findPromptEcho(
  root: ParentNode,
  options: Pick<GenericReplyOptions, 'prompt' | 'userSelectors'> & { skip?: ReadonlySet<Element> },
): Element | null {
  const skip = options.skip;
  const skipped = (element: Element) => Boolean(skip?.size && Array.from(skip).some((old) => old === element || old.contains(element) || element.contains(old)));
  const selectors = [...new Set([...options.userSelectors, ...GENERIC_USER_MESSAGE_SELECTORS])];
  const candidates = Array.from(root.querySelectorAll(selectors.join(', ')))
    .filter((element) => !element.closest('form, [contenteditable="true"]'));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (!looseMatchesPrompt(candidates[index].textContent ?? '', options.prompt)) continue;
    const echo = outermostUserContainer(candidates[index], selectors);
    if (skipped(echo)) return null; // the newest copy is the old one: ours has not appeared yet
    return echo;
  }
  // No recognizable user bubble: search the page text for the prompt itself.
  const expected = promptKey(options.prompt);
  if (!expected) return null;
  const head = expected.slice(0, LONG_PROMPT_KEY);
  const blocks = Array.from(root.querySelectorAll('p, div, span, pre, li, article, section'));
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const element = blocks[index];
    const raw = element.textContent ?? '';
    if (raw.length < Math.min(head.length, 4) || raw.length > options.prompt.length * 4 + 4000) continue;
    if (element.closest('form, [contenteditable="true"], textarea')) continue;
    const key = promptKey(raw);
    if (key.includes(head) || (key.length >= LONG_PROMPT_KEY && expected.startsWith(key.slice(0, LONG_PROMPT_KEY)))) {
      return skipped(element) ? null : element;
    }
  }
  return null;
}

/** Climb to the outermost user-message container, so the rest of our own bubble (expand
 * buttons, the full text next to a screen-reader summary) is never read as the reply. */
function outermostUserContainer(element: Element, selectors: readonly string[]): Element {
  let current = element;
  for (let depth = 0; depth < 20; depth += 1) {
    let parent: Element | null = null;
    for (const selector of selectors) {
      try {
        const match = current.parentElement?.closest(selector) ?? null;
        if (match && (!parent || match.contains(parent))) parent = match;
      } catch {}
    }
    if (!parent || parent.closest('form, [contenteditable="true"]')) break;
    current = parent;
  }
  return current;
}

/** True when `text` is (part of) the prompt we sent, i.e. our own echo, not a reply. */
export function isEchoOfPrompt(text: string, prompt: string): boolean {
  const key = promptKey(text);
  const expected = promptKey(prompt);
  if (!key || !expected) return false;
  return looseMatchesPrompt(text, prompt) || (key.length >= 6 && expected.includes(key));
}

const FOLLOWING = 4;
const CONTAINS = 8;

function follows(anchor: Element, candidate: Element): boolean {
  const position = anchor.compareDocumentPosition(candidate);
  return Boolean(position & FOLLOWING) && !(position & CONTAINS) && !anchor.contains(candidate);
}

/** Text of the reply that follows the echo of our prompt, or null when nothing is there yet. */
export function replyAfterEcho(echo: Element, options: GenericReplyOptions): string | null {
  // 1. Provider response selectors, restricted to elements after our message.
  for (const selector of options.responseSelectors ?? []) {
    let matches: Element[];
    try {
      matches = Array.from((echo.ownerDocument ?? document).querySelectorAll(selector));
    } catch {
      continue;
    }
    const after = matches.filter((element) => follows(echo, element) && !isExcluded(element));
    // Skip nested matches so a wrapper and its markdown child are not read twice.
    const outer = after.filter((element) => !after.some((other) => other !== element && other.contains(element)));
    const text = cleanReplyText(outer.map((element) => options.readText(element) ?? '').filter(Boolean).join('\n\n'));
    if (text && !isEchoOfPrompt(text, options.prompt)) return text;
  }

  // 2. Structural fallback: climb from the echo until its following siblings hold text.
  let node: Element | null = echo;
  while (node && !node.matches(CONVERSATION_BOUNDARY)) {
    const parts: string[] = [];
    for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      if (isExcluded(sibling)) continue;
      const text = options.readText(sibling);
      if (text && text.trim() && !isEchoOfPrompt(text, options.prompt)) parts.push(text);
    }
    const text = cleanReplyText(parts.join('\n\n'));
    if (text && !isEchoOfPrompt(text, options.prompt)) return text;
    node = node.parentElement;
    if (node?.matches(CONVERSATION_BOUNDARY)) break;
  }
  return null;
}

export function readGenericReply(root: ParentNode, options: GenericReplyOptions & { skip?: ReadonlySet<Element> }): string | null {
  const echo = findPromptEcho(root, options);
  return echo ? replyAfterEcho(echo, options) : null;
}

export interface ResponseBaseline {
  count: number;
  elements: Set<Element>;
}

/**
 * Reply text from an assistant-looking element that appeared after we sent (not present in
 * the pre-send snapshot, or beyond the pre-send count). Our own echoed prompt is ignored.
 */
export function newReplyAfterSend(
  current: readonly Element[],
  baseline: ResponseBaseline,
  options: Pick<GenericReplyOptions, 'prompt' | 'userSelectors' | 'readText'>,
): string | null {
  let fresh = current.filter((element) => !baseline.elements.has(element));
  if (!fresh.length && current.length > baseline.count) fresh = current.slice(baseline.count);
  const userSelector = [...new Set([...options.userSelectors, ...GENERIC_USER_MESSAGE_SELECTORS])].join(', ');
  const isUserish = (element: Element) => {
    try {
      return Boolean(element.matches(userSelector) || element.closest(userSelector) || element.querySelector(userSelector));
    } catch {
      return false;
    }
  };
  const accepted = fresh.filter((element) => !isExcluded(element) && !isUserish(element));
  const outer = accepted.filter((element) => !accepted.some((other) => other !== element && Boolean(other.contains?.(element))));
  for (let index = outer.length - 1; index >= 0; index -= 1) {
    const raw = options.readText(outer[index]);
    const text = raw ? cleanReplyText(raw) : '';
    if (!text) continue;
    if (isEchoOfPrompt(text, options.prompt)) continue;
    return text;
  }
  return null;
}
