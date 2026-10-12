// Tests for the heatmap's scoring (lib/heatmap.ts).
// Run: node --experimental-strip-types --test tests/heatmap.test.mjs   (Node 22.6+)
import { test } from "node:test";
import assert from "node:assert/strict";
import { BANDS, bandFor, scoreTask, scorePerson, slackFor } from "../lib/heatmap.ts";

const H = 3600e3;
const D = 24 * H;
const T0 = Date.parse("2026-10-12T09:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const task = (over = {}) => ({
  id: over.id || "t1",
  title: over.title || "Task",
  status: "in_progress",
  start: iso(T0),
  due: iso(T0 + 4 * D),
  completed_at: null,
  items: 0,
  done: 0,
  ...over,
});

test("colour bands: edges", () => {
  const at = (s) => bandFor(s).key;
  assert.equal(at(0), "critical");
  assert.equal(at(20), "critical");
  assert.equal(at(21), "behind");
  assert.equal(at(40), "behind");
  assert.equal(at(41), "neutral");
  assert.equal(at(60), "neutral");
  assert.equal(at(61), "good");
  assert.equal(at(80), "good");
  assert.equal(at(81), "excellent");
  assert.equal(at(100), "excellent");
  assert.equal(at(-5), "critical");
  assert.equal(at(140), "excellent");
  assert.equal(BANDS.length, 5);
});

test("the brief's example: 10 items over 4 days, 4 done at the end of day 2 -> slightly behind (light green)", () => {
  const h = scoreTask(task({ items: 10, done: 4 }), T0 + 2 * D);
  assert.equal(h.score, 80);
  assert.equal(h.band.key, "good");
  assert.equal(h.state, "behind");
  assert.match(h.reason, /4 of 10 items done, about 5 expected by now/);
});

test("same work, different time: the colour follows the clock", () => {
  const t = task({ items: 10, done: 3 });
  const at = (x) => scoreTask(t, T0 + x * D);
  assert.equal(at(1).score, 100); // 2.5 expected: ahead
  assert.equal(at(2).band.key, "good"); // 5 expected: 61
  assert.equal(at(3).band.key, "neutral"); // 7.5 expected: 3.1 / 7.6 = 41
  assert.equal(at(4 - 1 / 1440).band.key, "behind"); // 10 expected: 31
  assert.equal(at(4 + 1 / 24).state, "overdue");
  const scores = [1, 2, 3, 3.9, 4.1, 5].map((x) => at(x).score);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i] <= scores[i - 1], scores.join(" "));
});

test("shortfall bands at half time on a 10-item list", () => {
  const at = (done) => scoreTask(task({ items: 10, done }), T0 + 2 * D);
  assert.equal(at(5).score, 100);
  assert.equal(at(3).band.key, "good"); // 61
  assert.equal(at(2).band.key, "neutral"); // 41
  assert.equal(at(1).band.key, "behind"); // 22
  assert.equal(at(0).band.key, "critical"); // 2
});

test("a task with no checklist moves through the colours as its time runs out", () => {
  const t = task();
  assert.equal(scoreTask(t, T0 + 0.2 * D).state, "early");
  assert.equal(scoreTask(t, T0 + 0.2 * D).score, 100);
  assert.equal(scoreTask(t, T0 + 1.2 * D).band.key, "good"); // 30%
  assert.equal(scoreTask(t, T0 + 2 * D).band.key, "neutral"); // 50%
  assert.equal(scoreTask(t, T0 + 3.2 * D).band.key, "behind"); // 80%
  const late = scoreTask(t, T0 + 4 * D + 60e3);
  assert.equal(late.state, "overdue");
  assert.equal(late.band.key, "critical");
});

test("start of a task: no division by zero, nobody punished", () => {
  const t = task({ items: 10 });
  const first = scoreTask(t, T0);
  assert.equal(first.score, 100);
  assert.equal(first.state, "early");
  assert.equal(scoreTask(t, T0 + 0.39 * D).score, 100); // under 10% of 4 days
  // Between 10% and 20% the shortfall phases in rather than jumping.
  const a = scoreTask(t, T0 + 0.41 * D).score;
  const b = scoreTask(t, T0 + 0.6 * D).score;
  const c = scoreTask(t, T0 + 0.8 * D).score;
  assert.ok(a > b && b > c, `${a} > ${b} > ${c}`);
  assert.ok(a >= 90);
});

