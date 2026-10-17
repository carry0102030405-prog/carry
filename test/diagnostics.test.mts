import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from './domFixture.mts';
import { BLOCK_HTML_LIMIT, collectContentDiagnostics, lastMessageBlocks } from '../src/content/diagnostics.ts';
import { diagnosticFileName, buildDiagnosticDocument } from '../src/sidepanel/diagnosticFile.ts';
import { GENERIC_RESPONSE_SELECTORS, GENERIC_USER_MESSAGE_SELECTORS, looseMatchesPrompt, newReplyAfterSend } from '../src/content/genericReply.ts';
import { extractResponseContent } from '../src/content/responseSerializer.ts';

const geminiPage = (extra = '') => parseHTML(`<!doctype html><html><head><title>Gemini</title></head><body><main>
  <user-query><span class="label">你说</span><div class="query-text"><p>older</p></div></user-query>
  <model-response><message-content class="model-response-text"><div class="markdown"><p>older answer</p></div></message-content></model-response>
  ${extra}
  <div class="input-area"><div contenteditable="true" aria-label="在此处输入提示"></div><button class="send-button" aria-label="发送"></button></div>
</main></body></html>`).document;

const relayPrompt = '你正在和 Grok 对话。下面是用户说的话：\n\n打个招呼';
const userTurn = `<user-query><span class="label">你说</span><div class="query-text"><p>你正在和 Grok 对话。下面是用户说的话：</p><p>打个招呼</p></div></user-query>`;
const modelTurn = `<model-response><message-content class="model-response-text"><div class="markdown"><p>你好！很高兴和你在 Grok 对话。请问今天有什么我可以帮你的？</p></div></message-content><div><button aria-label="复制">复制</button></div></model-response>`;

test('prompt matching tolerates a "你说" label and collapsed newlines', () => {
  const { document } = parseHTML(`<div>${userTurn}</div>`);
  assert.equal(looseMatchesPrompt(document.querySelector('user-query')!.textContent!, relayPrompt), true);
  assert.equal(looseMatchesPrompt('你说 打个招呼吧', '打个招呼'), false, 'short prompts still need an exact match');
});

test('a reply element that appeared after sending is the reply, our own echo is not', () => {
  const document = geminiPage();
  const query = () => Array.from(document.querySelectorAll(GENERIC_RESPONSE_SELECTORS.join(', ')));
  const before = query();
  const baseline = { count: before.length, elements: new Set(before) };
  const options = { prompt: relayPrompt, userSelectors: GENERIC_USER_MESSAGE_SELECTORS, readText: (element: Element) => extractResponseContent(element) };
  assert.equal(newReplyAfterSend(query(), baseline, options), null);
  document.querySelector('main')!.insertAdjacentHTML('beforeend', userTurn);
  assert.equal(newReplyAfterSend(query(), baseline, options), null, 'only the echo so far');
  document.querySelector('main')!.insertAdjacentHTML('beforeend', modelTurn);
  assert.equal(newReplyAfterSend(query(), baseline, options), '你好！很高兴和你在 Grok 对话。请问今天有什么我可以帮你的？');
});

test('the content report lists selector counts, the active signal, tracking state and the last blocks', () => {
  const document = geminiPage(userTurn + modelTurn);
  const report = collectContentDiagnostics({
    provider: 'gemini',
    root: document,
    selectors: {
      input: ['div[contenteditable="true"]'],
      send: ['button.send-button', 'button.missing'],
      stop: ['button[aria-label="停止回答"]'],
      thinking: ['model-response mat-progress-bar'],
      response: ['model-response'],
      userMessage: ['user-query'],
    },
    isVisible: (element) => !element.closest('[hidden]'),
    generation: { active: false, signal: null },
    tracking: { waitingForResponse: true, candidate: '你好！' },
    log: [{ t: 'now', event: 'send.start' }],
  }, new Date('2026-10-15T15:54:00Z'));
  assert.equal(report.provider, 'gemini');
  assert.equal(report.title, 'Gemini');
  assert.equal(report.collectedAt, '2026-10-15T15:54:00.000Z');
  assert.deepEqual({ ...report.selectors.send[0] }, { selector: 'button.send-button', total: 1, visible: 1 });
  assert.equal(report.selectors.send[1].total, 0);
  assert.equal(report.selectors.response[0].total, 2);
  assert.deepEqual(report.lastBlocks.map((block) => block.tag), ['model-response', 'user-query', 'model-response']);
  assert.match(report.lastBlocks[2].text, /很高兴和你在 Grok 对话/);
  assert.match(report.lastBlocks[2].outerHTML, /^<model-response>/);
  assert.equal(report.tracking.candidate, '你好！');
  assert.equal(report.log.length, 1);
  JSON.stringify(report);
});

test('message blocks are capped in size', () => {
  const { document } = parseHTML(`<main><model-response><p>${'长'.repeat(9000)}</p></model-response></main>`);
  const [block] = lastMessageBlocks(document, ['model-response'], () => true);
  assert.ok(block.outerHTML.length < BLOCK_HTML_LIMIT + 40);
  assert.ok(block.text.length < 2100);
});

test('diagnostic file name and panel section', () => {
  assert.equal(diagnosticFileName(new Date(2026, 9, 15, 23, 54, 7)), 'multi-ai-chat-diagnostic-20261015-235407.json');
  const document_ = buildDiagnosticDocument({ kind: 'multi-ai-chat-diagnostic', providers: {} }, {
    relayOrder: ['gemini', 'grok'], relayTurns: 6, isProcessing: true, stepRecovery: null,
    messages: [{ role: 'user', content: '打个招呼' }],
  });
  assert.equal(document_.kind, 'multi-ai-chat-diagnostic');
  assert.deepEqual((document_.panel as { relayOrder: string[] }).relayOrder, ['gemini', 'grok']);
  assert.equal(buildDiagnosticDocument(undefined, { relayOrder: [], relayTurns: 6, isProcessing: false, stepRecovery: null, messages: [] }, 'boom').workerError, 'boom');
});
