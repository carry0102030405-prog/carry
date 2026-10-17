import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplyStabilityTracker, STABLE_REPLY_OVERRIDE_MS } from '../src/content/replyStability.ts';
import { DiagLog } from '../src/shared/diagLog.ts';

test('the override fires once a non-empty reply stays unchanged for 12–15 s', () => {
  assert.ok(STABLE_REPLY_OVERRIDE_MS >= 12_000 && STABLE_REPLY_OVERRIDE_MS <= 15_000);
  const tracker = new ReplyStabilityTracker();
  tracker.observe('', 0);
  tracker.observe(null, 1000);
  assert.equal(tracker.shouldForceComplete(60_000), false, 'nothing to complete yet');
  tracker.observe('你好', 2000);
  tracker.observe('你好！很高兴', 4000);
  assert.equal(tracker.shouldForceComplete(4000 + STABLE_REPLY_OVERRIDE_MS - 1), false);
  tracker.observe('你好！很高兴', 10_000);
  tracker.observe('', 12_000); // a transient empty read does not reset the clock
  assert.equal(tracker.stableForMs(15_000), 11_000);
  assert.equal(tracker.shouldForceComplete(4000 + STABLE_REPLY_OVERRIDE_MS), true);
  assert.equal(tracker.candidate, '你好！很高兴');
});

test('a reply that is already complete at the first read still completes', () => {
  const tracker = new ReplyStabilityTracker(13_000);
  tracker.observe('完整的回答。', 5000);
  for (let now = 6000; now < 18_000; now += 1000) {
    tracker.observe('完整的回答。', now);
    assert.equal(tracker.shouldForceComplete(now), false);
  }
  assert.equal(tracker.shouldForceComplete(18_000), true);
  tracker.reset();
  assert.equal(tracker.shouldForceComplete(99_000), false);
});

test('growing text keeps postponing the override', () => {
  const tracker = new ReplyStabilityTracker(14_000);
  let text = '';
  for (let now = 0; now <= 60_000; now += 5000) {
    text += '字';
    tracker.observe(text, now);
    assert.equal(tracker.shouldForceComplete(now), false);
  }
});

test('the diagnostic log keeps only the most recent entries and trims big fields', () => {
  let clock = Date.UTC(2026, 9, 15, 15, 0, 0);
  const log = new DiagLog(3, () => clock++);
  for (let index = 0; index < 5; index += 1) log.add(`event-${index}`, { index, text: 'x'.repeat(1000) });
  const entries = log.snapshot();
  assert.deepEqual(entries.map((entry) => entry.event), ['event-2', 'event-3', 'event-4']);
  assert.ok(String((entries[0].data as { text: string }).text).length < 700);
  assert.match(entries[0].t, /^2026-10-15T15:00:00/);
});
