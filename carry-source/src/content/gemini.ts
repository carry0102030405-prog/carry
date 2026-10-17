import { createContentScript } from './base';
import { GEMINI_STOP_SELECTORS, GEMINI_THINKING_SELECTORS } from './geminiDom';

createContentScript({
  provider: 'gemini',

  inputSelectors: [
    // Gemini uses a rich text editor
    '.ql-editor[contenteditable="true"]',
    'rich-textarea .ql-editor',
    // Newer Gemini input
    'div[contenteditable="true"][aria-label="Enter a prompt here"]',
    'div[contenteditable="true"][aria-label="在此处输入提示"]',
    'div[contenteditable="true"][aria-label*="提示"]',
    'div[contenteditable="true"][aria-label]',
    // Generic fallback
    '.input-area [contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
  ],

  sendButtonSelectors: [
    'button.send-button',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]',
    'button[aria-label="发送"]',
    'button[aria-label="发送消息"]',
    'button[aria-label="發送"]',
    'button[aria-label="傳送訊息"]',
    'button[aria-label="送出"]',
    'button[data-mat-icon-name="send"]',
    // Gemini's send icon button
    '.send-button-container button',
    'button mat-icon[data-mat-icon-name="send"]',
    // Newer Gemini UI patterns
    '.action-wrapper button[aria-label]',
    '.input-area-container button.send',
    'button.send-message-button',
  ],

  responseSelectors: [
    // Gemini response containers
    '.model-response-text .markdown',
    '.model-response-text',
    'model-response .markdown',
    'model-response message-content',
    // Newer Gemini
    '.response-content .markdown',
    '.message-content[data-message-id]',
  ],

  stopButtonSelectors: GEMINI_STOP_SELECTORS,

  loginDetector: () => {
    return !!(
      document.querySelector('.ql-editor[contenteditable="true"]') ||
      document.querySelector('rich-textarea [contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][aria-label="Enter a prompt here"]')
    );
  },

  thinkingSelectors: GEMINI_THINKING_SELECTORS,

  // Gemini rich text editor injection — must trigger Angular change detection
  injectInput: async (el: Element, text: string) => {
    const editor = el as HTMLElement;
    editor.focus();

    // Clear existing content
    editor.replaceChildren();

    // Convert text to paragraphs (Quill/rich editor needs block elements)
    const lines = text.split('\n');
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line || '\u00A0'; // non-breaking space for empty lines
      fragment.appendChild(p);
    }
    editor.appendChild(fragment);

    // Fire events to trigger Angular/Quill change detection
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));

    await Promise.resolve();
    if (!editor.textContent?.trim()) {
      editor.focus();
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  },

  doneDelay: 4000,
  chunkDebounce: 600,
});
