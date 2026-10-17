import type {
  AIProvider,
  AIConnection,
  ChatMode,
  DebateRoles,
  ConsultRoles,
  CodingRoles,
  RoundtableRoles,
  StepRecoveryAction,
  StepRecoveryRequest,
  ExtensionMessage,
  WorkflowStatusPayload,
} from '../shared/types';
import {
  AI_PROVIDERS,
  PROMPTS,
  DEFAULT_DEBATE_ROLES,
  DEFAULT_CONSULT_ROLES,
  DEFAULT_CODING_ROLES,
  DEFAULT_ROUNDTABLE_ROLES,
} from '../shared/constants';
import { questionWithConversationContext } from '../shared/conversationContinuity';
import { encodeError } from '../shared/errors';
import { getProviderReadiness } from '../shared/providerReadiness';
import { getProviderFromUrl } from '../shared/providerUrl';
import {
  ALL_PROVIDERS,
  activeProviders,
  normalizeStandbyProvider,
  repairRoles,
  selectedActiveTargets,
  swapFreeTargets,
} from '../shared/providerSelection';
import {
  activeCancellationTarget,
  WorkflowLifecycleRegistry,
} from '../shared/workflowScope';
import { assertContentScriptAccepted } from './messageDelivery';
import {
  ProviderRequestError,
  roundtableSeats,
  runRoundtableWorkflow,
  StepRecoveryCoordinator,
  StepRecoveryReplayCoordinator,
  transferStepRecoveryOwnership,
} from './roundtableRecovery';
import { assertCurrentWorkflow, WorkflowStartGate } from './workflowStartGate';
import { normalizeRelayOrder, normalizeRelayTurns, runRelayWorkflow } from './relayWorkflow';
import { META_ORIGINS } from '../shared/metaOrigins';
import { DiagLog } from '../shared/diagLog';
import { syncMetaHostAccess } from './metaHostAccess';
import { AUTO_FOREGROUND_STORAGE_KEY, normalizeAutoForeground, TabFocusManager } from './tabFocus';
import type { MetaHostAccessSyncResult } from './metaHostAccess';
import {
  canRetryStatusProbe,
  compareProviderTabPriority,
  connectionAfterProbeFailure,
  connectionAfterRefresh,
  connectionAfterTabRelease,
  connectionForStatusReport,
  connectionForTabEvent,
  isProviderTabUnavailable,
  providerForTabEvent,
  sameConnection,
} from './providerTabOwnership';

