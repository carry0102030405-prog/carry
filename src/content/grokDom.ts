interface ClosestCapableElement {
  getAttribute(name: string): string | null;
  closest(selectors: string): unknown;
  matches?(selectors: string): boolean;
}

interface QueryCapableContainer {
  querySelector(selectors: string): unknown;
}

export interface GrokAssistantSignals {
  streaming: boolean;
  thinkingTexts: readonly string[];
}

export const GROK_INPUT_SELECTORS = [
  'textarea[aria-label="Ask Grok anything"]',
  'textarea[aria-label*="Ask Grok"]',
  'textarea[aria-label*="Grok"]',
  '[data-testid="chat-input"] textarea',
  'form textarea',
  '[data-testid="chat-input"] .ProseMirror[contenteditable="true"]',
  '[data-testid="chat-input"] [contenteditable="true"]',
  '.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
];

export const GROK_STOP_SELECTORS = [
  'button[data-testid="chat-stop"]',
  'button[data-testid="chat-stop-button"]',
  'button[aria-label="Stop"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop response"]',
  'button[aria-label="Stop model response"]',
  'button[aria-label*="Stop"]',
  'button[aria-label*="停止"]',
  'button[aria-label*="中止"]',
];

export const GROK_USER_MESSAGE_SELECTORS = [
  '[data-testid="user-message"]',
  '.message-bubble[data-testid="user-message"]',
  '[class*="items-end"] .message-bubble',
  '.flex-row-reverse .message-bubble',
  '[class*="bg-surface-user-bubble"]',
];

export const GROK_RESPONSE_SELECTORS = [
  // Current Grok (2026): assistant bubbles use data-testid="assistant-message" and live in
  // MessageRow containers with id="response-<uuid>" and class items-start (user is items-end).
  '[data-testid="assistant-message"]',
  'div[id^="response-"] [data-testid="assistant-message"]',
  'div[id^="response-"] .message-bubble',
  'div[id^="response-"]',
  '[class*="items-start"] .message-bubble',
  '.message-bubble.assistant',
  '.message-bubble:not([data-testid="user-message"])',
  '.response-content-markdown',
  '[class*="response-content"]',
  '[class*="items-start"] .prose',
  '[class*="items-start"] [class*="markdown"]',
];

export const GROK_REQUIRE_SAME_COMPOSER_FOR_CLEAR_CONFIRMATION = true;
// Stop/Thinking signals only count once our own user turn is visible (matched loosely in
// base.ts). If the echo is never recognized, base.ts switches to generic reply detection,
// which honours the signals again.
export const GROK_REQUIRE_MATCHING_USER_MESSAGE_FOR_GENERATION_SIGNALS = true;
export const GROK_ANCHOR_RESPONSES_AFTER_MATCHING_USER_MESSAGE = true;

export function isGrokComposerInput(element: ClosestCapableElement): boolean {
  const aria = element.getAttribute('aria-label') ?? '';
  return /Ask Grok/i.test(aria)
    || /Grok/i.test(aria)
    || Boolean(element.closest('[data-testid="chat-input"]'))
    || Boolean(element.matches?.('.ProseMirror[contenteditable="true"]'))
    || Boolean(element.matches?.('textarea'))
    || Boolean(element.matches?.('[contenteditable="true"]'));
}

export function isGrokStopControl(element: ClosestCapableElement): boolean {
  const testId = element.getAttribute('data-testid');
  if (testId === 'chat-stop' || testId === 'chat-stop-button') return true;
  if (element.closest('[data-testid="chat-input"]')) return true;
  // Current Grok: "Stop model response" lives inside the query-bar form, next to the composer.
  const form = element.closest('form') as QueryCapableContainer | null;
  return Boolean(form?.querySelector('[data-testid="chat-input"], textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]'));
}

export function isGrokGenerationActive<T>(
  stopControls: readonly T[],
  assistantTurns: readonly T[],
  isVisible: (element: T) => boolean,
  readAssistantSignals: (turn: T) => GrokAssistantSignals,
): boolean {
  if (stopControls.some(isVisible)) return true;

  const currentTurn = Array.from(assistantTurns).reverse().find(isVisible);
  if (!currentTurn) return false;
  const signals = readAssistantSignals(currentTurn);
  return signals.streaming || signals.thinkingTexts.some(isActiveThinkingText);
}

export function updateGrokTextControl(
  control: { value: string },
  text: string,
  setNativeValue: (value: string) => void,
  dispatchInput: (value: string) => void,
): void {
  setNativeValue(text);
  dispatchInput(text);
}

export function grokResponseContentRoot(response: Element): Element {
  if (response.matches?.('.response-content-markdown, [class*="response-content"], .prose, [class*="markdown"]')) {
    return response;
  }
  return response.querySelector?.('.response-content-markdown, [class*="response-content"], .prose, [class*="markdown"]')
    ?? response;
}

export function grokSessionReady(
  hasVisibleComposer: boolean,
  hasVisibleGenerationUi: boolean,
): boolean {
  return hasVisibleComposer || hasVisibleGenerationUi;
}

function isActiveThinkingText(text: string): boolean {
  return (text.includes('Thinking') || text.includes('思考'))
    && !/Thought for|思考了|已思考|已深度思考/.test(text);
}
