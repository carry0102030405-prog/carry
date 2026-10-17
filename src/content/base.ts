import type { AIProvider, ExtensionMessage } from '../shared/types';
import { encodeError } from '../shared/errors';
import {
  extractResponseContent,
  longerResponseText,
  type ResponseContentRoot,
} from './responseSerializer';
import { isActiveContentRequest, shouldStopContentRequest } from '../shared/requestScope';
import { decideLoginStatus, type LoginStatusState } from './loginStatusStability';
import { focusWithoutScroll } from './focusWithoutScroll';
import { firstAcceptedCandidate } from './elementSelection';
import {
  clearedComposerConfirmsSend,
  contentMatchesPrompt,
  generationSignalBelongsToCurrentTurn,
  matchingPromptCount,
} from './sendConfirmation';
import {
  cleanReplyText,
  collectPromptEchoes,
  findPromptEcho,
  GENERIC_RESPONSE_SELECTORS,
  GENERIC_USER_MESSAGE_SELECTORS,
  newReplyAfterSend,
  type ResponseBaseline,
  isGenericStopButton,
  looseMatchesPrompt,
  readGenericReply,
} from './genericReply';
import {
  captureSemanticResponseBaseline,
  currentSemanticResponseText,
  isActiveResponseGeneration,
  responsesFollowingAnchor,
  type SemanticResponseBaseline,
} from './responseTracking';
import { firstVisibleSelector, isElementVisible } from './visibility';
import { ReplyStabilityTracker } from './replyStability';
import { collectContentDiagnostics } from './diagnostics';
import { DiagLog } from '../shared/diagLog';

export interface ContentScriptConfig {
  provider: AIProvider;
  inputSelectors: string[];
  requireVisibleInput?: boolean;
  inputFilter?: (element: Element) => boolean;
  sendButtonSelectors: string[];
  sendButtonFilter?: (element: Element) => boolean;
  userMessageSelectors?: string[];
  userMessageTracking?: 'element-identity' | 'semantic-count';
  requireSameComposerForClearConfirmation?: boolean;
  responseSelectors: string[];
  responseTracking?: 'element-identity' | 'semantic-latest';
  requireMatchingUserMessageForGenerationSignals?: boolean;
  anchorSemanticResponsesAfterMatchingUserMessage?: boolean;
  responseContentRoot?: ResponseContentRoot;
  stopButtonSelectors?: string[];
  stopButtonFilter?: (element: Element) => boolean;
  loginDetector: () => boolean | null;
  loggedOutDetector?: () => boolean;
  loginLossDelay?: number;
  isThinking?: () => boolean;
  // Busy indicators (Stop buttons, spinners). Only *visible* matches count as generating.
  thinkingSelectors?: string[];
  thinkingFilter?: (element: Element) => boolean;
  // Some providers keep their busy/Stop signal active throughout answer streaming.
  // Allow chunks while that signal still prevents premature completion.
  streamWhileThinking?: boolean;
  injectInput?: (element: Element, text: string) => void | Promise<void>;
  doneDelay?: number;
  chunkDebounce?: number;
  // Fall back to provider-agnostic reply detection when the specific selectors find nothing.
  enableGenericReplyFallback?: boolean;
}

interface SendActivationResult {
  ok: boolean;
  path: 'button-click' | 'enter-key';
  detail?: string;
}

const INPUT_RETRY_MS = 250;
const INPUT_TIMEOUT_MS = 2500;
const SEND_BUTTON_TIMEOUT_MS = 800;
const PRE_SEND_DELAY_MS = 800;
const SEND_RETRY_DELAY_MS = 1500;
const SEND_CONFIRMATION_GRACE_MS = 2000;
const SEND_VERIFY_DELAY_MS = 1500;
// 送出成功但完全抓不到回應時，至少等這麼久才放棄。慢的模型（深度思考、搜尋）
// 常常好幾十秒才吐出第一個字，而 isThinking() 只靠硬寫的選擇器，漏判是常態。
// notes: 固定 2 分鐘，遠短於背景的 600 秒逾時；若真出現更慢的模型再拉長
const NO_RESPONSE_GRACE_MS = 120_000;
// Give the provider-specific selectors a head start before the generic detector kicks in.
const GENERIC_FALLBACK_AFTER_MS = 5_000;
const GENERIC_FALLBACK_THROTTLE_MS = 1_000;
const NEW_ELEMENT_THROTTLE_MS = 400;
const POLL_INTERVAL_MS = 1_000;
const IDLE_POLL_MARGIN_MS = 1_500;
const PREVIEW_CHARS = 300;

