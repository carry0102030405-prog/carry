// Gemini selectors kept free of runtime imports so node tests can load them.

export const GEMINI_STOP_SELECTORS = [
  'button[aria-label="Stop response"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop"]',
  'button[aria-label="停止回應"]',
  'button[aria-label="停止回答"]',
  'button[aria-label="停止生成"]',
  'button[aria-label="停止"]',
  'button[aria-label*="Stop response"]',
  'button[aria-label*="停止回答"]',
  'button[aria-label*="停止生成"]',
  'button.stop',
  'button[data-test-id="stop-button"]',
  'button mat-icon[fonticon="stop"]',
  'button mat-icon[data-mat-icon-name="stop"]',
];

// Generating = one of these is actually VISIBLE. Gemini keeps several of them (progress
// bars, loading indicators) mounted but hidden after the answer finishes; the old bare
// querySelector() checks therefore reported "still generating" forever (v0.4.0 hang).
// Progress bars are only trusted inside the conversation, not the page chrome.
export const GEMINI_THINKING_SELECTORS = [
  ...GEMINI_STOP_SELECTORS,
  'model-response .loading-indicator',
  'model-response .thinking-indicator',
  'model-response mat-progress-bar',
  '.response-streaming',
  '[data-test-id="response-loading"]',
  'model-response [aria-busy="true"]',
];
