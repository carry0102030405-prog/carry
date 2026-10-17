import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import type * as RelayModule from '../src/background/relayWorkflow.ts';
import type { ProviderRequestError as ProviderRequestErrorType, } from '../src/background/roundtableRecovery.ts';
import { AI_PROVIDERS } from '../src/shared/constants.ts';
import type { AIProvider, StepRecoveryAction } from '../src/shared/types.ts';
import type { RelayDependencies } from '../src/background/relayWorkflow.ts';

// relayWorkflow imports extensionless paths for webpack; load it like the worker harness does.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cache = new Map<string, { exports: Record<string, unknown> }>();
const context = vm.createContext({ console, DOMException });
function load(file: string): Record<string, unknown> {
  const cached = cache.get(file);
  if (cached) return cached.exports;
  const module = { exports: {} as Record<string, unknown> };
  cache.set(file, module);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInContext(`(function(require, module, exports) {${code}\n})`, context, { filename: file })(
    (relative: string) => load(path.resolve(path.dirname(file), `${relative}.ts`)), module, module.exports,
  );
  return module.exports;
}
const { formatRelayPrompt, normalizeRelayOrder, normalizeRelayTurns, runRelayWorkflow } =
  load(path.join(root, 'src/background/relayWorkflow.ts')) as unknown as typeof RelayModule;
const { ProviderRequestError } = load(path.join(root, 'src/background/roundtableRecovery.ts')) as unknown as {
  ProviderRequestError: typeof ProviderRequestErrorType;
};

const name = (provider: AIProvider) => AI_PROVIDERS[provider].name;

const L2 = (other: string) => `接下来和你对话的是另一个 AI：${other}。你的回复会直接转给它。`;
const L3 = '这是一场多个 AI 的讨论，参与者有 ChatGPT、Claude、Grok，按顺序轮流发言。你的回复会转给下一位。';
const firstOf = (msg: string, line: string) => `<来自用户>：\n${msg}\n\n${line}`;
const firstWith = (msg: string, line: string, prev: string, reply: string) =>
  `${firstOf(msg, line)}\n下面是 ${prev} 的回复：\n<来自 ${prev}>：\n${reply}`;

test('relay prompt wrappers follow the approved text', () => {
  const two = { participants: ['gemini', 'grok'] as AIProvider[], topic: '聊聊 AI 与教育', providerName: name };
  assert.equal(
    formatRelayPrompt({ ...two, recipient: 'gemini', previous: { from: 'user', text: '聊聊 AI 与教育' }, introduced: false, spokeThisRun: false }),
    '<来自用户>：\n聊聊 AI 与教育\n\n接下来和你对话的是另一个 AI：Grok。你的回复会直接转给它。',
  );
  assert.equal(
    formatRelayPrompt({ ...two, recipient: 'grok', previous: { from: 'gemini', text: '我认为……' }, introduced: false, spokeThisRun: false }),
    '<来自用户>：\n聊聊 AI 与教育\n\n接下来和你对话的是另一个 AI：Gemini。你的回复会直接转给它。\n下面是 Gemini 的回复：\n<来自 Gemini>：\n我认为……',
  );
  const later = formatRelayPrompt({ ...two, recipient: 'gemini', previous: { from: 'grok', text: '同意一半' }, introduced: true, spokeThisRun: true });
  assert.equal(later, '<来自 Grok>：\n同意一半');
  assert.equal(
    formatRelayPrompt({ ...two, recipient: 'gemini', previous: { from: 'grok', text: '好的' }, introduced: true, spokeThisRun: true, injected: ['说具体点'] }),
    '<来自用户>：\n说具体点\n\n<来自 Grok>：\n好的',
  );
  // Mid-run guidance landing on an AI's first turn becomes the user's statement in the first-turn format.
  assert.equal(
    formatRelayPrompt({ ...two, recipient: 'grok', previous: { from: 'gemini', text: 'answer' }, introduced: false, spokeThisRun: false, injected: ['换个角度'] }),
    firstWith('换个角度', L2('Gemini'), 'Gemini', 'answer'),
  );
  assert.equal(
    formatRelayPrompt({ participants: ['chatgpt', 'claude', 'grok'], recipient: 'chatgpt', topic: 'hi', providerName: name, previous: { from: 'user', text: 'hi' }, introduced: false, spokeThisRun: false }),
    firstOf('hi', L3),
  );
  assert.equal(formatRelayPrompt({ participants: ['claude'], recipient: 'claude', topic: 'just me', providerName: name, previous: { from: 'user', text: 'just me' }, introduced: false, spokeThisRun: false }), 'just me');
  assert.doesNotMatch(later, /接下来和你对话的不是用户|这次讨论的话题是/);
});

