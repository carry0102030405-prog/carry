import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { t } from '../src/shared/i18n.ts';

const app = readFileSync(new URL('../src/sidepanel/App.tsx', import.meta.url), 'utf8');

test('新对话 and history selection only change the panel, never the AI pages', () => {
  assert.doesNotMatch(app, /RESET_PROVIDER_SESSIONS/);
  assert.doesNotMatch(app, /RESTORE_PROVIDER_SESSIONS/);
  const start = app.slice(app.indexOf('const startNewConversation'), app.indexOf('const selectConversation'));
  const select = app.slice(app.indexOf('const selectConversation'), app.indexOf('const deleteConversation'));
  for (const body of [start, select]) assert.doesNotMatch(body, /chrome\.(runtime|tabs)\./);
});

test('the 新对话 button sits in the panel header', () => {
  const header = app.slice(app.indexOf('<header'), app.indexOf('</header>'));
  assert.match(header, /onClick=\{startNewConversation\}/);
  assert.equal(t('app.new', undefined, 'zh-TW'), '新对话');
});
