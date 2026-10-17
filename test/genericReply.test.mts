import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from './domFixture.mts';
import {
  cleanReplyText,
  findPromptEcho,
  isGenericStopButton,
  looseMatchesPrompt,
  readGenericReply,
} from '../src/content/genericReply.ts';
import { extractResponseContent } from '../src/content/responseSerializer.ts';
import { GROK_RESPONSE_SELECTORS, GROK_USER_MESSAGE_SELECTORS, isGrokStopControl } from '../src/content/grokDom.ts';

// Markup modelled on grok.com's current bundle (Oct 2026): each turn is a MessageRow
// `div#response-<id>.items-end|items-start` holding `div.message-bubble[role=article]`
// with data-testid user-message / assistant-message; action buttons sit under the bubble;
// the composer is a textarea inside a <form> with a "Stop model response" button while generating.
function grokPage(turns: string, composer = '') {
  return parseHTML(`<!doctype html><html><body>
    <nav><a>Home</a><a>History</a></nav>
    <main>
      <div class="conversation flex flex-col">${turns}</div>
      <form class="query-bar">
        <textarea aria-label="Ask Grok anything">${composer}</textarea>
        <button type="submit" data-testid="chat-submit" aria-label="Submit"></button>
      </form>
      <p>Grok can make mistakes. Check important info.</p>
    </main>
  </body></html>`).document;
}

function userRow(id: string, html: string, withTestId = true) {
  return `<div id="response-${id}" class="relative group flex flex-col justify-center w-full items-end">
    <div dir="auto" role="article" aria-label="You" ${withTestId ? 'data-testid="user-message"' : ''} class="message-bubble relative rounded-3xl bg-surface-user-bubble">${html}</div>
    <div class="action-buttons"><button aria-label="Edit">Edit</button><button aria-label="Copy">Copy</button></div>
  </div>`;
}

function assistantRow(id: string, html: string, withTestId = true) {
  return `<div id="response-${id}" class="relative group flex flex-col justify-center w-full items-start">
    <div class="thinking-container"><span>Thought for 7s</span></div>
    <div dir="auto" role="article" aria-label="Grok" ${withTestId ? 'data-testid="assistant-message"' : ''} class="message-bubble relative w-full max-w-none">${html}</div>
    <div class="action-buttons"><button aria-label="Regenerate">Regenerate</button><button aria-label="Copy">Copy</button><span>1/1</span></div>
  </div>`;
}

const readText = (element: Element) => extractResponseContent(element);

const relayPrompt = '<来自 Gemini>：\n**结论**：我认为人工智能会改变教育。\n\n1. 个性化学习路径\n2. 教师角色转变\n\n你怎么看？';
// How Grok renders that prompt in the user bubble: Markdown applied, list numbers dropped.
const renderedPrompt = '<p>&lt;来自 Gemini&gt;：<br><strong>结论</strong>：我认为人工智能会改变教育。</p><ol><li>个性化学习路径</li><li>教师角色转变</li></ol><p>你怎么看？</p>';

test('loose prompt matching survives Markdown rendering but short prompts stay exact', () => {
  const { document } = parseHTML(`<div>${renderedPrompt}</div>`);
  assert.equal(looseMatchesPrompt(document.querySelector('div')!.textContent!, relayPrompt), true);
  assert.equal(looseMatchesPrompt('Prefix: hello there', 'hello there'), false);
  assert.equal(looseMatchesPrompt('hello there', 'hello  there'), true);
  assert.equal(looseMatchesPrompt('完全不同的另一条很长很长的消息内容，和发送的文本没有任何关系，只是为了测试长度', relayPrompt), false);
});