test('turn and order settings are normalized', () => {
  assert.equal(normalizeRelayTurns(undefined), 6);
  assert.equal(normalizeRelayTurns('3'), 3);
  assert.equal(normalizeRelayTurns(0), 6);
  assert.equal(normalizeRelayTurns(999), 50);
  assert.deepEqual([...normalizeRelayOrder(['grok', 'meta', 'grok', 'x', 'gemini'], ['chatgpt', 'claude', 'gemini', 'grok'])], ['grok', 'gemini']);
  assert.equal(normalizeRelayOrder('grok', ['grok']).length, 0);
});

function harness(options: { replies?: Record<number, string | Error>; decisions?: StepRecoveryAction[]; manual?: string; reread?: string | null; inject?: Record<number, string> } = {}) {
  const sends: { provider: AIProvider; prompt: string }[] = [];
  const published: { provider: AIProvider; text: string }[] = [];
  const statuses: string[] = [];
  const introduced = new Set<AIProvider>();
  const injected: string[] = [];
  const decisions = [...(options.decisions ?? [])];
  let sequence = 0;
  const deps: RelayDependencies = {
    checkAborted: () => {},
    providerName: name,
    isIntroduced: (provider) => introduced.has(provider),
    markIntroduced: (provider) => { introduced.add(provider); },
    takeInjected: () => injected.splice(0),
    createRequestId: (provider) => `${provider}-${++sequence}`,
    sendStatus: (turn, total, provider) => { statuses.push(`${turn}/${total}:${provider}`); },
    sendAndWait: async (provider, prompt, workflowId, requestId) => {
      sends.push({ provider, prompt });
      const index = sends.length;
      if (options.inject?.[index]) injected.push(options.inject[index]);
      const reply = options.replies?.[index];
      if (reply instanceof Error) throw new ProviderRequestError(provider, workflowId, requestId, reply);
      return reply ?? `${name(provider)} 第${index}次发言`;
    },
    requestRecovery: async () => {
      const decision = decisions.shift();
      assert.ok(decision, 'unexpected recovery request');
      return decision;
    },
    takeManualText: () => options.manual,
    rereadReply: async () => options.reread ?? null,
    publishReply: (provider, text) => { published.push({ provider, text }); },
    resetProvider: async () => {},
    cancelWorkflow: async () => {},
  };
  return { deps, sends, published, statuses };
}

test('two AIs: round 1 introduces each AI, round 2 uses plain tags', async () => {
  const h = harness();
  const history = await runRelayWorkflow('开始吧', ['gemini', 'grok'], 6, 'wf', h.deps);
  assert.deepEqual(h.sends.map((send) => send.provider), ['gemini', 'grok', 'gemini', 'grok', 'gemini', 'grok']);
  assert.equal(history.length, 6);
  assert.deepEqual(h.sends.slice(0, 4).map((send) => send.prompt), [
    firstOf('开始吧', L2('Grok')),
    firstWith('开始吧', L2('Gemini'), 'Gemini', 'Gemini 第1次发言'),
    '<来自 Grok>：\nGrok 第2次发言',
    '<来自 Gemini>：\nGemini 第3次发言',
  ]);
  assert.deepEqual(h.statuses.slice(0, 2), ['1/6:gemini', '2/6:grok']);
});

test('three AIs: round 1 introduces each AI, round 2 uses plain tags', async () => {
  const h = harness();
  await runRelayWorkflow('远程办公好不好？', ['chatgpt', 'claude', 'grok'], 6, 'wf', h.deps);
  assert.deepEqual(h.sends.map((send) => send.prompt), [
    firstOf('远程办公好不好？', L3),
    firstWith('远程办公好不好？', L3, 'ChatGPT', 'ChatGPT 第1次发言'),
    firstWith('远程办公好不好？', L3, 'Claude', 'Claude 第2次发言'),
    '<来自 Grok>：\nGrok 第3次发言',
    '<来自 ChatGPT>：\nChatGPT 第4次发言',
    '<来自 Claude>：\nClaude 第5次发言',
  ]);
});

