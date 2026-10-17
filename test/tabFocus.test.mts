import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeAutoForeground, TabFocusManager, type FocusTab, type TabFocusApi } from '../src/background/tabFocus.ts';

interface FakeBrowser {
  tabs: Map<number, FocusTab>;
  focusedWindow: number | undefined;
  enabled: boolean;
  calls: string[];
  timers: { callback: () => void; ms: number; cleared: boolean }[];
}

function fake(initial: FocusTab[], focusedWindow: number | null = 1): { browser: FakeBrowser; api: TabFocusApi } {
  const browser: FakeBrowser = {
    tabs: new Map(initial.map((tab) => [tab.id!, { ...tab }])),
    focusedWindow: focusedWindow ?? undefined,
    enabled: true,
    calls: [],
    timers: [],
  };
  const activate = (tabId: number) => {
    const target = browser.tabs.get(tabId)!;
    for (const tab of browser.tabs.values()) if (tab.windowId === target.windowId) tab.active = tab.id === tabId;
  };
  const api: TabFocusApi = {
    getUserTab: async () => [...browser.tabs.values()].find((tab) => tab.active && tab.windowId === browser.focusedWindow),
    getTab: async (tabId) => {
      const tab = browser.tabs.get(tabId);
      if (!tab) throw new Error('No tab');
      return { ...tab };
    },
    getActiveTab: async (windowId) => [...browser.tabs.values()].find((tab) => tab.active && tab.windowId === windowId),
    activateTab: async (tabId) => { browser.calls.push(`activate:${tabId}`); activate(tabId); },
    focusWindow: async (windowId) => { browser.calls.push(`focus:${windowId}`); browser.focusedWindow = windowId; },
    getFocusedWindowId: async () => browser.focusedWindow,
    isEnabled: async () => browser.enabled,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      browser.timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  };
  return { browser, api };
}

async function fireTimers(browser: FakeBrowser): Promise<void> {
  for (const timer of browser.timers.splice(0)) if (!timer.cleared) timer.callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const activeId = (browser: FakeBrowser, windowId: number) => [...browser.tabs.values()].find((tab) => tab.active && tab.windowId === windowId)?.id;

test('brings the replying provider tab forward and restores the user tab after the grace period', async () => {
  const { browser, api } = fake([
    { id: 10, windowId: 1, active: true }, // user's tab
    { id: 20, windowId: 1, active: false }, // grok
  ]);
  const focus = new TabFocusManager(api, 100);
  await focus.beginStep('r1', 20);
  assert.equal(activeId(browser, 1), 20);
  await focus.endStep('r1');
  assert.equal(activeId(browser, 1), 20, 'no bounce before the grace period');
  await fireTimers(browser);
  assert.equal(activeId(browser, 1), 10);
  assert.deepEqual(browser.calls, ['activate:20', 'activate:10']);
});

test('consecutive steps hand off without bouncing back to the user tab', async () => {
  const { browser, api } = fake([
    { id: 10, windowId: 1, active: true },
    { id: 20, windowId: 1, active: false },
    { id: 30, windowId: 1, active: false },
  ]);
  const focus = new TabFocusManager(api, 100);
  await focus.beginStep('r1', 20);
  await focus.endStep('r1');
  await focus.beginStep('r2', 30);
  assert.equal(browser.timers.every((timer) => timer.cleared), true, 'pending restore cancelled');
  await fireTimers(browser);
  assert.equal(activeId(browser, 1), 30);
  await focus.endRun();
  assert.equal(activeId(browser, 1), 10);
  assert.deepEqual(browser.calls, ['activate:20', 'activate:30', 'activate:10']);
});

test('endRun (stop / pause) restores immediately', async () => {
  const { browser, api } = fake([
    { id: 10, windowId: 1, active: true },
    { id: 20, windowId: 1, active: false },
  ]);
  const focus = new TabFocusManager(api, 100);
  await focus.beginStep('r1', 20);
  await focus.endRun();
  assert.equal(activeId(browser, 1), 10);
  assert.equal(focus.state().origin, undefined);
});

test('a provider in another window gets that window focused, then the original window back', async () => {
  const { browser, api } = fake([
    { id: 10, windowId: 1, active: true },
    { id: 20, windowId: 2, active: false },
    { id: 21, windowId: 2, active: true },
  ]);
  const focus = new TabFocusManager(api, 100);
  await focus.beginStep('r1', 20);
  assert.equal(browser.focusedWindow, 2);
  assert.equal(activeId(browser, 2), 20);
  await focus.endRun();
  assert.equal(browser.focusedWindow, 1);
  assert.equal(activeId(browser, 1), 10);
});

test('never pulls Chrome in front of another application', async () => {
  const { browser, api } = fake([
    { id: 10, windowId: 1, active: true },
    { id: 20, windowId: 2, active: false },
  ], null);
  const focus = new TabFocusManager(api, 100);
  await focus.beginStep('r1', 20);
  assert.equal(browser.calls.includes('focus:2'), false);
});

test('does not undo a tab switch the user made during the run', async () => {
  const { browser, api } = fake([
    { id: 10, windowId: 1, active: true },
    { id: 20, windowId: 1, active: false },
    { id: 40, windowId: 1, active: false },
  ]);
  const focus = new TabFocusManager(api, 100);
  await focus.beginStep('r1', 20);
  browser.tabs.get(20)!.active = false;
  browser.tabs.get(40)!.active = true; // the user clicked another tab
  await focus.endRun();
  assert.equal(activeId(browser, 1), 40);
});

test('does nothing when the setting is off, or the tab is already in front', async () => {
  const { browser, api } = fake([
    { id: 10, windowId: 1, active: true },
    { id: 20, windowId: 1, active: false },
  ]);
  browser.enabled = false;
  const focus = new TabFocusManager(api, 100);
  await focus.beginStep('r1', 20);
  await focus.endRun();
  assert.deepEqual(browser.calls, []);

  browser.enabled = true;
  await focus.beginStep('r2', 10);
  await focus.endRun();
  assert.deepEqual(browser.calls, []);
});

test('closed tabs are tolerated', async () => {
  const { browser, api } = fake([
    { id: 10, windowId: 1, active: true },
    { id: 20, windowId: 1, active: false },
  ]);
  const focus = new TabFocusManager(api, 100);
  await focus.beginStep('r1', 20);
  browser.tabs.delete(10);
  await focus.endRun();
  await focus.beginStep('r2', 99);
  assert.deepEqual(browser.calls, ['activate:20']);
});

test('auto-foreground defaults to on', () => {
  assert.equal(normalizeAutoForeground(undefined), true);
  assert.equal(normalizeAutoForeground(true), true);
  assert.equal(normalizeAutoForeground(false), false);
});

test('side panel stays window-global: no per-tab side panel options in the worker', () => {
  const worker = readFileSync(new URL('../src/background/service-worker.ts', import.meta.url), 'utf8');
  assert.match(worker, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/);
  assert.doesNotMatch(worker, /sidePanel\.setOptions/);
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.deepEqual(manifest.permissions, ['sidePanel', 'tabs', 'storage', 'scripting']);
  assert.equal(manifest.key, undefined);
  assert.equal(manifest.name, 'carry');
  assert.equal(manifest.short_name, 'carry');
  assert.equal(manifest.action.default_title, 'carry');
});
