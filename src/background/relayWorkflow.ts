import type { AIProvider, StepRecoveryAction } from '../shared/types';
import { ProviderRequestError } from './roundtableRecovery';

// 自由模式: the human's message goes to the first AI, every reply is relayed to the next AI
// in order (round-robin) until the turn budget is used up.
//
// Wrappers (see formatRelayPrompt; the exact text was approved by the user):
// - L (intro line): 2 participants → "接下来和你对话的是另一个 AI：{other}。你的回复会直接转给它。";
//   3+ → "这是一场多个 AI 的讨论，参与者有 {A、B、C}，按顺序轮流发言。你的回复会转给下一位。"
// - An AI's first turn in this extension conversation: "<来自用户>：\n{msg}\n\n{L}", and for every
//   AI but the first one also "\n下面是 {prev} 的回复：\n<来自 {prev}>：\n{reply}".
// - Later turns: "<来自 {prev}>：\n{reply}" only.
// - Guidance typed mid-run (next turn only): "<来自用户>：\n{msg}\n\n<来自 {prev}>：\n{reply}"; if that
//   turn is the AI's first, the first-turn format is used with {msg} as the user's statement.
// - A follow-up run in the same conversation: the first AI gets "<来自用户>：\n{new message}"; other
//   AIs already introduced get the mid-run format with the new message; AIs never introduced get
//   the full first-turn format. Introductions are never repeated, even if the participants change.
// - ＋ 新对话 starts a new conversation id, so every AI gets the intro again.
// - A run with a single AI has no one to relay to: the message is sent raw.

export const DEFAULT_RELAY_TURNS = 6;
export const MAX_RELAY_TURNS = 50;

export function normalizeRelayTurns(value: unknown): number {
  const turns = Math.round(Number(value));
  if (!Number.isFinite(turns) || turns < 1) return DEFAULT_RELAY_TURNS;
  return Math.min(turns, MAX_RELAY_TURNS);
}

export function normalizeRelayOrder(value: unknown, allowed: readonly AIProvider[]): AIProvider[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((provider): provider is AIProvider => allowed.includes(provider as AIProvider)))].slice(0, 5);
}

export interface RelayIncoming {
  from: 'user' | AIProvider;
  text: string;
}

export interface RelayPromptInput {
  /** Everyone in this run, in speaking order. */
  participants: readonly AIProvider[];
  recipient: AIProvider;
  /** The human's message that started this run. */
  topic: string;
  /** The message being passed on: the previous AI's reply, or the human's message if no AI has answered yet. */
  previous: RelayIncoming;
  /** The recipient has already had a turn in this extension conversation (this run or an earlier one). */
  introduced: boolean;
  /** The recipient already had a turn earlier in this run. */
  spokeThisRun: boolean;
  /** Guidance the human typed while the run was going, not yet delivered. */
  injected?: readonly string[];
  providerName: (provider: AIProvider) => string;
}

export function relayIntroLine(participants: readonly AIProvider[], recipient: AIProvider, providerName: (provider: AIProvider) => string): string {
  if (participants.length <= 2) {
    const other = participants.find((provider) => provider !== recipient) ?? recipient;
    return `接下来和你对话的是另一个 AI：${providerName(other)}。你的回复会直接转给它。`;
  }
  return `这是一场多个 AI 的讨论，参与者有 ${participants.map(providerName).join('、')}，按顺序轮流发言。你的回复会转给下一位。`;
}

const userBlock = (text: string) => `<来自用户>：\n${text}`;

export function formatRelayPrompt(input: RelayPromptInput): string {
  const { participants, recipient, topic, previous, introduced, spokeThisRun, providerName } = input;
  const injected = [...(input.injected ?? [])];
  if (participants.length <= 1) {
    return injected.length ? [...injected, previous.text].map(userBlock).join('\n\n') : previous.text;
  }
  // What the human said that this AI has not seen yet: the run's message on its first turn of
  // the run, plus anything typed mid-run.
  const fromUser = previous.from === 'user'
    ? [...injected, previous.text]
    : [...(spokeThisRun ? [] : [topic]), ...injected];
  if (!introduced) {
    // First turn in the conversation; mid-run guidance stands in as the user's statement.
    const statement = injected.length ? injected : fromUser;
    const head = `${statement.map(userBlock).join('\n\n')}\n\n${relayIntroLine(participants, recipient, providerName)}`;
    if (previous.from === 'user') return head;
    const prevName = providerName(previous.from);
    return `${head}\n下面是 ${prevName} 的回复：\n<来自 ${prevName}>：\n${previous.text}`;
  }
  const blocks = fromUser.map(userBlock);
  if (previous.from !== 'user') blocks.push(`<来自 ${providerName(previous.from)}>：\n${previous.text}`);
  return blocks.join('\n\n');
}