test("deadline set at the moment of creation, or before the task was given", () => {
  const same = scoreTask(task({ due: iso(T0) }), T0);
  assert.ok(Number.isFinite(same.score));
  const backwards = scoreTask(task({ start: iso(T0 + D), due: iso(T0) }), T0 + 2 * D);
  assert.equal(backwards.state, "overdue");
  assert.ok(Number.isFinite(backwards.score));
});

test("reported progress counts for a task with no checklist", () => {
  assert.equal(scoreTask(task({ done: 0.6 }), T0 + 2 * D).score, 100);
  assert.equal(scoreTask(task({ done: 0.4 }), T0 + 2 * D).band.key, "excellent"); // (0.4+0.5)/(0.5+0.5)
  assert.match(scoreTask(task({ done: 0.2 }), T0 + 2 * D).reason, /20% reported done/);
});

test("changing a status without progress changes nothing", () => {
  const now = T0 + 2 * D;
  const a = scoreTask(task({ items: 5, done: 1, status: "pending" }), now).score;
  const b = scoreTask(task({ items: 5, done: 1, status: "in_progress" }), now).score;
  const c = scoreTask(task({ items: 5, done: 1, status: "need_help" }), now).score;
  assert.equal(a, b);
  assert.equal(b, c);
});

test("a new checklist item lowers the share done; a removed one raises it", () => {
  const now = T0 + 2 * D;
  const ten = scoreTask(task({ items: 10, done: 4 }), now).score;
  const eleven = scoreTask(task({ items: 11, done: 4 }), now).score;
  const nine = scoreTask(task({ items: 9, done: 4 }), now).score;
  assert.ok(eleven < ten && ten < nine, `${eleven} < ${ten} < ${nine}`);
});

test("finished on time is dark green and stays so", () => {
  const t = task({ status: "done", completed_at: iso(T0 + 3 * D), items: 10, done: 10 });
  for (const later of [T0 + 3 * D, T0 + 5 * D, T0 + 9 * D]) {
    const h = scoreTask(t, later);
    assert.equal(h.score, 100);
    assert.equal(h.state, "done_on_time");
  }
});

test("finished late: a fixed penalty that never grows", () => {
  const t = task({ status: "closed", completed_at: iso(T0 + 5 * D) }); // 1 day late on a 4-day window
  const a = scoreTask(t, T0 + 5 * D);
  const b = scoreTask(t, T0 + 30 * D);
  assert.equal(a.state, "done_late");
  assert.equal(a.score, 85); // 100 - 60 x 1/4
  assert.equal(b.score, a.score);
  assert.match(a.reason, /Finished 1 day late/);
  const veryLate = scoreTask(task({ status: "done", completed_at: iso(T0 + 40 * D) }), T0 + 41 * D);
  assert.equal(veryLate.score, 40);
});

test("overdue: light red at best, fading to dark red", () => {
  const t = task({ items: 10, done: 9 });
  const justLate = scoreTask(t, T0 + 4 * D + 60e3);
  assert.equal(justLate.band.key, "behind"); // 40 x 9.1/10.1 = 36
  assert.ok(justLate.score <= 40);
  const later = scoreTask(t, T0 + 6 * D);
  assert.ok(later.score < justLate.score);
  const muchLater = scoreTask(t, T0 + 9 * D);
  assert.equal(muchLater.score, 0);
  assert.match(justLate.reason, /Overdue by 1 minute; 9 of 10 items done/);
});

test("approved extension: the new deadline is used", () => {
  const before = scoreTask(task({ items: 4, done: 1 }), T0 + 3 * D);
  const extended = scoreTask(task({ items: 4, done: 1, due: iso(T0 + 8 * D) }), T0 + 3 * D);
  assert.ok(extended.score > before.score);
});