interface ResponseWaiter {
  provider: AIProvider;
  workflowId: string;
  tabId?: number;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SendParams {
  workflowId: string;
  text: string;
  context?: string;
  mode: ChatMode;
  roles?: DebateRoles | ConsultRoles | CodingRoles | RoundtableRoles;
  targets?: AIProvider[];
  // 自由模式 (relay): speaking order and number of AI turns.
  order?: AIProvider[];
  turns?: number;
  sessionId: string;
  clientId: string;
}

const PROVIDERS = ALL_PROVIDERS;
const ACTIVE_WORKFLOW_STORAGE_KEY = 'multiAiActiveWorkflow';
const STATUS_PROBE_RETRY_MS = 1000;
const CONTENT_SCRIPT_FILES: Record<AIProvider, string> = {
  chatgpt: 'content/chatgpt.js',
  claude: 'content/claude.js',
  gemini: 'content/gemini.js',
  grok: 'content/grok.js',
  meta: 'content/meta.js',
};

const connections: Record<AIProvider, AIConnection> = Object.fromEntries(
  PROVIDERS.map((provider) => [provider, { provider, status: 'disconnected' }]),
) as Record<AIProvider, AIConnection>;
let connectionsRevision = 0;
let lastBroadcastConnectionsRevision = -1;
const statusProbeRetries = new Map<AIProvider, { tabId: number; timer: ReturnType<typeof setTimeout> }>();

const responseWaiters = new Map<string, ResponseWaiter>();
const stepRecovery = new StepRecoveryCoordinator();
const stepRecoveryReplay = new StepRecoveryReplayCoordinator();
const workflowStartGate = new WorkflowStartGate();
const workflowLifecycle = new WorkflowLifecycleRegistry();
// notes: 只有這輪流程真的送過訊息的 provider 才需要記網址；其餘分頁與這個對話無關
const workflowProviders = new Set<AIProvider>();
// 自由模式: which AIs already got the "you are talking with …" intro, per conversation.
// Mirrored to storage.local so a worker restart (or a browser restart, while the AI pages keep
// their chats) does not re-send the one-time intro in a continued conversation.
const relayIntroduced = new Map<string, Set<AIProvider>>();
const RELAY_INTRODUCED_STORAGE_KEY = 'relayIntroduced';
const RELAY_INTRODUCED_MAX_SESSIONS = 50;

async function loadRelayIntroduced(sessionId: string): Promise<Set<AIProvider>> {
  const cached = relayIntroduced.get(sessionId);
  if (cached) return cached;
  let restored: AIProvider[] = [];
  try {
    const stored = (await chrome.storage.local.get(RELAY_INTRODUCED_STORAGE_KEY))[RELAY_INTRODUCED_STORAGE_KEY] as Record<string, unknown> | undefined;
    const saved = stored?.[sessionId];
    if (Array.isArray(saved)) restored = saved.filter((provider): provider is AIProvider => PROVIDERS.includes(provider as AIProvider));
  } catch {}
  const introduced = relayIntroduced.get(sessionId) ?? new Set<AIProvider>(restored);
  relayIntroduced.set(sessionId, introduced);
  return introduced;
}

async function saveRelayIntroduced(sessionId: string, introduced: Set<AIProvider>): Promise<void> {
  try {
    const stored = (await chrome.storage.local.get(RELAY_INTRODUCED_STORAGE_KEY))[RELAY_INTRODUCED_STORAGE_KEY] as Record<string, AIProvider[]> | undefined;
    const next: Record<string, AIProvider[]> = { ...(stored && typeof stored === 'object' ? stored : {}) };
    delete next[sessionId];
    next[sessionId] = [...introduced];
    const ids = Object.keys(next);
    for (const id of ids.slice(0, Math.max(0, ids.length - RELAY_INTRODUCED_MAX_SESSIONS))) delete next[id];
    await chrome.storage.local.set({ [RELAY_INTRODUCED_STORAGE_KEY]: next });
  } catch {}
}
// Messages the human typed while a relay is running, delivered with the next relay.
const relayInjected = new Map<string, string[]>();
let workflowAborted = false;
let activeWorkflowId: string | undefined;
let activeSessionId: string | undefined;
let activeClientId: string | undefined;
let lastWorkflowStatus: WorkflowStatusPayload | undefined;
let lastRoleAssignment: { provider: AIProvider; labelKey: string; requestId?: string } | undefined;
let standbyProvider = normalizeStandbyProvider(undefined);
// Ring buffer of recent workflow events for the 诊断 report.
const diagLog = new DiagLog();
const chunkLogged = new Set<string>();
const DIAGNOSE_TIMEOUT_MS = 5000;
const providerSelectionReady = chrome.storage.local.get('standbyProvider').then((stored) => {
  standbyProvider = normalizeStandbyProvider(stored.standbyProvider);
});
// 自动切到前台: bring the provider that is generating to the front, then restore the user's tab.
const tabFocus = new TabFocusManager({
  getUserTab: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0],
  getTab: (tabId) => chrome.tabs.get(tabId),
  getActiveTab: async (windowId) => (await chrome.tabs.query({ active: true, windowId }))[0],
  activateTab: async (tabId) => { await chrome.tabs.update(tabId, { active: true }); },
  focusWindow: async (windowId) => { await chrome.windows.update(windowId, { focused: true }); },
  getFocusedWindowId: async () => {
    const win = await chrome.windows.getLastFocused();
    return win.focused && win.id !== undefined && win.id !== chrome.windows.WINDOW_ID_NONE ? win.id : undefined;
  },
  isEnabled: async () => normalizeAutoForeground((await chrome.storage.local.get(AUTO_FOREGROUND_STORAGE_KEY))[AUTO_FOREGROUND_STORAGE_KEY]),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  log: (event, data) => diagLog.add(event, data),
});
// registerContentScripts rejects a duplicate id, and the standby seat must match
// host access. Startup, install, and wake can overlap, so one reconcile runs at a time.
let metaHostAccessChain: Promise<void> = Promise.resolve();

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
void refreshConnections();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'multi-ai-sidepanel') return;
  port.onMessage.addListener(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  void refreshConnections();
  trackMetaHostAccess();
});
chrome.runtime.onStartup.addListener(() => {
  void refreshConnections();
  trackMetaHostAccess();
});
chrome.permissions.onAdded.addListener(() => {
  trackMetaHostAccess();
});
chrome.permissions.onRemoved.addListener(() => {
  trackMetaHostAccess();
});
trackMetaHostAccess();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // onUpdated 也會因為標題、favicon 等變化觸發，此時 changeInfo 沒有 status 或 url。
  // 那類事件不該影響連線或分頁 ownership。
  const availabilityChanged = changeInfo.discarded !== undefined || changeInfo.frozen !== undefined;
  if (changeInfo.status === undefined && changeInfo.url === undefined && !availabilityChanged) return;

  const ownerForTab = PROVIDERS.find((candidate) => connections[candidate].tabId === tabId);
  const provider = providerForTabEvent(changeInfo.url, tab.url, ownerForTab, getProviderFromUrl);
  let releasedOwner = false;
  for (const candidate of PROVIDERS) {
    if (candidate === provider || connections[candidate].tabId !== tabId) continue;
    rejectWaitersForProvider(candidate, new Error(encodeError('error.navigated_away', { provider: candidate })));
    releasedOwner = updateConnection(candidate, connectionAfterTabRelease(connections[candidate], candidate, tabId)) || releasedOwner;
  }

  if (!provider) {
    if (releasedOwner) {
      broadcastConnections();
      void refreshConnections();
    }
    return;
  }

  const current = connections[provider];
  const isOwner = current.tabId === tabId;
  // Once a provider owns a live tab, unrelated tabs on the same provider cannot
  // steal it merely by navigating or finishing a load.
  if (current.tabId !== undefined && !isOwner) {
    if (releasedOwner) {
      broadcastConnections();
      void refreshConnections();
    }
    return;
  }

  const unavailable = changeInfo.discarded === true
    || changeInfo.frozen === true
    || isProviderTabUnavailable(tab);
  if (unavailable) {
    if (isOwner) {
      rejectWaitersForProvider(provider, new Error(encodeError('error.reloaded', { provider })));
      updateConnection(provider, connectionAfterTabRelease(current, provider, tabId));
      broadcastConnections();
    }
    // Prefer another live provider tab. If this is the only candidate, refresh keeps
    // its id as disconnected so clicking the provider card can wake it back up.
    void refreshConnections();
    return;
  }

  if (changeInfo.status === 'loading' && isOwner) {
    // SPA routing (e.g. Grok moving to /c/<id>?rid=… right after a send) also reports
    // status "loading", but the page — and our content script, mid-request — survives.
    // Only fail the request once the tab's content script confirms it is no longer on it.
    diagLog.add('tab.loading', { provider, tabId, url: changeInfo.url ?? tab.url });
    verifyRequestsAfterNavigation(provider, tabId);
  }

  const becameAvailable = changeInfo.discarded === false || changeInfo.frozen === false;
  const urlOnly = changeInfo.url !== undefined && changeInfo.status === undefined && !becameAvailable;
  const markChecking = !isOwner || changeInfo.status === 'loading' || becameAvailable;
  updateConnection(provider, connectionForTabEvent(current, provider, tabId, markChecking));
  broadcastConnections();
  // URL-only events are SPA navigation. Keep an already-ready owner ready while
  // confirming it in the background; a transient probe must not create flicker.
  if (changeInfo.status === 'complete' || urlOnly || becameAvailable) {
    void requestTabStatus(provider, tabId, {
      preserveConnectedOnFailure: urlOnly && isOwner && current.status === 'connected',
    });
  }
  if (releasedOwner) void refreshConnections();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  let releasedOwner = false;
  for (const provider of PROVIDERS) {
    if (connections[provider].tabId === tabId) {
      rejectWaitersForProvider(provider, new Error(encodeError('error.tab_closed', { provider })));
      releasedOwner = updateConnection(provider, connectionAfterTabRelease(connections[provider], provider, tabId)) || releasedOwner;
    }
  }
  if (releasedOwner) {
    broadcastConnections();
    void refreshConnections();
  }
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  switch (message.action) {
    case 'SET_STANDBY_PROVIDER': {
      const requested = (message.payload as { standbyProvider?: unknown } | undefined)?.standbyProvider;
      if (sender.tab || !ALL_PROVIDERS.includes(requested as AIProvider)) {
        sendResponse({ ok: false });
        return false;
      }
      void commitStandbyProvider(requested as AIProvider)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;
    }
    case 'GET_CONNECTIONS':
      sendResponse(connections);
      // 先回快取讓側邊欄立即有內容，再重新探測一次；結果會透過 broadcastConnections 送達。
      // 沒有這一步的話，快取一旦是 disconnected 就只能等下一次分頁載入事件才會更新。
      void refreshConnections();
      void adoptSidePanelClient(message.payload as { clientId?: string; sessionId?: string } | undefined);
      return true;

    case 'GET_PROVIDER_URLS':
      void getProviderUrls().then(sendResponse).catch(() => sendResponse({}));
      return true;

    case 'RESET_PROVIDER_SESSIONS':
      void resetProviderSessions((message.payload as { providers?: AIProvider[] } | undefined)?.providers)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;

    case 'RESTORE_PROVIDER_SESSIONS':
      void restoreProviderSessions((message.payload as { urls?: Partial<Record<AIProvider, string>> } | undefined)?.urls ?? {})
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;

    case 'STATUS_REPORT': {
      if (!message.provider || !sender.tab?.id) return false;
      if (sender.tab.url && getProviderFromUrl(sender.tab.url) !== message.provider) return false;
      const { loggedIn = false } = (message.payload as { loggedIn?: boolean | null } | undefined) ?? {};
      const current = connections[message.provider];
      if (current.tabId !== undefined && current.tabId !== sender.tab.id) return false;
      const next = connectionForStatusReport(
        current,
        message.provider,
        sender.tab.id,
        loggedIn,
        isProviderTabUnavailable(sender.tab),
      );
      if (next === current) return false;
      clearStatusProbeRetry(message.provider, sender.tab.id);
      if (!updateConnection(message.provider, next)) return false;
      broadcastConnections();
      return false;
    }

    case 'OPEN_LOGIN':
      if (!message.provider) return false;
      focusOrOpenProvider(message.provider)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;

    case 'CANCEL_WORKFLOW': {
      const registered = !sender.tab ? workflowLifecycle.requestCancellation(message.payload) : undefined;
      if (!registered) {
        sendResponse({ ok: false });
        return true;
      }
      const activeTarget = activeCancellationTarget(registered.workflowId, activeWorkflowId);
      if (activeTarget) void abortWorkflow(activeTarget).then(() => sendResponse({ ok: true }));
      else sendResponse({ ok: true });
      return true;
    }

    case 'RESOLVE_STEP_RECOVERY': {
      const accepted = !sender.tab && stepRecovery.resolve(message.payload);
      sendResponse({ ok: accepted });
      return true;
    }

    case 'PUBLISH_HACKMD':
      handleHackMDPublish(message.payload as { token: string; title: string; content: string })
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;

    case 'SEND_MESSAGE': {
      const params = message.payload as SendParams | undefined;
      if (sender.tab || !isSendParams(params) || !workflowLifecycle.register({
        workflowId: params.workflowId,
        sessionId: params.sessionId,
        clientId: params.clientId,
      })) {
        sendResponse({ ok: false, error: 'Invalid or duplicate workflow id' });
        return false;
      }
      void handleSendMessage(params)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }))
        .finally(() => {
          workflowLifecycle.finish(params.workflowId);
        });
      return true;
    }

    case 'RELAY_INJECT': {
      const injection = message.payload as { workflowId?: string; sessionId?: string; clientId?: string; text?: string } | undefined;
      const accepted = !sender.tab
        && typeof injection?.text === 'string'
        && injection.text.trim().length > 0
        && injection.workflowId === activeWorkflowId
        && injection.sessionId === activeSessionId
        && injection.clientId === activeClientId
        && relayInjected.has(injection.workflowId ?? '');
      if (accepted) relayInjected.get(injection!.workflowId!)!.push(injection!.text!.trim());
      sendResponse({ ok: accepted });
      return false;
    }

    case 'COLLECT_DIAGNOSTICS': {
      if (sender.tab) return false;
      const requested = (message.payload as { providers?: unknown } | undefined)?.providers;
      void collectDiagnostics(Array.isArray(requested) ? requested as AIProvider[] : undefined)
        .then((report) => sendResponse({ ok: true, report }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    case 'RESPONSE_DONE':
      if (!sender.tab || !message.requestId) return false;
      diagLog.add('response.done', { provider: message.provider, requestId: message.requestId, chars: String(message.payload ?? '').length, error: /^\[Error:/.test(String(message.payload ?? '')) ? String(message.payload).slice(0, 300) : undefined });
      settleResponseWaiter(message.requestId, message.provider, String(message.payload ?? ''));
      return false;

    case 'RESPONSE_CHUNK':
      if (sender.tab && message.requestId && !chunkLogged.has(message.requestId)) {
        if (chunkLogged.size > 200) chunkLogged.clear();
        chunkLogged.add(message.requestId);
        diagLog.add('response.first_chunk', { provider: message.provider, requestId: message.requestId, chars: String(message.payload ?? '').length });
      }
      return false;

    case 'DIAGNOSE':
    case 'PING_REQUEST':
    case 'POKE_REQUEST':
    case 'READ_LATEST_REPLY':
    case 'ROLE_ASSIGNMENT':
    case 'WORKFLOW_STATUS':
    case 'CHECK_STATUS':
    case 'STOP_GENERATION':
      return false;
  }
});

async function refreshConnections(): Promise<void> {
  const connectionsAtStart = Object.fromEntries(
    PROVIDERS.map((provider) => [provider, connections[provider]]),
  ) as Record<AIProvider, AIConnection>;
  const tabs = await chrome.tabs.query({});
  const candidates = Object.fromEntries(
    PROVIDERS.map((provider) => [provider, [] as chrome.tabs.Tab[]]),
  ) as Record<AIProvider, chrome.tabs.Tab[]>;
  const unavailableCandidateIds = Object.fromEntries(
    PROVIDERS.map((provider) => [provider, new Set<number>()]),
  ) as Record<AIProvider, Set<number>>;
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    const provider = getProviderFromUrl(tab.url);
    if (!provider) continue;
    candidates[provider].push(tab);
    if (isProviderTabUnavailable(tab)) unavailableCandidateIds[provider].add(tab.id);
  }
  for (const provider of PROVIDERS) {
    if (connections[provider] !== connectionsAtStart[provider]) continue;
    const candidateIds = candidates[provider]
      .sort(compareProviderTabPriority)
      .flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
    const next = connectionAfterRefresh(
      connections[provider],
      provider,
      connectionsAtStart[provider],
      candidateIds,
      [...unavailableCandidateIds[provider]],
    );
    updateConnection(provider, next);
  }
  broadcastConnections();

  await Promise.all(
    PROVIDERS.map(async (provider) => {
      const tabId = connections[provider].tabId;
      if (tabId && !unavailableCandidateIds[provider].has(tabId)) {
        await requestTabStatus(provider, tabId);
      }
    }),
  );
}

