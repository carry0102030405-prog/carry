import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_PROVIDERS, DEFAULT_ROUNDTABLE_ROLES, PROMPTS } from '../src/shared/constants.ts';
import { getProviderReadiness } from '../src/shared/providerReadiness.ts';
import { assignedProviders, repairRoles } from '../src/shared/providerSelection.ts';
import { roundtableSeats, runRoundtableWorkflow, type RoundtableWorkflowDependencies } from '../src/background/roundtableRecovery.ts';
import type { AIConnection, AIProvider, DebateRoles, RoundtableRoles } from '../src/shared/types.ts';

test('workflows only need the providers actually assigned to roles', () => {
  const connections: Partial<Record<AIProvider, Pick<AIConnection, 'status'>>> = {
    chatgpt: { status: 'connected' },
    claude: { status: 'connected' },
    gemini: { status: 'login-required' },
    grok: { status: 'disconnected' },
  };
  const debate: DebateRoles = { pro: 'chatgpt', con: 'claude', judge: 'chatgpt', summary: 'claude' };
  assert.deepEqual(assignedProviders(debate), ['chatgpt', 'claude']);
  const state = getProviderReadiness('debate', assignedProviders(debate), connections);
  assert.equal(state.canSend, true);
  assert.equal(state.noticeKey, undefined);

  const roundtable: RoundtableRoles = { first: 'chatgpt', second: 'claude', third: 'off', fourth: 'off' };
  assert.deepEqual(assignedProviders(roundtable), ['chatgpt', 'claude']);
  assert.equal(getProviderReadiness('roundtable', assignedProviders(roundtable), connections).canSend, true);
  const allOff = { first: 'off', second: 'off', third: 'off', fourth: 'off' } as RoundtableRoles;
  assert.equal(getProviderReadiness('roundtable', assignedProviders(allOff), connections).canSend, false);
  assert.deepEqual(assignedProviders(null), []);
});

test('repairRoles keeps duplicate roles and Off seats', () => {
  const debate: DebateRoles = { pro: 'chatgpt', con: 'claude', judge: 'chatgpt', summary: 'claude' };
  assert.deepEqual(repairRoles(debate, 'meta'), debate);
  const roundtable: RoundtableRoles = { first: 'chatgpt', second: 'off', third: 'claude', fourth: 'off' };
  assert.deepEqual(repairRoles(roundtable, 'meta'), roundtable);
  assert.deepEqual(repairRoles(DEFAULT_ROUNDTABLE_ROLES, 'meta'), DEFAULT_ROUNDTABLE_ROLES);
});

test('roundtable seats skip Off and label an AI that holds several seats', () => {
  const name = (provider: AIProvider) => AI_PROVIDERS[provider].name;
  assert.deepEqual(roundtableSeats({ first: 'chatgpt', second: 'claude', third: 'chatgpt', fourth: 'off' }, name), [
    { provider: 'chatgpt', name: 'ChatGPT #1' },
    { provider: 'claude', name: 'Claude' },
    { provider: 'chatgpt', name: 'ChatGPT #3' },
  ]);
  assert.deepEqual(roundtableSeats({ first: 'off', second: 'off', third: 'off', fourth: 'off' }, name), []);
  assert.equal(roundtableSeats(DEFAULT_ROUNDTABLE_ROLES, name).length, 4);
});

test('two-AI roundtable runs 5 rounds back and forth with the real speaker count', async () => {
  const sends: { provider: AIProvider; prompt: string }[] = [];
  const counts: number[] = [];
  let sequence = 0;
  const dependencies: RoundtableWorkflowDependencies = {
    checkAborted: () => {},
    providerName: (provider) => AI_PROVIDERS[provider].name,
    buildPrompt: (text, round, speaker, history, speakerCount) => {
      counts.push(speakerCount);
      return PROMPTS.roundtable.buildPrompt(text, round, speaker, history, speakerCount);
    },
    createRequestId: () => `request-${++sequence}`,
    sendStatus: async () => {},
    sendRoleAssignment: async () => {},
    sendAndWait: async (provider, prompt) => { sends.push({ provider, prompt }); return `answer ${sends.length}`; },
    requestRecovery: async () => 'cancel',
    resetProvider: async () => {},
    cancelWorkflow: async () => {},
  };
  const history = await runRoundtableWorkflow('q', { first: 'chatgpt', second: 'off', third: 'claude', fourth: 'off' }, 'wf', dependencies);
  assert.equal(history.length, 10);
  assert.deepEqual(sends.map((send) => send.provider), Array.from({ length: 10 }, (_, index) => index % 2 ? 'claude' : 'chatgpt'));
  assert.ok(counts.every((count) => count === 2));
  assert.match(sends[0].prompt, /2 位 AI 輪流發言/);
  assert.match(sends[9].prompt, /【第5輪・ChatGPT】/);
});