export function createContentScript(config: ContentScriptConfig): void {
  const marker = `__multiAiChat_${config.provider}`;
  const scope = window as unknown as Record<string, unknown>;
  const existing = scope[marker] as { dispose?: () => void } | undefined;
  try {
    existing?.dispose?.();
  } catch {
    delete scope[marker];
  }
  const runtimeState: { dispose?: () => void } = {};
  scope[marker] = runtimeState;

  const {
    provider,
    inputSelectors,
    requireVisibleInput = false,
    inputFilter = () => true,
    responseSelectors,
    responseTracking = 'element-identity',
    requireMatchingUserMessageForGenerationSignals = false,
    anchorSemanticResponsesAfterMatchingUserMessage = false,
    responseContentRoot = (response) => response,
    userMessageTracking = 'element-identity',
    loginDetector,
    loggedOutDetector = () => false,
    loginLossDelay = 0,
    isThinking = () => false,
    thinkingSelectors = [],
    thinkingFilter = () => true,
    streamWhileThinking = false,
    injectInput = defaultInjectInput,
    doneDelay = 3000,
    chunkDebounce = 500,
    enableGenericReplyFallback = true,
  } = config;

  let statusInterval: ReturnType<typeof setInterval> | undefined;
  let responseTimeout: ReturnType<typeof setTimeout> | undefined;
  let checkDoneInterval: ReturnType<typeof setInterval> | undefined;
  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let responseBaselineEls = new Set<Element>();
  let semanticResponseBaseline: SemanticResponseBaseline = { count: 0, latestText: '' };
  let userMessageBaselineEls = new Set<Element>();
  let matchingUserMessageBaselineCount = 0;
  let sawMatchingUserMessage = false;
  let matchingUserMessageElement: Element | undefined;
  let waitingForResponse = false;
  let lastResponseText = '';
  let lastChunkTime = 0;
  let activeRequestId: string | undefined;
  let activeWorkflowId: string | undefined;
  let responseObserver: MutationObserver | undefined;
  let sawGenerationActivity = false;
  let loginStatusState: LoginStatusState = {};
  let loginStatusTimeout: ReturnType<typeof setTimeout> | undefined;
  let responseWaitStartedAt = 0;
  let activePromptText = '';
  let lastActivatedInput: Element | undefined;
  let disposed = false;
  let responseGeneration = 0;
  let failedRequestTombstone: { requestId?: string; workflowId?: string } | undefined;
  let lastPromptText = '';
  let usingGenericFallback = false;
  let genericCache: { at: number; prompt: string; text: string | null } | undefined;
  const sendTimeouts = new Set<number>();
  const log = new DiagLog();
  const stability = new ReplyStabilityTracker();
  let responseCountBaseline: ResponseBaseline = { count: 0, elements: new Set() };
  let newElementCache: { at: number; text: string | null } | undefined;
  let lastSignal: string | null = null;
  let preSendEchoes = new Set<Element>();
  let replySource = '';
  let loggedSendConfirmed = false;
  let lastLoggedCandidateLength = -1;

  const queryInput = (): Element | null => queryFirst(
    inputSelectors,
    document,
    requireVisibleInput,
    inputFilter,
  );

  function isContextValid(): boolean {
    if (disposed || scope[marker] !== runtimeState) return false;
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function safeSendMessage(message: ExtensionMessage): void {
    if (!isContextValid()) {
      cleanup();
      return;
    }
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  function cleanup(): void {
    if (disposed) return;
    disposed = true;
    waitingForResponse = false;
    activeRequestId = undefined;
    activeWorkflowId = undefined;
    activePromptText = '';
    lastActivatedInput = undefined;
    failedRequestTombstone = undefined;
    clearResponseTimers();
    if (statusInterval !== undefined) clearInterval(statusInterval);
    statusInterval = undefined;
    if (loginStatusTimeout !== undefined) clearTimeout(loginStatusTimeout);
    loginStatusTimeout = undefined;
    responseObserver?.disconnect();
    responseObserver = undefined;
    try {
      chrome.runtime.onMessage.removeListener(runtimeListener);
    } catch {}
    if (scope[marker] === runtimeState) delete scope[marker];
  }

  function reportStatus(force = false): void {
    if (!isContextValid()) {
      cleanup();
      return;
    }
    const decision = decideLoginStatus(loginStatusState, {
      ready: loginDetector(),
      explicitlyLoggedOut: loggedOutDetector(),
      now: Date.now(),
      lossDelayMs: loginLossDelay,
    });
    loginStatusState = decision.state;

    if (loginStatusTimeout !== undefined) clearTimeout(loginStatusTimeout);
    loginStatusTimeout = undefined;
    if (decision.retryInMs !== undefined) {
      loginStatusTimeout = setTimeout(reportStatus, decision.retryInMs);
    }
    const statusToReport = decision.report !== undefined
      ? decision.report
      : force ? decision.state.reported : undefined;
    if (statusToReport === undefined) return;
    safeSendMessage({ action: 'STATUS_REPORT', provider, payload: { loggedIn: statusToReport } });
  }

  async function sendMessage(text: string, requestId?: string, workflowId?: string): Promise<void> {
    if (!text.trim()) throw new Error(encodeError('error.empty_message'));
    if (waitingForResponse) throw new Error(encodeError('error.response_in_progress', { provider }));

    const input = await retryLookup(queryInput, INPUT_TIMEOUT_MS, isContextValid);
    if (!input) {
      const reason = encodeError('error.input_not_found', { provider });
      finishWithError(reason, requestId, workflowId);
      throw new Error(reason);
    }

    const existingResponses = queryResponses();
    responseBaselineEls = new Set(existingResponses);
    matchingUserMessageElement = undefined;
    semanticResponseBaseline = captureSemanticResponseBaseline(
      querySemanticResponses(),
      extractResponseText,
    );
    responseGeneration += 1;
    userMessageBaselineEls = new Set(queryUserMessages());
    matchingUserMessageBaselineCount = matchingPromptCount(
      Array.from(userMessageBaselineEls, (element) => element.textContent ?? ''),
      text,
    );
    sawMatchingUserMessage = false;
    waitingForResponse = true;
    activeRequestId = requestId;
    activeWorkflowId = workflowId;
    // This SEND is now the active request. Recovery always consumes a settled failure's
    // tombstone before starting Retry, and no older cleanup may target this newer request.
    failedRequestTombstone = undefined;
    lastResponseText = '';
    sawGenerationActivity = false;
    responseWaitStartedAt = Date.now();
    activePromptText = text;
    lastPromptText = text;
    usingGenericFallback = false;
    genericCache = undefined;
    newElementCache = undefined;
    try {
      preSendEchoes = collectPromptEchoes(document, { prompt: text, userSelectors: [...(config.userMessageSelectors ?? []), ...GENERIC_USER_MESSAGE_SELECTORS] });
    } catch {
      preSendEchoes = new Set();
    }
    const countable = queryCountableResponses();
    responseCountBaseline = { count: countable.length, elements: new Set(countable) };
    stability.reset();
    replySource = '';
    loggedSendConfirmed = false;
    lastLoggedCandidateLength = -1;
    log.add('send.start', { requestId, workflowId, promptChars: text.length, promptHead: text.slice(0, 120), baselineResponses: countable.length, preSendEchoes: preSendEchoes.size, url: globalThis.location?.href });
    lastActivatedInput = undefined;
    startResponsePolling();

    const injectionStartedAt = Date.now();
    try {
      if (!isActiveRequest(requestId)) throw new Error('request cancelled before input injection');
      await injectInput(input, text);
      await Promise.resolve();
      if (!isActiveRequest(requestId)) throw new Error('request cancelled during input injection');
      assertInputLanded(input, text);
      log.add('send.injected', { composerChars: getInputText(input).length });
    } catch (error) {
      log.add('send.inject_failed', { error: errorMessage(error) });
      finishWithError(encodeError('error.input_injection_failed', { provider, detail: errorMessage(error) }), requestId, workflowId);
      throw error;
    }

    const delay = Math.max(0, PRE_SEND_DELAY_MS - (Date.now() - injectionStartedAt));
    scheduleForRequest(() => {
      void (async () => {
        const firstAttempt = await activateSend(text, requestId);
        log.add('send.activate', firstAttempt);
        scheduleForRequest(
          () => void retrySendIfStillPending(text, firstAttempt, requestId),
          SEND_RETRY_DELAY_MS,
          requestId,
        );
      })();
    }, delay, requestId);
  }

  async function retrySendIfStillPending(text: string, firstAttempt: SendActivationResult, requestId?: string): Promise<void> {
    if (!isActiveRequest(requestId) || sendStarted()) return;
    if (firstAttempt.ok && await waitForSendConfirmation(requestId, SEND_CONFIRMATION_GRACE_MS)) return;
    if (!isActiveRequest(requestId)) return;
    const retryAttempt = await activateSend(text, requestId);
    log.add('send.retry', retryAttempt);
    if (!isActiveRequest(requestId)) return;
    if (!retryAttempt.ok) {
      finishWithError(encodeError('error.send_failed', { provider, detail: retryAttempt.detail ?? firstAttempt.detail ?? retryAttempt.path }));
      return;
    }
    scheduleForRequest(
      () => void verifySendAfterRetry(text, requestId),
      SEND_VERIFY_DELAY_MS,
      requestId,
    );
  }

  async function waitForSendConfirmation(requestId: string | undefined, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (isActiveRequest(requestId) && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (isActiveRequest(requestId) && sendStarted()) return true;
    }
    return false;
  }

  async function verifySendAfterRetry(text: string, requestId?: string): Promise<void> {
    if (!isActiveRequest(requestId) || sendStarted()) return;
    if (await waitForSendConfirmation(requestId, SEND_CONFIRMATION_GRACE_MS)) return;
    if (!isActiveRequest(requestId)) return;
    let currentInput: Element | null;
    try {
      currentInput = await prepareLiveInput(text, requestId);
    } catch (error) {
      finishWithError(encodeError('error.send_failed', { provider, detail: errorMessage(error) }));
      return;
    }
    if (!isActiveRequest(requestId)) return;
    if (!currentInput) {
      finishWithError(encodeError('error.input_disappeared', { provider }));
      return;
    }
    lastActivatedInput = currentInput;
    const enterOk = dispatchEnter(currentInput);
    if (!enterOk) {
      finishWithError(encodeError('error.send_failed', { provider, detail: 'Enter dispatch failed' }));
      return;
    }
    scheduleForRequest(() => {
      if (!isActiveRequest(requestId) || sendStarted()) return;
      finishWithError(encodeError('error.send_rejected', { provider }));
    }, SEND_VERIFY_DELAY_MS, requestId);
  }

  async function activateSend(text: string, requestId?: string): Promise<SendActivationResult> {
    let input: Element | null;
    try {
      input = await prepareLiveInput(text, requestId);
    } catch (error) {
      return { ok: false, path: 'enter-key', detail: errorMessage(error) };
    }
    if (!input) return { ok: false, path: 'enter-key', detail: 'input disappeared' };
    lastActivatedInput = input;
    const sendButton = await retryLookup(
      () => querySendButton(input),
      SEND_BUTTON_TIMEOUT_MS,
      () => isActiveRequest(requestId),
    );
    if (!isActiveRequest(requestId)) return { ok: false, path: 'enter-key', detail: 'request cancelled' };
    if (sendButton && !isDisabled(sendButton) && clickElement(sendButton)) return { ok: true, path: 'button-click' };
    const ok = dispatchEnter(input);
    return { ok, path: 'enter-key', detail: ok ? undefined : 'Enter dispatch failed' };
  }

  async function prepareLiveInput(text: string, requestId?: string): Promise<Element | null> {
    if (!isActiveRequest(requestId)) return null;
    const input = await retryLookup(
      queryInput,
      INPUT_TIMEOUT_MS,
      () => isActiveRequest(requestId),
    );
    if (!input || !isActiveRequest(requestId)) return null;
    if (composerTextMatches(input, text)) return input;
    if (!isActiveRequest(requestId)) return null;
    await injectInput(input, text);
    await Promise.resolve();
    if (!isActiveRequest(requestId)) return null;
    assertInputLanded(input, text);
    return input;
  }

  function querySendButton(input: Element): Element | null {
    const container = input.closest?.('form, fieldset, [data-testid*="composer"], [class*="composer"], [class*="input-area"]');
    if (container) {
      const local = queryFirst(config.sendButtonSelectors, container, true, config.sendButtonFilter);
      if (local) return local;
    }
    return queryFirst(config.sendButtonSelectors, document, true, config.sendButtonFilter);
  }

  function queryUserMessages(): Element[] {
    const selectors = config.userMessageSelectors ?? [];
    return selectors.length ? Array.from(document.querySelectorAll(selectors.join(', '))) : [];
  }

  function hasNewMatchingUserMessage(): boolean {
    if (sawMatchingUserMessage) {
      if (!anchorSemanticResponsesAfterMatchingUserMessage || matchingUserMessageElement?.isConnected) {
        return true;
      }
      // React may remount the confirmed user bubble. Reacquire the actual live element so
      // compareDocumentPosition keeps anchoring responses to the current conversation tree.
      sawMatchingUserMessage = false;
      matchingUserMessageElement = undefined;
    }
    const messages = queryUserMessages();
    if (userMessageTracking === 'semantic-count') {
      const matchingMessages = messages.filter((element) => (
        contentMatchesPrompt(element.textContent ?? '', activePromptText)
        || looseMatchesPrompt(element.textContent ?? '', activePromptText)
      ));
      sawMatchingUserMessage = matchingMessages.length > matchingUserMessageBaselineCount;
      if (sawMatchingUserMessage) {
        matchingUserMessageElement = matchingMessages[matchingMessages.length - 1];
      }
      return sawMatchingUserMessage;
    }
    matchingUserMessageElement = messages.find((element) => (
      !userMessageBaselineEls.has(element)
      && (contentMatchesPrompt(element.textContent ?? '', activePromptText)
        || looseMatchesPrompt(element.textContent ?? '', activePromptText))
    ));
    sawMatchingUserMessage = Boolean(matchingUserMessageElement);
    return sawMatchingUserMessage;
  }

  function sendStarted(): boolean {
    const started = sendStartedCheck();
    if (started && waitingForResponse && !loggedSendConfirmed) {
      loggedSendConfirmed = true;
      log.add('send.confirmed', { signal: lastSignal, anchor: sawMatchingUserMessage });
    }
    return started;
  }

  function sendStartedCheck(): boolean {
    if (!waitingForResponse) return true;
    if (isCurrentTurnThinking()) {
      sawGenerationActivity = true;
      return true;
    }
    const hasCurrentResponse = responseTracking === 'semantic-latest'
      ? Boolean(getLatestResponseText())
      : queryResponses().some((element) => !responseBaselineEls.has(element));
    if (hasCurrentResponse) {
      sawGenerationActivity = true;
      return true;
    }
    const hasNewUserMessage = hasNewMatchingUserMessage();
    if (hasNewUserMessage) {
      sawGenerationActivity = true;
      return true;
    }
    const input = queryInput();
    const cleared = Boolean(input && !getInputText(input).trim());
    const confirmedByClear = cleared && clearedComposerConfirmsSend(
      lastActivatedInput,
      input,
      Boolean(config.requireSameComposerForClearConfirmation),
      hasNewUserMessage,
    );
    if (confirmedByClear) sawGenerationActivity = true;
    return confirmedByClear;
  }

  /** Which visible busy signal is active right now (null = none). */
  function generationSignal(): string | null {
    if (thinkingSelectors.length) {
      const selector = firstVisibleSelector(thinkingSelectors, document, isElementVisible, thinkingFilter);
      if (selector) return `selector:${selector}`;
    }
    let custom = false;
    try {
      custom = isThinking();
    } catch {
      custom = false;
    }
    if (custom) return 'provider:isThinking';
    const stop = genericStopButton();
    if (stop) return `generic-stop:${stop.getAttribute('aria-label') ?? stop.getAttribute('title') ?? stop.getAttribute('data-testid') ?? ''}`;
    return null;
  }

  function isCurrentTurnThinking(): boolean {
    const current = generationSignal();
    if (current !== lastSignal) {
      if (waitingForResponse) log.add('signal', { from: lastSignal, to: current });
      lastSignal = current;
    }
    const signal = Boolean(current);
    if (usingGenericFallback) return signal;
    return generationSignalBelongsToCurrentTurn(
      signal,
      requireMatchingUserMessageForGenerationSignals,
      hasNewMatchingUserMessage(),
    );
  }

  function genericStopButton(): Element | undefined {
    return Array.from(document.querySelectorAll('button'))
      .find((button) => isGenericStopButton(button) && isElementVisible(button));
  }

  function genericGenerationActive(): boolean {
    return Boolean(genericStopButton());
  }

  function queryCountableResponses(): Element[] {
    const selectors = [...new Set([...responseSelectors, ...GENERIC_RESPONSE_SELECTORS])];
    const found = new Set<Element>();
    for (const selector of selectors) {
      try {
        for (const element of Array.from(document.querySelectorAll(selector))) found.add(element);
      } catch {}
    }
    // Document order, so "the last one" is the newest.
    const list = Array.from(found);
    try {
      list.sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
    } catch {}
    return list;
  }

  function readNewResponseElement(force = false): string | null {
    const now = Date.now();
    if (!force && newElementCache && now - newElementCache.at < NEW_ELEMENT_THROTTLE_MS) return newElementCache.text;
    let text: string | null = null;
    try {
      text = newReplyAfterSend(queryCountableResponses(), responseCountBaseline, {
        prompt: activePromptText,
        userSelectors: config.userMessageSelectors ?? [],
        readText: extractResponseText,
      });
    } catch {
      text = null;
    }
    newElementCache = { at: now, text };
    return text;
  }

  function readGenericReplyFor(prompt: string, force = false): string | null {
    if (!prompt) return null;
    const now = Date.now();
    if (!force && genericCache && genericCache.prompt === prompt && now - genericCache.at < GENERIC_FALLBACK_THROTTLE_MS) {
      return genericCache.text;
    }
    let text: string | null = null;
    try {
      text = readGenericReply(document, {
        prompt,
        // While waiting, ignore copies of the same text that were on the page before we sent.
        skip: waitingForResponse && prompt === activePromptText ? preSendEchoes : undefined,
        userSelectors: [...(config.userMessageSelectors ?? []), ...GENERIC_USER_MESSAGE_SELECTORS],
        responseSelectors,
        readText: extractResponseText,
      });
    } catch {
      text = null;
    }
    genericCache = { at: now, prompt, text };
    return text;
  }

  function getLatestResponseText(): string | null {
    const specific = getSpecificResponseText();
    if (specific) {
      usingGenericFallback = false;
      replySource = 'specific';
      return specific;
    }
    if (!enableGenericReplyFallback || !waitingForResponse) return null;
    // Any assistant-looking element that was not there before we sent is the reply.
    const fresh = readNewResponseElement();
    if (fresh) {
      usingGenericFallback = true;
      replySource = 'new-element';
      return fresh;
    }
    if (Date.now() - responseWaitStartedAt < GENERIC_FALLBACK_AFTER_MS) return null;
    const generic = readGenericReplyFor(activePromptText);
    if (generic) {
      usingGenericFallback = true;
      replySource = 'after-echo';
    }
    return generic;
  }

  function getSpecificResponseText(): string | null {
    const currentTurnConfirmed = !requireMatchingUserMessageForGenerationSignals
      || hasNewMatchingUserMessage();
    if (responseTracking === 'semantic-latest') {
      return currentSemanticResponseText(
        querySemanticResponses(),
        semanticResponseBaseline,
        extractResponseText,
        currentTurnConfirmed,
      );
    }
    if (!currentTurnConfirmed) return null;
    const responses = queryResponses();
    for (let index = responses.length - 1; index >= 0; index -= 1) {
      const response = responses[index];
      if (waitingForResponse && responseBaselineEls.has(response)) continue;
      const text = extractResponseText(response);
      if (text) return text;
    }
    return null;
  }

  function queryResponses(): Element[] {
    return Array.from(document.querySelectorAll(responseSelectors.join(', ')));
  }

  function querySemanticResponses(): Element[] {
    // In semantic mode selectors are ordered primary-first. Taking the first selector with
    // matches avoids counting both an assistant wrapper and its nested markdown as two turns.
    for (const selector of responseSelectors) {
      const responses = Array.from(document.querySelectorAll(selector));
      if (!responses.length) continue;
      if (!anchorSemanticResponsesAfterMatchingUserMessage) return responses;
      if (!matchingUserMessageElement) return [];
      const anchoredResponses = responsesFollowingAnchor<Element>(responses, matchingUserMessageElement);
      if (anchoredResponses.length) return anchoredResponses;
    }
    return [];
  }

  function extractResponseText(response: Element): string | null {
    const text = extractResponseContent(response, responseContentRoot);
    return text ? cleanReplyText(text) || null : null;
  }

  function observeResponses(): void {
    responseObserver = new MutationObserver(() => {
      // Claude/SPA composers mount several seconds after load; re-report the moment
      // login state flips so the card reaches "ready" without waiting for the 10s poll.
      reportStatus();
      if (!waitingForResponse || (isCurrentTurnThinking() && !streamWhileThinking)) return;
      updateResponse();
    });
    responseObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function updateResponse(): void {
    const currentText = getLatestResponseText();
    if (!currentText || currentText === lastResponseText) return;
    sawGenerationActivity = true;
    lastResponseText = currentText;
    const now = Date.now();
    if (now - lastChunkTime >= chunkDebounce) {
      lastChunkTime = now;
      safeSendMessage({
        action: 'RESPONSE_CHUNK',
        provider,
        requestId: activeRequestId,
        workflowId: activeWorkflowId,
        payload: currentText,
      });
    }
    if (responseTimeout !== undefined) clearTimeout(responseTimeout);
    scheduleResponseTimeout(checkIfDone, doneDelay);
  }

  function startResponsePolling(): void {
    if (pollInterval !== undefined) return;
    const generation = responseGeneration;
    const timer = setInterval(() => {
      if (!isCurrentResponseGeneration(generation)) {
        clearInterval(timer);
        if (pollInterval === timer) pollInterval = undefined;
        return;
      }
      pollOnce(generation);
    }, POLL_INTERVAL_MS);
    pollInterval = timer;
  }

  // One detection pass. Driven by the 1 s interval and, because Chrome throttles timers in
  // background tabs (down to once a minute after a while), also by POKE_REQUEST messages from
  // the service worker, which are delivered without throttling. All waits are measured with
  // Date.now(), so a late pass still completes as soon as it runs.
  function pollOnce(generation = responseGeneration): void {
    if (!isCurrentResponseGeneration(generation)) return;
    {
      const thinking = isCurrentTurnThinking();
      // Always read the candidate so a stuck busy signal cannot hide a finished reply.
      const currentText = getLatestResponseText();
      const now = Date.now();
      stability.observe(currentText, now);
      if (currentText && currentText.length !== lastLoggedCandidateLength) {
        lastLoggedCandidateLength = currentText.length;
        log.add('reply.candidate', { source: replySource, chars: currentText.length, head: currentText.slice(0, 80), signal: lastSignal });
      }
      if (currentText && stability.shouldForceComplete(now)) {
        log.add('reply.stable_override', { stableForMs: stability.stableForMs(now), signal: lastSignal, chars: currentText.length });
        lastResponseText = longerResponseText(lastResponseText, currentText);
        finishResponse(generation, 'stable-override');
        return;
      }
      if (thinking) {
        sawGenerationActivity = true;
        if (!streamWhileThinking) return;
      }
      if (currentText) {
        updateResponse();
        // Backstop for a throttled doneDelay timer: quiet long enough and not busy → done.
        if (!thinking && isCurrentResponseGeneration(generation) && stability.stableForMs(Date.now()) >= doneDelay + IDLE_POLL_MARGIN_MS) {
          finishResponse(generation, 'idle-poll');
        }
        return;
      }
      // Reading chunks during generation must not start the no-response timeout
      // while a slow provider still reports that it is working.
      if (thinking) return;
      // sawGenerationActivity 只代表「送出去了」（輸入框被清空也算），不代表真的產生過內容，
      // 所以這條路徑必須等滿寬限期才收尾，否則慢的模型會在送出後幾秒就被判定沒有回應。
      if (!sawGenerationActivity || responseTimeout !== undefined) return;
      if (Date.now() - responseWaitStartedAt < NO_RESPONSE_GRACE_MS) return;
      scheduleResponseTimeout(() => {
        const finalText = getLatestResponseText();
        if (finalText) {
          lastResponseText = finalText;
          finishResponse();
          return;
        }
        log.add('reply.none', { elapsedMs: Date.now() - responseWaitStartedAt });
        // 報錯而非填佔位字串：假答案會被背景當成正常結果，餵進下一棒的 prompt。
        finishWithError(encodeError('error.no_response_text', { provider }));
      }, doneDelay, generation);
    }
  }

  function checkIfDone(generation = responseGeneration): void {
    if (!isCurrentResponseGeneration(generation)) return;
    if (isCurrentTurnThinking()) {
      if (checkDoneInterval === undefined) {
        const timer = setInterval(() => {
          if (!isCurrentResponseGeneration(generation)) return clearDoneCheck(timer);
          if (!isCurrentTurnThinking()) {
            clearDoneCheck(timer);
            scheduleResponseTimeout((active) => finishResponse(active, 'signal-cleared'), doneDelay, generation);
          }
        }, 1000);
        checkDoneInterval = timer;
      }
      return;
    }
    finishResponse(generation, 'idle');
  }

  function finishResponse(generation = responseGeneration, reason = 'done'): void {
    if (!isCurrentResponseGeneration(generation)) return;
    // Must re-read before resetResponseState(): the baseline filter keys off waitingForResponse.
    const text = longerResponseText(lastResponseText, getLatestResponseText());
    log.add('reply.done', { reason, source: replySource, chars: text.length, head: text.slice(0, 120) });
    const requestId = activeRequestId;
    const workflowId = activeWorkflowId;
    resetResponseState();
    failedRequestTombstone = undefined;
    safeSendMessage({ action: 'RESPONSE_DONE', provider, requestId, workflowId, payload: text });
  }

  function finishWithError(reason: string, requestId = activeRequestId, workflowId = activeWorkflowId): void {
    const settlesActiveRequest = waitingForResponse
      && requestId === activeRequestId
      && workflowId === activeWorkflowId;
    const failedRequest = settlesActiveRequest && (requestId !== undefined || workflowId !== undefined)
      ? { requestId, workflowId }
      : undefined;
    log.add('reply.error', { reason });
    resetResponseState();
    // Recovery arrives after RESPONSE_DONE has settled the background waiter. Keep only this
    // exact failed identity so its later scoped STOP can still click a provider stream that
    // outlived our local timeout. Starting any newer SEND clears the tombstone first.
    if (failedRequest) failedRequestTombstone = failedRequest;
    safeSendMessage({ action: 'RESPONSE_DONE', provider, requestId, workflowId, payload: `[Error: ${reason}]` });
  }

  function stopGeneration(requestId?: string, workflowId?: string): boolean {
    if (!shouldStopContentRequest(
      waitingForResponse,
      activeRequestId,
      activeWorkflowId,
      failedRequestTombstone?.requestId,
      failedRequestTombstone?.workflowId,
      requestId,
      workflowId,
    )) return false;
    const stopButton = queryFirst(
      config.stopButtonSelectors ?? [],
      document,
      true,
      config.stopButtonFilter,
    );
    if (stopButton) clickElement(stopButton);
    log.add('stop', { clicked: Boolean(stopButton) });
    resetResponseState();
    failedRequestTombstone = undefined;
    return true;
  }

  function resetResponseState(): void {
    waitingForResponse = false;
    responseGeneration += 1;
    clearResponseTimers();
    responseBaselineEls.clear();
    semanticResponseBaseline = { count: 0, latestText: '' };
    userMessageBaselineEls.clear();
    matchingUserMessageBaselineCount = 0;
    sawMatchingUserMessage = false;
    matchingUserMessageElement = undefined;
    activeRequestId = undefined;
    activeWorkflowId = undefined;
    activePromptText = '';
    lastActivatedInput = undefined;
    sawGenerationActivity = false;
  }

  function isActiveRequest(requestId?: string): boolean {
    return isActiveContentRequest(
      disposed,
      runtimeState,
      scope[marker],
      waitingForResponse,
      activeRequestId,
      requestId,
    );
  }

  function scheduleForRequest(callback: () => void, delay: number, requestId = activeRequestId): void {
    const timer = window.setTimeout(() => {
      sendTimeouts.delete(timer);
      if (isActiveRequest(requestId)) callback();
    }, delay);
    sendTimeouts.add(timer);
  }

  function scheduleResponseTimeout(
    callback: (generation: number) => void,
    delay: number,
    generation = responseGeneration,
  ): void {
    if (responseTimeout !== undefined) clearTimeout(responseTimeout);
    const timer = setTimeout(() => {
      if (responseTimeout === timer) responseTimeout = undefined;
      if (isCurrentResponseGeneration(generation)) callback(generation);
    }, delay);
    responseTimeout = timer;
  }

  function isCurrentResponseGeneration(generation: number): boolean {
    return isActiveResponseGeneration(waitingForResponse, responseGeneration, generation);
  }

  function clearDoneCheck(timer = checkDoneInterval): void {
    if (timer !== undefined) clearInterval(timer);
    if (checkDoneInterval === timer) checkDoneInterval = undefined;
  }

  function clearResponseTimers(): void {
    if (responseTimeout !== undefined) clearTimeout(responseTimeout);
    if (pollInterval !== undefined) clearInterval(pollInterval);
    clearDoneCheck();
    responseTimeout = undefined;
    pollInterval = undefined;
    for (const timer of sendTimeouts) window.clearTimeout(timer);
    sendTimeouts.clear();
  }

  const runtimeListener = (message: ExtensionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    if (message.action === 'SEND_MESSAGE' && message.provider === provider) {
      const { text = '' } = (message.payload as { text?: string } | undefined) ?? {};
      void sendMessage(text, message.requestId, message.workflowId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;
    }
    if (message.action === 'READ_LATEST_REPLY' && message.provider === provider) {
      const { prompt = '' } = (message.payload as { prompt?: string } | undefined) ?? {};
      const target = prompt || lastPromptText;
      let text: string | null = null;
      try {
        text = readGenericReplyFor(target, true);
      } catch {
        text = null;
      }
      log.add('reread', { ok: Boolean(text), chars: text?.length ?? 0 });
      sendResponse({ ok: Boolean(text), text: text ?? '', generating: Boolean(generationSignal()) });
      return true;
    }
    if (message.action === 'POKE_REQUEST' && message.provider === provider) {
      if (waitingForResponse && (!message.requestId || message.requestId === activeRequestId)) pollOnce(responseGeneration);
      sendResponse({ ok: true, waiting: waitingForResponse });
      return true;
    }
    if (message.action === 'PING_REQUEST' && message.provider === provider) {
      sendResponse({ ok: true, waiting: waitingForResponse, requestId: activeRequestId, workflowId: activeWorkflowId });
      return true;
    }
    if (message.action === 'DIAGNOSE' && (!message.provider || message.provider === provider)) {
      try {
        sendResponse({ ok: true, report: buildDiagnostics() });
      } catch (error) {
        sendResponse({ ok: false, error: errorMessage(error) });
      }
      return true;
    }
    if (message.action === 'CHECK_STATUS') {
      // A service worker can restart while this content script survives. Always answer its
      // explicit probe even when our locally observed status has not changed.
      reportStatus(true);
      sendResponse({ ok: true });
      return true;
    }
    if (message.action === 'STOP_GENERATION' && (!message.provider || message.provider === provider)) {
      const stopped = stopGeneration(message.requestId, message.workflowId);
      sendResponse({ ok: stopped });
      return true;
    }
    return false;
  };

  function preview(value: string | null | undefined): string {
    return (value ?? '').slice(0, PREVIEW_CHARS);
  }

  function buildDiagnostics() {
    const now = Date.now();
    const prompt = activePromptText || lastPromptText;
    const userSelectors = [...(config.userMessageSelectors ?? []), ...GENERIC_USER_MESSAGE_SELECTORS];
    let echoFound = false;
    let echoText = '';
    let specificText: string | null = null;
    let newElementText: string | null = null;
    let afterEchoText: string | null = null;
    try {
      const echo = prompt ? findPromptEcho(document, { prompt, userSelectors }) : null;
      echoFound = Boolean(echo);
      echoText = preview(echo?.textContent);
    } catch {}
    try { specificText = waitingForResponse ? getSpecificResponseText() : null; } catch {}
    try { newElementText = waitingForResponse ? readNewResponseElement(true) : null; } catch {}
    try { afterEchoText = prompt ? readGenericReplyFor(prompt, true) : null; } catch {}
    const signal = generationSignal();
    return collectContentDiagnostics({
      provider,
      root: document,
      selectors: {
        input: inputSelectors,
        send: config.sendButtonSelectors,
        stop: config.stopButtonSelectors ?? [],
        thinking: thinkingSelectors,
        response: [...new Set([...responseSelectors, ...GENERIC_RESPONSE_SELECTORS])],
        userMessage: userSelectors,
      },
      isVisible: isElementVisible,
      generation: { active: Boolean(signal), signal },
      tracking: {
        waitingForResponse,
        activeRequestId,
        activeWorkflowId,
        sentPrompt: prompt.slice(0, 1000),
        waitStartedAt: responseWaitStartedAt ? new Date(responseWaitStartedAt).toISOString() : null,
        elapsedMs: waitingForResponse ? now - responseWaitStartedAt : null,
        sawGenerationActivity,
        anchorUserMessageMatched: sawMatchingUserMessage,
        echoFound,
        echoText,
        usingGenericFallback,
        replySource,
        candidate: preview(stability.candidate),
        candidateChars: stability.candidate.length,
        candidateLastChange: stability.lastChangeAt ? new Date(stability.lastChangeAt).toISOString() : null,
        candidateStableForMs: stability.stableForMs(now),
        stableOverrideMs: stability.thresholdMs,
        lastResponseText: preview(lastResponseText),
        responseBaselineCount: responseCountBaseline.count,
        responseCountNow: queryCountableResponses().length,
        specificText: preview(specificText),
        newElementText: preview(newElementText),
        afterEchoText: preview(afterEchoText),
      },
      log: log.snapshot(),
      blockSelectors: [...userSelectors, ...responseSelectors, ...GENERIC_RESPONSE_SELECTORS],
    });
  }

  runtimeState.dispose = cleanup;
  chrome.runtime.onMessage.addListener(runtimeListener);

  reportStatus(true);
  statusInterval = setInterval(() => reportStatus(true), 10_000);
  observeResponses();
}

async function retryLookup<T>(
  lookup: () => T | null | undefined,
  timeoutMs: number,
  shouldContinue: () => boolean = () => true,
): Promise<T | null> {
  const startedAt = Date.now();
  while (true) {
    if (!shouldContinue()) return null;
    const value = lookup();
    if (value) return value;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(INPUT_RETRY_MS, timeoutMs - elapsed)));
  }
}

function queryFirst(
  selectors: readonly string[],
  root: ParentNode = document,
  requireVisible = false,
  filter: (element: Element) => boolean = () => true,
): Element | null {
  return firstAcceptedCandidate(
    selectors,
    (selector) => Array.from(root.querySelectorAll(selector)),
    (candidate) => (!requireVisible || isVisible(candidate)) && filter(candidate),
  );
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function getInputText(input: Element): string {
  return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input.textContent ?? '';
}

function assertInputLanded(input: Element, expected: string): void {
  const actual = getInputText(input);
  if (!actual.trim()) throw new Error('editor remained empty');
  if (!composerTextMatches(input, expected)) throw new Error('editor text did not match the requested prompt');
}

function composerTextMatches(input: Element, expected: string): boolean {
  const compact = (value: string) => value.replace(/\s+/g, '');
  return compact(getInputText(input)) === compact(expected);
}

function defaultInjectInput(input: Element, text: string): void {
  const element = input as HTMLElement;
  focusWithoutScroll(element);
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    const prototype = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
  const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  if (inserted && composerTextMatches(input, text)) return;

  element.replaceChildren();
  for (const line of text.split('\n')) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line || '\u00A0';
    element.appendChild(paragraph);
  }
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

function clickElement(element: Element): boolean {
  if (isDisabled(element)) return false;
  const target = element as HTMLElement;
  try {
    focusWithoutScroll(target);
    target.click();
    return true;
  } catch {
    return false;
  }
}

function isDisabled(element: Element): boolean {
  const target = element as HTMLElement & { disabled?: boolean };
  return Boolean(target.disabled || target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true' || target.getAttribute('data-disabled') === 'true');
}

function dispatchEnter(input: Element): boolean {
  focusWithoutScroll(input as HTMLElement);
  const target = document.activeElement ?? input;
  const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  try {
    target.dispatchEvent(new KeyboardEvent('keydown', options));
    target.dispatchEvent(new KeyboardEvent('keypress', options));
    target.dispatchEvent(new KeyboardEvent('keyup', options));
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