async function requestTabStatus(
  provider: AIProvider,
  tabId: number,
  options: { preserveConnectedOnFailure?: boolean } = {},
): Promise<void> {
  if (connections[provider].tabId !== tabId) return;
  const connectionAtStart = connections[provider];
  try {
    await deliverToTab(provider, tabId, { action: 'CHECK_STATUS', provider });
    clearStatusProbeRetry(provider, tabId);
  } catch {
    // A probe started for an older connection generation must never demote a
    // status or owner established while message delivery was in flight.
    if (connections[provider] !== connectionAtStart) return;
    const next = connectionAfterProbeFailure(
      connectionAtStart,
      provider,
      tabId,
      options.preserveConnectedOnFailure,
    );
    updateConnection(provider, next);
    broadcastConnections();
    if (options.preserveConnectedOnFailure && canRetryStatusProbe(next, tabId)) {
      scheduleStatusProbeRetry(provider, tabId);
    }
  }
}

function scheduleStatusProbeRetry(provider: AIProvider, tabId: number): void {
  clearStatusProbeRetry(provider);
  const timer = setTimeout(() => {
    const scheduled = statusProbeRetries.get(provider);
    if (!scheduled || scheduled.tabId !== tabId || scheduled.timer !== timer) return;
    statusProbeRetries.delete(provider);
    if (canRetryStatusProbe(connections[provider], tabId)) {
      void requestTabStatus(provider, tabId);
    }
  }, STATUS_PROBE_RETRY_MS);
  statusProbeRetries.set(provider, { tabId, timer });
}

function clearStatusProbeRetry(provider: AIProvider, tabId?: number): void {
  const scheduled = statusProbeRetries.get(provider);
  if (!scheduled || (tabId !== undefined && scheduled.tabId !== tabId)) return;
  clearTimeout(scheduled.timer);
  statusProbeRetries.delete(provider);
}

const NAVIGATION_CHECK_DELAY_MS = 1500;
const NAVIGATION_CHECK_ATTEMPTS = 5;
const navigationChecks = new Map<AIProvider, ReturnType<typeof setTimeout>>();

/**
 * After a provider tab reports "loading", ask its content script whether it is still working
 * on our request. Same-document navigation keeps the script (and its request) alive; a real
 * reload replaces it with a fresh, idle one — only then is the request failed as reloaded.
 */
function verifyRequestsAfterNavigation(provider: AIProvider, tabId: number): void {
  const existing = navigationChecks.get(provider);
  if (existing !== undefined) clearTimeout(existing);
  let idleAnswers = 0;
  const attempt = async (remaining: number) => {
    navigationChecks.delete(provider);
    const waiting = Array.from(responseWaiters).filter(([, waiter]) => waiter.provider === provider && waiter.tabId === tabId);
    if (!waiting.length || connections[provider].tabId !== tabId) return;
    let reply: { ok?: boolean; waiting?: boolean; requestId?: string } | undefined;
    try {
      reply = await chrome.tabs.sendMessage(tabId, { action: 'PING_REQUEST', provider }) as typeof reply;
    } catch {
      reply = undefined;
    }
    let retry = false;
    for (const [requestId] of waiting) {
      if (!responseWaiters.has(requestId)) continue;
      if (reply?.ok && reply.waiting && reply.requestId === requestId) continue;
      // No answer yet (document still loading) or a possibly in-flight RESPONSE_DONE: look again.
      if (remaining > 1 && (!reply?.ok || idleAnswers < 1)) {
        retry = true;
        continue;
      }
      diagLog.add('tab.reloaded', { provider, requestId, reply });
      rejectResponseWaiter(requestId, new Error(encodeError('error.reloaded', { provider })));
    }
    if (reply?.ok && !reply.waiting) idleAnswers += 1;
    if (retry) {
      navigationChecks.set(provider, setTimeout(() => void attempt(remaining - 1), NAVIGATION_CHECK_DELAY_MS));
    } else if (reply?.ok && reply.waiting) {
      diagLog.add('tab.navigation_survived', { provider, requestId: reply.requestId });
    }
  };
  navigationChecks.set(provider, setTimeout(() => void attempt(NAVIGATION_CHECK_ATTEMPTS), NAVIGATION_CHECK_DELAY_MS));
}