test('a follow-up run in the same conversation passes the new message without re-introducing', async () => {
  const h = harness();
  await runRelayWorkflow('第一个话题', ['chatgpt', 'claude', 'grok'], 3, 'wf1', h.deps);
  h.sends.length = 0; // reply numbering restarts with the send count
  await runRelayWorkflow('换个问题', ['chatgpt', 'claude', 'grok'], 6, 'wf2', h.deps);
  assert.deepEqual(h.sends.map((send) => send.prompt), [
    '<来自用户>：\n换个问题',
    '<来自用户>：\n换个问题\n\n<来自 ChatGPT>：\nChatGPT 第1次发言',
    '<来自用户>：\n换个问题\n\n<来自 Claude>：\nClaude 第2次发言',
    '<来自 Grok>：\nGrok 第3次发言',
    '<来自 ChatGPT>：\nChatGPT 第4次发言',
    '<来自 Claude>：\nClaude 第5次发言',
  ]);
});

test('a follow-up run introduces only AIs new to the conversation', async () => {
  const h = harness();
  await runRelayWorkflow('话题一', ['chatgpt', 'claude'], 2, 'wf1', h.deps);
  h.sends.length = 0;
  await runRelayWorkflow('话题二', ['grok', 'chatgpt', 'claude'], 3, 'wf2', h.deps);
  const L = '这是一场多个 AI 的讨论，参与者有 Grok、ChatGPT、Claude，按顺序轮流发言。你的回复会转给下一位。';
  assert.deepEqual(h.sends.map((send) => send.prompt), [
    firstOf('话题二', L),
    '<来自用户>：\n话题二\n\n<来自 Grok>：\nGrok 第1次发言',
    '<来自用户>：\n话题二\n\n<来自 ChatGPT>：\nChatGPT 第2次发言',
  ]);
});

test('a single AI gets exactly one turn with the raw message', async () => {
  const h = harness();
  await runRelayWorkflow('hello', ['claude'], 6, 'wf', h.deps);
  assert.deepEqual(h.sends, [{ provider: 'claude', prompt: 'hello' }]);
});

test('human guidance typed mid-run reaches only the next AI', async () => {
  const h = harness({ inject: { 2: '请聚焦在成本上' } });
  await runRelayWorkflow('开始', ['gemini', 'grok'], 4, 'wf', h.deps);
  assert.equal(h.sends[2].prompt, '<来自用户>：\n请聚焦在成本上\n\n<来自 Grok>：\nGrok 第2次发言');
  assert.equal(h.sends[3].prompt, '<来自 Gemini>：\nGemini 第3次发言');
});

test('guidance landing on an AI first turn uses the first-turn format with the guidance', async () => {
  const h = harness({ inject: { 1: '说短一点' } });
  await runRelayWorkflow('开始', ['gemini', 'grok'], 2, 'wf', h.deps);
  assert.equal(h.sends[1].prompt, firstWith('说短一点', L2('Gemini'), 'Gemini', 'Gemini 第1次发言'));
});

test('a missed reply can be re-read from the page and the relay continues', async () => {
  const h = harness({ replies: { 2: new Error('no reply detected') }, decisions: ['reread'], reread: 'Grok 的真实回复' });
  await runRelayWorkflow('开始', ['gemini', 'grok'], 3, 'wf', h.deps);
  assert.deepEqual(h.published, [{ provider: 'grok', text: 'Grok 的真实回复' }]);
  assert.equal(h.sends.length, 3);
  assert.equal(h.sends[2].prompt, '<来自 Grok>：\nGrok 的真实回复');
});

test('a reply pasted by hand is relayed, and a failed re-read asks again instead of resending', async () => {
  const h = harness({ replies: { 2: new Error('timeout') }, decisions: ['reread', 'manual'], reread: null, manual: '手动粘贴的回复' });
  await runRelayWorkflow('开始', ['gemini', 'grok'], 3, 'wf', h.deps);
  assert.equal(h.sends.length, 3, 'the failed turn was not resent');
  assert.deepEqual(h.published, [{ provider: 'grok', text: '手动粘贴的回复' }]);
  assert.equal(h.sends[2].prompt, '<来自 Grok>：\n手动粘贴的回复');
});

test('resend retries the same prompt; cancel stops the relay', async () => {
  const retry = harness({ replies: { 1: new Error('send failed') }, decisions: ['retry'] });
  await runRelayWorkflow('开始', ['gemini', 'grok'], 2, 'wf', retry.deps);
  assert.equal(retry.sends[0].prompt, retry.sends[1].prompt);
  assert.equal(retry.sends.length, 3);

  const cancel = harness({ replies: { 1: new Error('send failed') }, decisions: ['cancel'] });
  await assert.rejects(runRelayWorkflow('开始', ['gemini', 'grok'], 4, 'wf', cancel.deps), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(cancel.sends.length, 1);
});
