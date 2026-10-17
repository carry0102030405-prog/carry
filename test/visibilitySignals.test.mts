import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from './domFixture.mts';
import { firstVisibleSelector, isElementVisible, type VisibilityStyle } from '../src/content/visibility.ts';
import { GEMINI_THINKING_SELECTORS } from '../src/content/geminiDom.ts';
import { isGenericStopButton } from '../src/content/genericReply.ts';

// linkedom has no layout: emulate it. Inline style drives computed style; `data-zero` = no box.
function page(html: string) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const proto = (window as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype;
  proto.getBoundingClientRect = function (this: Element) {
    const zero = this.closest('[data-zero]');
    return { width: zero ? 0 : 24, height: zero ? 0 : 24 };
  };
  const readStyle = (element: Element): VisibilityStyle => {
    const style: VisibilityStyle = {};
    for (const part of (element.getAttribute('style') ?? '').split(';')) {
      const [key, value] = part.split(':').map((item) => item?.trim());
      if (key === 'display' || key === 'visibility' || key === 'opacity') style[key] = value;
    }
    return style;
  };
  const visible = (element: Element) => isElementVisible(element, readStyle);
  return { document, visible };
}

test('hidden, zero-size, aria-hidden and transparent elements are not visible', () => {
  const { document, visible } = page(`
    <button id="shown">Stop</button>
    <button id="none" style="display: none">Stop</button>
    <div style="display:none"><button id="parentNone">Stop</button></div>
    <button id="hiddenVis" style="visibility: hidden">Stop</button>
    <button id="zero" data-zero>Stop</button>
    <div aria-hidden="true"><button id="aria">Stop</button></div>
    <div style="opacity: 0"><button id="transparent">Stop</button></div>
    <button id="attr" hidden>Stop</button>`);
  assert.equal(visible(document.getElementById('shown')!), true);
  for (const id of ['none', 'parentNone', 'hiddenVis', 'zero', 'aria', 'transparent', 'attr']) {
    assert.equal(visible(document.getElementById(id)!), false, id);
  }
  assert.equal(isElementVisible(null), false);
});

// The v0.4.0 hang: Gemini finished its answer but kept hidden busy elements mounted, and the
// old querySelector() checks reported "still generating" forever.
test('finished Gemini page with leftover hidden busy elements reports no generation signal', () => {
  const { document, visible } = page(`
    <mat-progress-bar data-zero class="top-loading"></mat-progress-bar>
    <user-query><div class="query-text"><p>你正在和 Grok 对话。下面是用户说的话：</p><p>打个招呼</p></div></user-query>
    <model-response>
      <div class="loading-indicator" style="display:none"></div>
      <mat-progress-bar data-zero></mat-progress-bar>
      <div class="thinking-indicator" aria-hidden="true"></div>
      <message-content class="model-response-text"><div class="markdown"><p>你好！很高兴和你在 Grok 对话。请问今天有什么我可以帮你的？</p></div></message-content>
      <div class="actions"><button aria-label="赞"></button><button aria-label="重新生成"></button><button aria-label="复制"></button></div>
    </model-response>
    <div class="input-area"><div contenteditable="true" aria-label="在此处输入提示"></div>
      <button class="send-button stop" aria-label="停止回答" style="display:none"></button>
      <button aria-label="使用麦克风"></button></div>`);
  assert.equal(firstVisibleSelector(GEMINI_THINKING_SELECTORS, document, visible), null);
  // The pre-fix logic (any match counts) would have said "generating".
  assert.notEqual(GEMINI_THINKING_SELECTORS.find((selector) => document.querySelector(selector)), undefined);
  const hiddenStop = document.querySelector('button[aria-label="停止回答"]')!;
  assert.equal(isGenericStopButton(hiddenStop) && visible(hiddenStop), false);
});

test('a visible Gemini Stop control (zh-CN or English) is a generation signal', () => {
  for (const label of ['停止回答', '停止生成', 'Stop response']) {
    const { document, visible } = page(`<div class="input-area"><div contenteditable="true"></div><button aria-label="${label}"></button></div>`);
    assert.match(firstVisibleSelector(GEMINI_THINKING_SELECTORS, document, visible) ?? '', /button/, label);
  }
  const { document, visible } = page('<model-response><div class="loading-indicator"></div></model-response>');
  assert.equal(firstVisibleSelector(GEMINI_THINKING_SELECTORS, document, visible), 'model-response .loading-indicator');
});