async function deliverToTab(provider: AIProvider, tabId: number, message: ExtensionMessage): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILES[provider]] });
      await delay(150);
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (injectError) {
      // Last resort failed: the tab cannot run our content script at all. Surface it —
      // the browser's message (e.g. "Blocked") is the only clue to why the provider
      // never reports its status.
      console.error(`Failed to inject the ${provider} content script into tab ${tabId}`, injectError);
      throw firstError;
    }
  }
}

function updateConnection(provider: AIProvider, next: AIConnection): boolean {
  if (sameConnection(connections[provider], next)) return false;
  const previous = connections[provider];
  connections[provider] = next;
  if (previous.tabId !== next.tabId || next.status !== 'connected') {
    clearStatusProbeRetry(provider);
  }
  connectionsRevision += 1;
  return true;
}

function broadcastConnections(): void {
  if (lastBroadcastConnectionsRevision === connectionsRevision) return;
  lastBroadcastConnectionsRevision = connectionsRevision;
  chrome.runtime.sendMessage({ action: 'CONNECTIONS_UPDATE', payload: connections }).catch(() => {});
}

async function focusOrOpenProvider(provider: AIProvider): Promise<void> {
  await ensureActiveProvider(provider);
  const connection = connections[provider];
  if (connection.tabId) {
    const attemptedTabId = connection.tabId;
    try {
      const tab = await chrome.tabs.update(attemptedTabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      // 分頁已經載入完成時不會再有載入事件，必須主動重新查詢；
      // deliverToTab 在訊息送不到時會用 chrome.scripting 重新注入 content script。
      await requestTabStatus(provider, attemptedTabId);
      return;
    } catch {
      if (connections[provider] !== connection) return;
      updateConnection(provider, connectionAfterTabRelease(connections[provider], provider, attemptedTabId));
      broadcastConnections();
      // Ownership may have moved while the focus request was in flight. Do not
      // clear that newer owner or open a redundant login tab.
      if (connections[provider].tabId !== undefined) return;
    }
  }
  await chrome.tabs.create({ url: AI_PROVIDERS[provider].loginUrl });
}

async function getProviderUrls(): Promise<Partial<Record<AIProvider, string>>> {
  const urls: Partial<Record<AIProvider, string>> = {};
  await Promise.all([...workflowProviders].map(async (provider) => {
    const tabId = connections[provider].tabId;
    if (!tabId) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && getProviderFromUrl(tab.url) === provider) urls[provider] = tab.url;
    } catch {}
  }));
  return urls;
}

async function resetProviderSessions(targets?: AIProvider[]): Promise<void> {
  await providerSelectionReady;
  await Promise.all(selectedActiveTargets(targets, standbyProvider).map(async (provider) => {
    const tabId = connections[provider].tabId;
    if (!tabId) return;
    updateConnection(provider, { provider, status: 'checking', tabId });
    await chrome.tabs.update(tabId, { url: AI_PROVIDERS[provider].url });
  }));
  broadcastConnections();
}

async function restoreProviderSessions(urls: Partial<Record<AIProvider, string>>): Promise<void> {
  await providerSelectionReady;
  await Promise.all(activeProviders(standbyProvider).map(async (provider) => {
    const url = urls[provider];
    const tabId = connections[provider].tabId;
    if (!url || !tabId || getProviderFromUrl(url) !== provider) return;
    updateConnection(provider, { provider, status: 'checking', tabId });
    await chrome.tabs.update(tabId, { url });
  }));
  broadcastConnections();
}

async function sendToProvider(provider: AIProvider, text: string, requestId: string, workflowId: string): Promise<void> {
  await ensureActiveProvider(provider);
  checkAborted(workflowId);
  const connection = connections[provider];
  if (connection.status !== 'connected' || !connection.tabId) {
    throw new Error(encodeError('error.not_ready', { provider }));
  }
  workflowProviders.add(provider);
  const result = await deliverToTab(provider, connection.tabId, {
    action: 'SEND_MESSAGE',
    provider,
    requestId,
    workflowId,
    payload: { text },
  });
  assertContentScriptAccepted(result);
}

async function ensureActiveProvider(provider: AIProvider): Promise<void> {
  await providerSelectionReady;
  if (!activeProviders(standbyProvider).includes(provider)) {
    throw new Error(encodeError('error.provider_standby', { provider }));
  }
}

async function sendAndWait(
  provider: AIProvider,
  text: string,
  workflowId: string,
  preserveQuestionLanguage = true,
  reservedRequestId?: string,
): Promise<string> {
  checkAborted(workflowId);
  await waitForProviderCooldown(provider);
  checkAborted(workflowId);
  const requestId = reservedRequestId ?? createProviderRequestId(provider, workflowId);
  const responsePromise = waitForResponse(provider, requestId, workflowId);
  // A throttled background tab can stall the paste and the reply; keep it in front meanwhile.
  await tabFocus.beginStep(requestId, connections[provider].tabId);
  try {
    try {
      const prompt = preserveQuestionLanguage
        ? `${text}\n\nLanguage requirement: answer in the same language as the user's original question.`
        : text;
      diagLog.add('send', { provider, requestId, workflowId, chars: prompt.length, head: prompt.slice(0, 120), tabId: connections[provider].tabId });
      await sendToProvider(provider, prompt, requestId, workflowId);
      diagLog.add('send.accepted', { provider, requestId });
    } catch (error) {
      diagLog.add('send.failed', { provider, requestId, error: error instanceof Error ? error.message : String(error) });
      rejectResponseWaiter(requestId, error instanceof Error ? error : new Error(String(error)));
    }
    const response = await responsePromise;
    const providerError = response.match(/^\[Error:\s*(.+)]$/s);
    if (providerError) {
      throw new ProviderRequestError(provider, workflowId, requestId, new Error(providerError[1]), true);
    }
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(provider, workflowId, requestId, error);
  } finally {
    void tabFocus.endStep(requestId);
  }
}

// When one AI holds two consecutive roles, give its page a moment to re-enable the input
// after the previous answer finished before the next prompt is typed into the same tab.
const SAME_PROVIDER_COOLDOWN_MS = 1000;
let lastSettled: { provider: AIProvider; at: number } | undefined;

async function waitForProviderCooldown(provider: AIProvider): Promise<void> {
  if (lastSettled?.provider !== provider) return;
  const remaining = lastSettled.at + SAME_PROVIDER_COOLDOWN_MS - Date.now();
  if (remaining > 0) await delay(remaining);
}

function createProviderRequestId(provider: AIProvider, workflowId: string): string {
  return `${workflowId}:${provider}:${crypto.randomUUID()}`;
}

function waitForResponse(provider: AIProvider, requestId: string, workflowId: string, timeoutMs = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      responseWaiters.delete(requestId);
      diagLog.add('response.timeout', { provider, requestId, seconds: Math.round(timeoutMs / 1000) });
      reject(new Error(encodeError('error.timeout', { provider, seconds: Math.round(timeoutMs / 1000) })));
    }, timeoutMs);
    responseWaiters.set(requestId, { provider, workflowId, tabId: connections[provider].tabId, resolve, reject, timer });
    schedulePoke(requestId);
  });
}