test('reads the Grok reply that follows our own message, without UI noise', () => {
  const document = grokPage(
    userRow('1', '<p>older question</p>')
    + assistantRow('2', '<p>older answer</p>')
    + userRow('3', renderedPrompt)
    + assistantRow('4', '<h2>回应</h2><p>我部分同意，<strong>但</strong>需要考虑公平。</p><ul><li>数据隐私</li></ul>'),
  );
  const options = { prompt: relayPrompt, userSelectors: GROK_USER_MESSAGE_SELECTORS, responseSelectors: GROK_RESPONSE_SELECTORS, readText };
  const echo = findPromptEcho(document, options);
  assert.equal(echo?.closest('[id^="response-"]')?.id, 'response-3');
  const reply = readGenericReply(document, options);
  assert.equal(reply, '## 回应\n\n我部分同意，**但**需要考虑公平。\n\n- 数据隐私');
  assert.doesNotMatch(reply!, /older answer|Copy|Regenerate|Thought for/);
});

test('falls back to structure when Grok drops data-testid and class names', () => {
  const document = grokPage(
    userRow('1', renderedPrompt, false)
    + assistantRow('2', '<div class="markdown"><p>第一段。</p><p>第二段。</p></div>', false),
  );
  const reply = readGenericReply(document, { prompt: relayPrompt, userSelectors: [], responseSelectors: [], readText });
  assert.equal(reply, '第一段。\n\n第二段。');
});

test('finds the prompt by page text when no user-bubble selector matches at all', () => {
  const document = parseHTML(`<html><body><main><section>
    <div class="row"><div class="bubble">${renderedPrompt}</div></div>
    <div class="row"><div class="bubble"><p>这是答复。</p></div></div>
  </section><form><textarea></textarea></form></main></body></html>`).document;
  const reply = readGenericReply(document, { prompt: relayPrompt, userSelectors: [], responseSelectors: [], readText });
  assert.equal(reply, '这是答复。');
});

test('returns null while the reply has not appeared and ignores the composer and footer', () => {
  const document = grokPage(userRow('1', renderedPrompt), 'draft text in composer');
  const reply = readGenericReply(document, { prompt: relayPrompt, userSelectors: GROK_USER_MESSAGE_SELECTORS, responseSelectors: GROK_RESPONSE_SELECTORS, readText });
  assert.equal(reply, null);
});

test('the newest echo wins when the same prompt was sent twice', () => {
  const document = grokPage(
    userRow('1', renderedPrompt) + assistantRow('2', '<p>first answer</p>')
    + userRow('3', renderedPrompt) + assistantRow('4', '<p>second answer</p>'),
  );
  const reply = readGenericReply(document, { prompt: relayPrompt, userSelectors: GROK_USER_MESSAGE_SELECTORS, responseSelectors: GROK_RESPONSE_SELECTORS, readText });
  assert.equal(reply, 'second answer');
});

test('cleanReplyText strips thinking headers, button labels and counters', () => {
  assert.equal(
    cleanReplyText('Thought for 12s\n已思考 8 秒\nReal answer line\nCopy\n重新生成\n2/3\n\n\n\nSecond line\nGrok can make mistakes. Check important info.'),
    'Real answer line\n\nSecond line',
  );
  assert.equal(cleanReplyText('Copy the file first, then run it.'), 'Copy the file first, then run it.');
});

test('Stop controls are recognized next to the composer in any language', () => {
  const { document } = parseHTML(`<html><body>
    <form><textarea></textarea><button id="en" aria-label="Stop model response"></button><button id="zh" aria-label="停止模型响应"></button><button id="send" aria-label="Submit"></button></form>
    <div><button id="far" aria-label="Stop playback"></button></div>
  </body></html>`);
  const byId = (id: string) => document.getElementById(id)!;
  assert.equal(isGenericStopButton(byId('en')), true);
  assert.equal(isGenericStopButton(byId('zh')), true);
  assert.equal(isGenericStopButton(byId('send')), false);
  assert.equal(isGenericStopButton(byId('far')), false);
  assert.equal(isGrokStopControl(byId('en')), true);
  assert.equal(isGrokStopControl(byId('far')), false);
});