test("reopened after being finished: scored as open work again", () => {
  const reopened = scoreTask(task({ status: "in_progress", completed_at: null, items: 3, done: 2 }), T0 + 5 * D);
  assert.equal(reopened.state, "overdue");
});

test("not scored: no deadline, waiting on another task", () => {
  const none = scoreTask(task({ due: null }), T0 + D);
  assert.equal(none.score, null);
  assert.equal(none.counts, false);
  const blocked = scoreTask(task({ blocked: true }), T0 + 10 * D);
  assert.equal(blocked.score, null);
  assert.equal(blocked.state, "blocked");
});

test("time zones don't matter: the same moments give the same score", () => {
  const utc = scoreTask(task({ items: 6, done: 2, start: "2026-10-12T09:00:00Z", due: "2026-10-14T09:00:00Z" }), Date.parse("2026-10-13T09:00:00Z"));
  const ist = scoreTask(task({ items: 6, done: 2, start: "2026-10-12T14:30:00+05:30", due: "2026-10-14T14:30:00+05:30" }), Date.parse("2026-10-13T14:30:00+05:30"));
  assert.equal(utc.score, ist.score);
});

test("slack shrinks with task size", () => {
  assert.equal(slackFor(1), 0.5);
  assert.equal(slackFor(2), 0.5);
  assert.equal(slackFor(4), 0.25);
  assert.equal(slackFor(10), 0.1);
});

test("person: nothing assigned -> no colour", () => {
  const p = scorePerson([], T0);
  assert.equal(p.score, null);
  assert.equal(p.band, null);
  assert.equal(p.reason, "Nothing due");
});

test("person: weighted by task size, explained, with the main reason", () => {
  const now = T0 + 2 * D;
  const big = task({ id: "big", title: "Big list", items: 10, done: 1 }); // 22, weight 10
  const small = task({ id: "small", title: "Small", done: 0.5 }); // 100, weight 1
  const p = scorePerson([big, small], now);
  assert.equal(p.score, Math.round((10 * 22 + 1 * 100) / 11));
  assert.equal(p.band.key, "behind");
  assert.match(p.reason, /^Light red - \d+% done; about \d+% was expected by now$/);
  assert.match(p.main, /Big list/);
  assert.equal(p.open, 2);
  assert.equal(p.nextDue, iso(T0 + 4 * D));
});

test("person: finished work counts for a week, then drops out", () => {
  const done = task({ id: "d", status: "done", completed_at: iso(T0 + D) });
  const open = task({ id: "o", items: 10, done: 2, start: iso(T0 + 2 * D), due: iso(T0 + 6 * D) });
  const soon = scorePerson([done, open], T0 + 4 * D);
  const later = scorePerson([done, { ...open, due: iso(T0 + 30 * D) }], T0 + 10 * D);
  assert.equal(soon.finishedRecently, 1);
  assert.equal(later.finishedRecently, 0);
  assert.ok(soon.perTask.get("d").counts);
  assert.equal(later.perTask.get("d").counts, false);
});

test("person: only unscored work -> no colour, says why", () => {
  const p = scorePerson([task({ due: null })], T0 + D);
  assert.equal(p.score, null);
  assert.equal(p.reason, "Nothing with a deadline to score");
});

test("person: last progress and overdue count", () => {
  const p = scorePerson(
    [task({ id: "a", items: 3, done: 1, last_progress_at: iso(T0 + H) }), task({ id: "b", last_progress_at: iso(T0 + 2 * H), due: iso(T0 + D) })],
    T0 + 2 * D
  );
  assert.equal(p.lastProgress, iso(T0 + 2 * H));
  assert.equal(p.overdue, 1);
});

test("finished with no finishing time (old data): shown, not counted", () => {
  const h = scoreTask(task({ status: "done", completed_at: null }), T0 + D);
  assert.equal(h.state, "done_on_time");
  assert.equal(h.counts, false);
  assert.equal(scorePerson([task({ status: "done", completed_at: null })], T0 + D).score, null);
});