// Background provider tabs get their timers throttled by Chrome; extension messages are not.
// While a reply is pending, nudge the tab's content script to run a detection pass.
const POKE_INTERVAL_MS = 4000;
function schedulePoke(requestId: string): void {
  setTimeout(() => {
    const waiter = responseWaiters.get(requestId);
    if (!waiter) return;
    if (waiter.tabId !== undefined) {
      chrome.tabs.sendMessage(waiter.tabId, { action: 'POKE_REQUEST', provider: waiter.provider, requestId })
        ?.catch?.(() => {});
    }
    schedulePoke(requestId);
  }, POKE_INTERVAL_MS);
}

function settleResponseWaiter(requestId: string, provider: AIProvider | undefined, response: string): void {
  const waiter = responseWaiters.get(requestId);
  if (!waiter || provider !== waiter.provider) return;
  clearTimeout(waiter.timer);
  responseWaiters.delete(requestId);
  lastSettled = { provider: waiter.provider, at: Date.now() };
  waiter.resolve(response);
}

function rejectResponseWaiter(requestId: string, error: Error): void {
  const waiter = responseWaiters.get(requestId);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  responseWaiters.delete(requestId);
  waiter.reject(error);
}

function rejectWaitersForProvider(provider: AIProvider, error: Error): void {
  for (const [requestId, waiter] of responseWaiters) {
    if (waiter.provider === provider) rejectResponseWaiter(requestId, error);
  }
}

async function abortWorkflow(targetWorkflowId = activeWorkflowId): Promise<void> {
  if (!targetWorkflowId) return;
  const targetSessionId = activeWorkflowId === targetWorkflowId ? activeSessionId : undefined;
  const targetClientId = activeWorkflowId === targetWorkflowId ? activeClientId : undefined;
  if (activeWorkflowId === targetWorkflowId) workflowAborted = true;
  const abortError = new DOMException('Workflow cancelled', 'AbortError');
  const activeRequests = Array.from(responseWaiters, ([requestId, waiter]) => ({ requestId, ...waiter }))
    .filter((waiter) => waiter.workflowId === targetWorkflowId);
  const pendingRecovery = stepRecovery.current();
  const recovering = pendingRecovery?.workflowId === targetWorkflowId ? pendingRecovery : undefined;
  for (const { requestId } of activeRequests) rejectResponseWaiter(requestId, abortError);
  stepRecovery.cancel(targetWorkflowId, abortError);
  await Promise.all(activeRequests.map(({ provider, requestId, workflowId, tabId }) => (
    resetProviderRequest(provider, requestId, workflowId, tabId)
  )));
  if (recovering) await resetProviderAfterFailure(recovering.provider, recovering.failedRequestId, recovering.workflowId);
  await tabFocus.endRun();
  await sendWorkflowStatus({ key: '', done: true, cancelled: true }, targetWorkflowId, targetSessionId, targetClientId);
}

function checkAborted(workflowId: string): void {
  assertCurrentWorkflow(workflowId, activeWorkflowId, workflowAborted);
}

async function handleSendMessage(params: SendParams): Promise<void> {
  const workflowId = params.workflowId;
  try {
    await beginWorkflow(params);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw error;
  }

  try {
    checkAborted(workflowId);
    // 自由模式 keeps talking in the chat that is already open on each AI page, so the page has
    // its own history; replaying panel context would only add noise to the relayed text.
    const question = params.mode === 'relay' ? params.text : questionWithConversationContext(params.text, params.context);
    await sendWorkflowStatus({ key: 'workflow.starting' }, workflowId, params.sessionId, params.clientId);
    checkAborted(workflowId);
    switch (params.mode) {
      case 'relay':
        await handleRelayMode(question, params, workflowId);
        break;
      case 'free':
        await handleFreeMode(question, params.targets, workflowId);
        break;
      case 'debate':
        await handleDebateMode(question, repairRoles((params.roles as DebateRoles) ?? DEFAULT_DEBATE_ROLES, standbyProvider), workflowId);
        break;
      case 'consult':
        await handleConsultMode(question, repairRoles((params.roles as ConsultRoles) ?? DEFAULT_CONSULT_ROLES, standbyProvider), workflowId);
        break;
      case 'coding':
        await handleCodingMode(question, repairRoles((params.roles as CodingRoles) ?? DEFAULT_CODING_ROLES, standbyProvider), workflowId);
        break;
      case 'roundtable':
        await handleRoundtableMode(question, repairRoles((params.roles as RoundtableRoles) ?? DEFAULT_ROUNDTABLE_ROLES, standbyProvider), workflowId);
        break;
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) sendSystemError(errorMessage(error), workflowId);
  } finally {
    stepRecovery.cancel(workflowId);
    await tabFocus.endRun();
    const completionClientId = activeWorkflowId === workflowId ? activeClientId : params.clientId;
    const cancelled = workflowAborted || activeWorkflowId !== workflowId;
    await sendWorkflowStatus({ key: '', done: true, cancelled }, workflowId, params.sessionId, completionClientId);
    await clearPersistedWorkflow(workflowId);
    if (activeWorkflowId === workflowId) {
      activeWorkflowId = undefined;
      activeSessionId = undefined;
      activeClientId = undefined;
    }
  }
}

async function beginWorkflow(params: SendParams): Promise<void> {
  await workflowStartGate.run(async () => {
    await providerSelectionReady;
    workflowLifecycle.assertCanStart(params.workflowId);
    if (activeWorkflowId) await abortWorkflow(activeWorkflowId);
    workflowLifecycle.assertCanStart(params.workflowId);
    workflowAborted = false;
    workflowProviders.clear();
    lastWorkflowStatus = undefined;
    lastRoleAssignment = undefined;
    activeWorkflowId = params.workflowId;
    activeSessionId = params.sessionId;
    activeClientId = params.clientId;
    await chrome.storage.session.set({
      [ACTIVE_WORKFLOW_STORAGE_KEY]: {
        workflowId: params.workflowId,
        sessionId: params.sessionId,
        clientId: params.clientId,
        startedAt: Date.now(),
      },
    });
  });
}

function isSendParams(value: unknown): value is SendParams {
  if (!value || typeof value !== 'object') return false;
  const params = value as Partial<SendParams>;
  return typeof params.workflowId === 'string'
    && typeof params.text === 'string'
    && typeof params.sessionId === 'string'
    && typeof params.clientId === 'string'
    && (params.mode === 'relay'
      || params.mode === 'free'
      || params.mode === 'debate'
      || params.mode === 'consult'
      || params.mode === 'coding'
      || params.mode === 'roundtable');
}

async function notifyInterruptedWorkflow(target?: { clientId?: string; sessionId?: string }): Promise<void> {
  if (activeWorkflowId) return;
  const stored = await chrome.storage.session.get(ACTIVE_WORKFLOW_STORAGE_KEY);
  if (activeWorkflowId) return;
  const interrupted = stored[ACTIVE_WORKFLOW_STORAGE_KEY] as { workflowId?: string; sessionId?: string; clientId?: string } | undefined;
  if (!interrupted?.workflowId || !interrupted.sessionId || !interrupted.clientId) return;
  if (!target?.clientId || target.sessionId !== interrupted.sessionId) return;
  const interruptedWorkflowId = interrupted.workflowId;
  await sendWorkflowStatus(
    { key: 'workflow.interrupted' },
    interruptedWorkflowId,
    interrupted.sessionId,
    target.clientId,
  );
  sendSystemError(encodeError('error.worker_stopped'), interruptedWorkflowId);
  await sendWorkflowStatus(
    { key: '', done: true, cancelled: false },
    interruptedWorkflowId,
    interrupted.sessionId,
    target.clientId,
  );
  await clearPersistedWorkflow(interruptedWorkflowId);
}

async function clearPersistedWorkflow(workflowId: string): Promise<void> {
  const stored = await chrome.storage.session.get(ACTIVE_WORKFLOW_STORAGE_KEY);
  const active = stored[ACTIVE_WORKFLOW_STORAGE_KEY] as { workflowId?: string } | undefined;
  if (active?.workflowId === workflowId) await chrome.storage.session.remove(ACTIVE_WORKFLOW_STORAGE_KEY);
}