export interface RelayDependencies {
  checkAborted: (workflowId: string) => void;
  providerName: (provider: AIProvider) => string;
  isIntroduced: (provider: AIProvider) => boolean;
  markIntroduced: (provider: AIProvider) => void;
  takeInjected: () => string[];
  createRequestId: (provider: AIProvider, workflowId: string) => string;
  sendStatus: (turn: number, total: number, provider: AIProvider) => Promise<void> | void;
  sendAndWait: (provider: AIProvider, prompt: string, workflowId: string, requestId: string) => Promise<string>;
  /** Ask the panel what to do after a failed step (retry / reread / manual / skip / cancel). */
  requestRecovery: (provider: AIProvider, error: unknown, workflowId: string, failedRequestId: string) => Promise<StepRecoveryAction>;
  takeManualText: () => string | undefined;
  rereadReply: (provider: AIProvider, prompt: string) => Promise<string | null>;
  /** Show a recovered reply (reread or pasted) in the transcript. */
  publishReply: (provider: AIProvider, text: string, workflowId: string) => void;
  resetProvider: (provider: AIProvider, failedRequestId: string, workflowId: string) => Promise<void>;
  cancelWorkflow: (workflowId: string) => Promise<void>;
}

export interface RelayTurnRecord {
  provider: AIProvider;
  text: string;
}

export async function runRelayWorkflow(
  firstMessage: string,
  participants: readonly AIProvider[],
  turns: number,
  workflowId: string,
  deps: RelayDependencies,
): Promise<RelayTurnRecord[]> {
  if (participants.length === 0) throw new Error('No participants');
  const total = participants.length === 1 ? 1 : Math.max(1, turns);
  const history: RelayTurnRecord[] = [];
  const spoke = new Set<AIProvider>();
  let previous: RelayIncoming = { from: 'user', text: firstMessage };

  for (let turn = 0; turn < total; turn += 1) {
    deps.checkAborted(workflowId);
    const provider = participants[turn % participants.length];
    const injected = turn > 0 ? deps.takeInjected() : [];
    const prompt = formatRelayPrompt({
      participants,
      recipient: provider,
      topic: firstMessage,
      previous,
      introduced: deps.isIntroduced(provider),
      spokeThisRun: spoke.has(provider),
      injected,
      providerName: deps.providerName,
    });
    await deps.sendStatus(turn + 1, total, provider);
    const reply = await runRecoverableRelayStep(provider, prompt, workflowId, deps);
    deps.markIntroduced(provider);
    spoke.add(provider);
    // A skipped turn passes the previous message on unchanged.
    if (reply) {
      history.push({ provider, text: reply });
      previous = { from: provider, text: reply };
    }
  }
  return history;
}

async function runRecoverableRelayStep(
  provider: AIProvider,
  prompt: string,
  workflowId: string,
  deps: RelayDependencies,
): Promise<string> {
  let resend = true;
  let requestId = deps.createRequestId(provider, workflowId);
  for (;;) {
    deps.checkAborted(workflowId);
    let failure: unknown;
    if (resend) {
      requestId = deps.createRequestId(provider, workflowId);
      try {
        const reply = await deps.sendAndWait(provider, prompt, workflowId, requestId);
        if (reply.trim()) return reply;
        failure = new ProviderRequestError(provider, workflowId, requestId, 'empty reply', true);
      } catch (error) {
        if (!(error instanceof ProviderRequestError)) throw error;
        failure = error;
      }
    } else {
      failure = new ProviderRequestError(provider, workflowId, requestId, 'reply still not found', true);
    }
    deps.checkAborted(workflowId);
    const action = await deps.requestRecovery(provider, failure, workflowId, requestId);
    deps.checkAborted(workflowId);
    if (action === 'manual') {
      const text = deps.takeManualText()?.trim();
      if (text) {
        deps.publishReply(provider, text, workflowId);
        return text;
      }
      resend = false;
      continue;
    }
    if (action === 'reread') {
      const text = (await deps.rereadReply(provider, prompt))?.trim();
      deps.checkAborted(workflowId);
      if (text) {
        deps.publishReply(provider, text, workflowId);
        return text;
      }
      resend = false;
      continue;
    }
    await deps.resetProvider(provider, requestId, workflowId);
    if (action === 'retry') {
      resend = true;
      continue;
    }
    if (action === 'skip') return '';
    await deps.cancelWorkflow(workflowId);
    throw new DOMException('Workflow cancelled', 'AbortError');
  }
}