async function handleRelayMode(text: string, params: SendParams, workflowId: string): Promise<void> {
  const participants = normalizeRelayOrder(params.order, activeProviders(standbyProvider));
  if (participants.length === 0) throw new Error(encodeError('error.no_selection'));
  const { unready } = getProviderReadiness('relay', participants, connections);
  if (unready.length) {
    throw new Error(encodeError('error.providers_not_ready', { providers: unready.map(name).join(' · ') }));
  }
  const introduced = await loadRelayIntroduced(params.sessionId);
  relayInjected.set(workflowId, []);
  try {
    await runRelayWorkflow(text, participants, normalizeRelayTurns(params.turns), workflowId, {
      checkAborted,
      providerName: name,
      isIntroduced: (provider) => introduced.has(provider),
      markIntroduced: (provider) => {
        if (introduced.has(provider)) return;
        introduced.add(provider);
        void saveRelayIntroduced(params.sessionId, introduced);
      },
      takeInjected: () => relayInjected.get(workflowId)?.splice(0) ?? [],
      createRequestId: createProviderRequestId,
      sendStatus: async (turn, total, provider) => {
        diagLog.add('relay.turn', { workflowId, turn, total, provider });
        await sendWorkflowStatus({ key: 'workflow.relay', params: { turn, total, provider: name(provider) } });
      },
      sendAndWait: (provider, prompt, activeId, requestId) => sendAndWait(provider, prompt, activeId, false, requestId),
      requestRecovery: async (provider, error, activeId, failedRequestId) => {
        diagLog.add('relay.recovery_request', { provider, failedRequestId, error: error instanceof Error ? error.message : String(error) });
        // The run is paused on the user's decision: give their tab back right away.
        await tabFocus.endRun();
        const action = await requestStepRecovery(provider, error, activeId, failedRequestId);
        diagLog.add('relay.recovery_decision', { provider, action });
        return action;
      },
      takeManualText: () => stepRecovery.takeDecisionText(),
      rereadReply: readLatestReply,
      publishReply: (provider, reply, activeId) => {
        chrome.runtime.sendMessage({
          action: 'RESPONSE_DONE',
          provider,
          requestId: `${activeId}:${provider}:recovered:${crypto.randomUUID()}`,
          workflowId: activeId,
          payload: reply,
        }).catch(() => {});
      },
      resetProvider: resetProviderAfterFailure,
      cancelWorkflow: abortWorkflow,
    });
  } finally {
    relayInjected.delete(workflowId);
  }
}

async function collectDiagnostics(requested?: AIProvider[]): Promise<Record<string, unknown>> {
  const providers = (requested?.length ? requested : PROVIDERS)
    .filter((provider): provider is AIProvider => PROVIDERS.includes(provider));
  const results: Record<string, unknown> = {};
  await Promise.all(providers.map(async (provider) => {
    const tabId = connections[provider].tabId;
    if (!tabId) {
      results[provider] = { error: 'no tab', connection: connections[provider] };
      return;
    }
    try {
      const reply = await Promise.race([
        chrome.tabs.sendMessage(tabId, { action: 'DIAGNOSE', provider }),
        delay(DIAGNOSE_TIMEOUT_MS).then(() => ({ ok: false, error: `no answer within ${DIAGNOSE_TIMEOUT_MS} ms` })),
      ]) as { ok?: boolean; report?: unknown; error?: string } | undefined;
      results[provider] = reply?.ok ? reply.report : { error: reply?.error ?? 'content script did not answer (old version or not injected?)', connection: connections[provider] };
    } catch (error) {
      results[provider] = { error: error instanceof Error ? error.message : String(error), connection: connections[provider] };
    }
  }));
  let manifest: { name?: string; version?: string } = {};
  try {
    manifest = chrome.runtime.getManifest?.() ?? {};
  } catch {}
  return {
    kind: 'multi-ai-chat-diagnostic',
    extension: { name: manifest.name, version: manifest.version },
    generatedAt: new Date().toISOString(),
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    worker: {
      activeWorkflowId,
      standbyProvider,
      connections,
      pendingResponses: Array.from(responseWaiters, ([requestId, waiter]) => ({ requestId, provider: waiter.provider, workflowId: waiter.workflowId, tabId: waiter.tabId })),
      log: diagLog.snapshot(),
    },
    providers: results,
  };
}

async function readLatestReply(provider: AIProvider, prompt: string): Promise<string | null> {
  const tabId = connections[provider].tabId;
  if (!tabId) return null;
  try {
    const result = await deliverToTab(provider, tabId, { action: 'READ_LATEST_REPLY', provider, payload: { prompt } }) as { text?: unknown } | undefined;
    return typeof result?.text === 'string' && result.text.trim() ? result.text : null;
  } catch {
    return null;
  }
}

async function handleFreeMode(text: string, requestedTargets: AIProvider[] | undefined, workflowId: string): Promise<void> {
  const selected = selectedActiveTargets(requestedTargets, standbyProvider);
  const { ready: targets, unready, noticeKey } = getProviderReadiness('free', selected, connections);
  const providers = targets.map(name).join(' · ');
  if (targets.length === 0) throw new Error(encodeError(noticeKey!, { providers: unready.map(name).join(' · ') }));
  sendWorkflowStatus(unready.length
    ? { key: 'workflow.free.partial', params: { ready: providers, providers: unready.map(name).join(' · ') } }
    : { key: 'workflow.free', params: { providers } });
  const results = await Promise.allSettled(targets.map((provider) => sendAndWait(provider, text, workflowId, false)));
  checkAborted(workflowId);
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length === 0) return;
  const abort = failures.find((reason) => reason instanceof DOMException && reason.name === 'AbortError');
  if (abort) throw abort;
  const undelivered = failures.filter(
    (reason): reason is ProviderRequestError => reason instanceof ProviderRequestError && !reason.alreadyDelivered,
  );
  if (failures.length === results.length) {
    if (undelivered.length === 0) return;
    throw undelivered[0];
  }
  for (const error of undelivered) sendProviderFailure(error);
}

async function handleDebateMode(text: string, roles: DebateRoles, workflowId: string): Promise<void> {
  sendWorkflowStatus(status('workflow.debate.pro', roles.pro));
  sendRoleAssignment(roles.pro, 'role.pro');
  const proResponse = await sendAndWait(roles.pro, PROMPTS.debate.pro(text), workflowId);
  checkAborted(workflowId);

  sendWorkflowStatus(status('workflow.debate.con', roles.con));
  sendRoleAssignment(roles.con, 'role.con');
  const conResponse = await sendAndWait(roles.con, PROMPTS.debate.con(text, proResponse), workflowId);
  checkAborted(workflowId);

  sendWorkflowStatus(status('workflow.debate.judge', roles.judge));
  sendRoleAssignment(roles.judge, 'role.judge');
  const judgeResponse = await sendAndWait(roles.judge, PROMPTS.debate.judge(text, proResponse, conResponse), workflowId);
  checkAborted(workflowId);

  sendWorkflowStatus(status('workflow.debate.summary', roles.summary));
  sendRoleAssignment(roles.summary, 'role.summary');
  await sendAndWait(roles.summary, PROMPTS.debate.summary(text, proResponse, conResponse, judgeResponse), workflowId);
}

async function handleConsultMode(text: string, roles: ConsultRoles, workflowId: string): Promise<void> {
  const sameInitial = roles.first === roles.second;
  // One AI holding both initial seats gets distinct labels so the reviewer can tell the answers apart.
  const firstName = sameInitial ? `${name(roles.first)} (A)` : name(roles.first);
  const secondName = sameInitial ? `${name(roles.second)} (B)` : name(roles.second);
  sendWorkflowStatus({ key: 'workflow.consult.initial', params: { first: firstName, second: secondName } });
  let firstResponse: string;
  let secondResponse: string;
  if (sameInitial) {
    // A single provider tab can only handle one request at a time, so run the two answers back to back.
    sendRoleAssignment(roles.first, 'role.first');
    firstResponse = await sendAndWait(roles.first, PROMPTS.consult.first(text), workflowId);
    checkAborted(workflowId);
    sendRoleAssignment(roles.second, 'role.second');
    secondResponse = await sendAndWait(roles.second, PROMPTS.consult.second(text), workflowId);
  } else {
    sendRoleAssignment(roles.first, 'role.first');
    sendRoleAssignment(roles.second, 'role.second');
    [firstResponse, secondResponse] = await Promise.all([
      sendAndWait(roles.first, PROMPTS.consult.first(text), workflowId),
      sendAndWait(roles.second, PROMPTS.consult.second(text), workflowId),
    ]);
  }
  checkAborted(workflowId);

  sendWorkflowStatus(status('workflow.consult.review', roles.reviewer));
  sendRoleAssignment(roles.reviewer, 'role.reviewer');
  const reviewerResponse = await sendAndWait(
    roles.reviewer,
    PROMPTS.consult.reviewer(text, firstResponse, firstName, secondResponse, secondName),
    workflowId,
  );
  checkAborted(workflowId);

  sendWorkflowStatus(status('workflow.consult.summary', roles.summary));
  sendRoleAssignment(roles.summary, 'role.summary');
  await sendAndWait(
    roles.summary,
    PROMPTS.consult.summary(text, firstResponse, firstName, secondResponse, secondName, reviewerResponse, name(roles.reviewer)),
    workflowId,
  );
}

async function handleCodingMode(text: string, roles: CodingRoles, workflowId: string): Promise<void> {
  sendCodingStatus(1, roles.planner, 'coding.spec'); sendRoleAssignment(roles.planner, 'role.planner');
  const spec = await sendAndWait(roles.planner, PROMPTS.coding.plannerSpec(text), workflowId); checkAborted(workflowId);
  sendCodingStatus(2, roles.reviewer, 'coding.specReview'); sendRoleAssignment(roles.reviewer, 'role.reviewer');
  const specReview = await sendAndWait(roles.reviewer, PROMPTS.coding.reviewerSpec(text, spec, name(roles.planner)), workflowId); checkAborted(workflowId);
  sendCodingStatus(3, roles.coder, 'coding.codeV1'); sendRoleAssignment(roles.coder, 'role.coder');
  const codeV1 = await sendAndWait(roles.coder, PROMPTS.coding.coderV1(text, spec, name(roles.planner), specReview, name(roles.reviewer)), workflowId); checkAborted(workflowId);
  sendCodingStatus(4, roles.reviewer, 'coding.codeReview'); sendRoleAssignment(roles.reviewer, 'role.reviewer');
  const codeReview = await sendAndWait(roles.reviewer, PROMPTS.coding.reviewerCode(text, codeV1, name(roles.coder)), workflowId); checkAborted(workflowId);
  sendCodingStatus(5, roles.tester, 'coding.test'); sendRoleAssignment(roles.tester, 'role.tester');
  const testReport = await sendAndWait(roles.tester, PROMPTS.coding.testerCases(text, codeV1, name(roles.coder)), workflowId); checkAborted(workflowId);
  sendCodingStatus(6, roles.coder, 'coding.codeV2'); sendRoleAssignment(roles.coder, 'role.coder');
  const codeV2 = await sendAndWait(roles.coder, PROMPTS.coding.coderV2(text, codeV1, codeReview, name(roles.reviewer), testReport, name(roles.tester)), workflowId); checkAborted(workflowId);
  sendCodingStatus(7, roles.planner, 'coding.acceptance'); sendRoleAssignment(roles.planner, 'role.planner');
  const acceptance = await sendAndWait(roles.planner, PROMPTS.coding.plannerAcceptance(text, codeV2, name(roles.coder), spec), workflowId); checkAborted(workflowId);
  sendCodingStatus(8, roles.coder, 'coding.final'); sendRoleAssignment(roles.coder, 'role.coder');
  await sendAndWait(roles.coder, PROMPTS.coding.coderFinal(text, codeV2, acceptance, name(roles.planner)), workflowId);
}

async function handleRoundtableMode(text: string, roles: RoundtableRoles, workflowId: string): Promise<void> {
  if (roundtableSeats(roles, name).length === 0) throw new Error(encodeError('error.no_selection'));
  await runRoundtableWorkflow(text, roles, workflowId, {
    checkAborted,
    providerName: name,
    buildPrompt: PROMPTS.roundtable.buildPrompt,
    createRequestId: createProviderRequestId,
    sendStatus: async (round, participant) => {
      await sendWorkflowStatus({ key: 'workflow.roundtable', params: { round, labelKey: `round.${round}`, provider: name(participant) } });
    },
    sendRoleAssignment,
    sendAndWait: (participant, prompt, activeId, requestId) => sendAndWait(participant, prompt, activeId, true, requestId),
    requestRecovery: requestStepRecovery,
    resetProvider: resetProviderAfterFailure,
    cancelWorkflow: abortWorkflow,
  });
}

function sendCodingStatus(current: number, provider: AIProvider, actionKey: string): void {
  sendWorkflowStatus({ key: 'workflow.coding', params: { current, provider: name(provider), actionKey } });
}

function status(key: string, provider: AIProvider): WorkflowStatusPayload {
  return { key, params: { provider: name(provider) } };
}

function name(provider: AIProvider): string {
  return AI_PROVIDERS[provider].name;
}

async function sendWorkflowStatus(
  payload: WorkflowStatusPayload,
  workflowId = activeWorkflowId,
  sessionId = activeSessionId,
  clientId = activeClientId,
): Promise<void> {
  if (workflowId && workflowId === activeWorkflowId && !payload.done) {
    lastWorkflowStatus = { key: payload.key, params: payload.params };
  }
  await chrome.runtime.sendMessage({
    action: 'WORKFLOW_STATUS',
    payload: { ...payload, workflowId, sessionId, clientId },
  }).catch(() => {});
}

async function sendRoleAssignment(
  provider: AIProvider,
  labelKey: string,
  requestId?: string,
  scope?: { workflowId?: string; sessionId?: string; clientId?: string },
): Promise<void> {
  const workflowId = scope?.workflowId ?? activeWorkflowId;
  const sessionId = scope?.sessionId ?? activeSessionId;
  const clientId = scope?.clientId ?? activeClientId;
  if (!scope && workflowId && workflowId === activeWorkflowId) {
    lastRoleAssignment = { provider, labelKey, requestId };
  }
  await chrome.runtime.sendMessage({
    action: 'ROLE_ASSIGNMENT',
    provider,
    requestId,
    workflowId,
    payload: { labelKey, sessionId, clientId },
  }).catch(() => {});
}

function requestStepRecovery(
  provider: AIProvider,
  error: unknown,
  workflowId: string,
  failedRequestId: string,
): Promise<StepRecoveryAction> {
  checkAborted(workflowId);
  if (!activeSessionId || !activeClientId) throw new DOMException('Workflow cancelled', 'AbortError');
  return stepRecovery.waitForDecision(
    {
      workflowId,
      sessionId: activeSessionId,
      clientId: activeClientId,
      provider,
      failedRequestId,
      reason: errorMessage(error),
    },
    broadcastStepRecovery,
    new Error(encodeError('error.recovery_timeout', { provider })),
  );
}

async function resetProviderAfterFailure(provider: AIProvider, failedRequestId: string, workflowId: string): Promise<void> {
  await resetProviderRequest(provider, failedRequestId, workflowId, connections[provider].tabId);
}

async function resetProviderRequest(provider: AIProvider, requestId: string, workflowId: string, tabId?: number): Promise<void> {
  if (!tabId) return;
  await deliverToTab(provider, tabId, {
    action: 'STOP_GENERATION',
    provider,
    requestId,
    workflowId,
  }).catch(() => {});
}

function broadcastStepRecovery(request: StepRecoveryRequest): void {
  stepRecoveryReplay.publish(request, sendStepRecoveryMessage);
}

function sendStepRecoveryMessage(request: StepRecoveryRequest): void {
  chrome.runtime.sendMessage({
    action: 'STEP_RECOVERY_REQUIRED',
    provider: request.provider,
    requestId: request.failedRequestId,
    workflowId: request.workflowId,
    payload: request,
  }).catch(() => {});
}

function sendProviderFailure(error: ProviderRequestError): void {
  chrome.runtime.sendMessage({
    action: 'RESPONSE_DONE',
    provider: error.provider,
    requestId: error.requestId,
    workflowId: error.workflowId,
    payload: `Error: ${error.message}`,
  }).catch(() => {});
}

async function adoptSidePanelClient(target?: { clientId?: string; sessionId?: string }): Promise<void> {
  const targetClientId = target?.clientId;
  const targetSessionId = target?.sessionId;
  const workflowId = activeWorkflowId;
  const sessionId = activeSessionId;
  const previousClientId = activeClientId;
  const statusSnapshot = lastWorkflowStatus;
  const roleSnapshot = lastRoleAssignment;

  if (workflowId && sessionId && previousClientId && targetClientId && targetSessionId === sessionId) {
    if (targetClientId !== previousClientId && workflowLifecycle.canOwnRecovery(workflowId, targetClientId)) {
      const registered = workflowLifecycle.current(workflowId);
      if (registered
        && registered.sessionId === sessionId
        && registered.clientId === previousClientId
        && workflowLifecycle.rebind(workflowId, sessionId, targetClientId)) {
        workflowLifecycle.revokeRecoveryOwner(workflowId, previousClientId);
        stepRecovery.rebindClient(workflowId, sessionId, targetClientId);
        if (activeWorkflowId === workflowId) activeClientId = targetClientId;
        await sendWorkflowStatus(
          { key: '', done: true, cancelled: true },
          workflowId,
          sessionId,
          previousClientId,
        );
      }
    }
    if (activeWorkflowId === workflowId
      && activeSessionId === sessionId
      && activeClientId === targetClientId) {
      await sendWorkflowStatus(
        statusSnapshot ?? { key: 'workflow.starting' },
        workflowId,
        sessionId,
        targetClientId,
      );
      if (roleSnapshot && activeWorkflowId === workflowId && activeSessionId === sessionId) {
        await sendRoleAssignment(
          roleSnapshot.provider,
          roleSnapshot.labelKey,
          roleSnapshot.requestId,
          { workflowId, sessionId, clientId: targetClientId },
        );
      }
    }
  }
  await replayPendingStepRecovery(target);
  await notifyInterruptedWorkflow(target);
}

async function replayPendingStepRecovery(target?: { clientId?: string; sessionId?: string }): Promise<void> {
  await stepRecoveryReplay.replay(async () => {
    const current = stepRecovery.current();
    if (!current || !target?.clientId || target.sessionId !== current.sessionId) return undefined;
    const targetClientId = target.clientId;
    if (!workflowLifecycle.canOwnRecovery(current.workflowId, targetClientId)) return undefined;
    if (targetClientId === current.clientId) return current;
    const registered = workflowLifecycle.current(current.workflowId);
    if (!registered
      || registered.sessionId !== current.sessionId
      || registered.clientId !== current.clientId) return undefined;
    return transferStepRecoveryOwnership(
      current,
      targetClientId,
      () => {
        const next = stepRecovery.rebindClient(current.workflowId, current.sessionId, targetClientId);
        if (!next) return undefined;
        workflowLifecycle.rebind(current.workflowId, current.sessionId, targetClientId);
        workflowLifecycle.revokeRecoveryOwner(current.workflowId, current.clientId);
        activeClientId = targetClientId;
        return next;
      },
      async (previous) => {
        await sendWorkflowStatus(
          { key: '', done: true, cancelled: true },
          previous.workflowId,
          previous.sessionId,
          previous.clientId,
        );
      },
      (candidate) => stepRecovery.current()?.recoveryId === candidate.recoveryId,
    );
  }, sendStepRecoveryMessage);
}

function sendSystemError(message: string, workflowId = activeWorkflowId): void {
  chrome.runtime.sendMessage({
    action: 'RESPONSE_DONE',
    provider: 'system' as AIProvider,
    requestId: `system:${crypto.randomUUID()}`,
    workflowId,
    payload: `Error: ${message}`,
  }).catch(() => {});
}

async function handleHackMDPublish(payload: { token: string; title: string; content: string }) {
  const response = await fetch('https://api.hackmd.io/v1/notes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${payload.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: payload.title,
      content: payload.content,
      readPermission: 'guest',
      writePermission: 'owner',
      commentPermission: 'disabled',
    }),
  });
  if (!response.ok) throw new Error(encodeError('error.hackmd_failed', { status: response.status, detail: await response.text().catch(() => response.statusText) }));
  const data = (await response.json()) as { id?: string; publishLink?: string };
  const publishLink = data.publishLink || (data.id ? `https://hackmd.io/@/${data.id}/publish` : '');
  if (!publishLink) throw new Error(encodeError('error.hackmd_no_link'));
  return { publishLink, editLink: data.id ? `https://hackmd.io/${data.id}` : '' };
}

function enqueueMetaHostAccess<T>(operation: () => Promise<T>): Promise<T> {
  const run = metaHostAccessChain.then(operation, operation);
  metaHostAccessChain = run.then(() => undefined, () => undefined);
  return run;
}

function syncMetaHostAccessWithChrome(): Promise<MetaHostAccessSyncResult> {
  return syncMetaHostAccess({
    hasPermission: () => chrome.permissions.contains({ origins: [...META_ORIGINS] }),
    getRegistered: async () => {
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      return scripts.map((script) => ({ id: script.id }));
    },
    register: (script) => chrome.scripting.registerContentScripts([script]),
    unregister: (ids) => chrome.scripting.unregisterContentScripts({ ids: [...ids] }),
  });
}

// Standby other than Meta is legal only while the meta origins are granted.
// A running workflow blocks the seat change; leave storage unchanged so the next
// reconcile can retry instead of treating the blocked attempt as finished.
function reconcileMetaHostAccess(): Promise<void> {
  return enqueueMetaHostAccess(async () => {
    try {
      console.info('Meta host access', await syncMetaHostAccessWithChrome());
    } catch (error: unknown) {
      console.error('Meta host access sync failed', error);
    }
    await providerSelectionReady;
    const permitted = await chrome.permissions.contains({ origins: [...META_ORIGINS] });
    if (permitted || standbyProvider === 'meta') return;
    await commitStandbyProvider('meta');
  });
}

function trackMetaHostAccess(): void {
  void reconcileMetaHostAccess().catch((error: unknown) => {
    console.error('Could not reconcile Meta AI host access', error);
  });
}

function commitStandbyProvider(next: AIProvider): Promise<{ ok: true; standbyProvider: AIProvider; freeTargets: AIProvider[] }> {
  return workflowStartGate.run(async () => {
    await providerSelectionReady;
    if (activeWorkflowId) throw new Error(encodeError('error.provider_change_busy'));
    const stored = await chrome.storage.local.get('freeTargets');
    const freeTargets = swapFreeTargets(stored.freeTargets, next, standbyProvider);
    await chrome.storage.local.set({ standbyProvider: next, freeTargets });
    standbyProvider = next;
    chrome.runtime.sendMessage({
      action: 'PROVIDER_SELECTION_UPDATE',
      payload: { standbyProvider, freeTargets },
    }).catch(() => {});
    return { ok: true as const, standbyProvider, freeTargets };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
