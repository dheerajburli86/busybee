// Tests for the heatmap rules (lib/heatmap.ts).
// Run: npm run test:heatmap   (Node 22.6+)
import { test } from "node:test";
import assert from "node:assert/strict";
import { BANDS, scoreTask, scorePerson } from "../lib/heatmap.ts";

const H = 3600e3;
const D = 24 * H;
const T0 = Date.parse("2026-10-12T09:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
// A 10-day task with 10 items unless said otherwise.
const task = (over = {}) => ({
  id: over.id || "t1",
  title: over.title || "Task",
  status: "in_progress",
  start: iso(T0),
  due: iso(T0 + 10 * D),
  completed_at: null,
  items: 10,
  done: 0,
  ...over,
});
const at = (t, days) => scoreTask(t, T0 + days * D);

test("five colours, labels, no numbers", () => {
  assert.deepEqual(BANDS.map((b) => b.label), ["Overdue", "Deadline close!", "Pending - still time", "On track", "Ahead"]);
  const h = at(task({ done: 3 }), 4);
  assert.equal("score" in h, false);
  assert.doesNotMatch(h.reason, /\/100|score/i);
});

test("past the deadline is overdue (dark red) however little is left", () => {
  for (const done of [0, 5, 9.5]) {
    const h = scoreTask(task({ done }), T0 + 10 * D + 60e3);
    assert.equal(h.state, "overdue");
    assert.equal(h.band.colour, "Dark red");
    assert.equal(h.label, "Overdue");
  }
  assert.match(scoreTask(task({ done: 4 }), T0 + 12 * D).reason, /^Overdue by 2 days; 4 of 10 items done$/);
});

test("final stretch with most work left: deadline close (light red)", () => {
  const h = at(task({ done: 4 }), 8.5); // 6 of 10 left, last fifth of the time
  assert.equal(h.state, "close");
  assert.equal(h.band.colour, "Light red");
  assert.match(h.reason, /^Due in 1 day 12 hours; 4 of 10 items done$/);
});

test("final stretch with half or less left: falling behind (yellow)", () => {
  assert.equal(at(task({ done: 5 }), 8.5).state, "behind");
  assert.equal(at(task({ done: 9 }), 9.5).state, "behind");
});

test("all items ticked before the deadline: ahead", () => {
  assert.equal(at(task({ done: 10 }), 9.9).state, "ahead");
});

test("work trailing the time used by a quarter or more: falling behind", () => {
  assert.equal(at(task({ done: 2 }), 5).state, "behind"); // half the time, a fifth done
  assert.equal(at(task({ done: 3 }), 5).state, "on_track"); // gap 0.2: fine
  assert.match(at(task({ done: 2 }), 5).reason, /^About half its time is gone; 2 of 10 items done; due in 5 days$/);
});

test("too early to fall behind in the first quarter of the time", () => {
  assert.equal(at(task({ done: 0 }), 2).state, "on_track");
  assert.equal(at(task({ done: 0 }), 2.5).state, "behind");
});

test("ahead when work clearly leads the time", () => {
  assert.equal(at(task({ done: 6 }), 5).state, "ahead");
  assert.equal(at(task({ done: 5 }), 5).state, "on_track");
});

test("no checklist: uses reported progress; nothing reported means nothing done", () => {
  const t = task({ items: 0 });
  assert.equal(at(t, 1).state, "on_track");
  assert.equal(at(t, 5).state, "behind");
  assert.match(at(t, 5).reason, /no progress reported/);
  assert.equal(at({ ...t, done: 0.5 }, 5).state, "on_track");
  assert.equal(at({ ...t, done: 0.2 }, 8.5).state, "close");
});

test("the colour moves with the clock alone", () => {
  const t = task({ done: 4 });
  assert.deepEqual([2, 5, 7.5, 8.5, 10.1].map((d) => at(t, d).state), ["ahead", "on_track", "behind", "close", "overdue"]);
});

test("finished: on time dark green, late dark red, never changes", () => {
  const onTime = task({ status: "done", completed_at: iso(T0 + 9 * D) });
  const late = task({ status: "closed", completed_at: iso(T0 + 11 * D) });
  for (const d of [11, 15, 40]) {
    assert.equal(at(onTime, d).state, "done_on_time");
    assert.equal(at(late, d).state, "done_late");
    assert.equal(at(late, d).band.colour, "Dark red");
  }
  assert.match(at(late, 12).reason, /^Finished 1 day after the deadline$/);
});

test("extension: the new deadline counts", () => {
  assert.equal(at(task({ done: 2 }), 11).state, "overdue");
  assert.equal(at(task({ done: 2, due: iso(T0 + 30 * D) }), 11).state, "on_track");
});

test("not coloured: no deadline, waiting on another task", () => {
  assert.equal(at(task({ due: null }), 50).band, null);
  assert.equal(at(task({ blocked: true }), 50).band, null);
  assert.equal(at(task({ blocked: true }), 50).label, "Waiting");
});

test("stale after 30 days overdue, still overdue", () => {
  const h = at(task(), 41);
  assert.equal(h.state, "overdue");
  assert.equal(h.stale, true);
  assert.equal(at(task(), 39).stale, false);
});

test("person: worst open task wins, never an average", () => {
  const now = T0 + 9 * D;
  const tasks = [
    task({ id: "late", title: "Report", due: iso(T0 + 2 * D) }),
    ...Array.from({ length: 8 }, (_, i) => task({ id: "ok" + i, done: 10 })),
    task({ id: "d", status: "done", completed_at: iso(T0 + 8 * D) }),
  ];
  const p = scorePerson(tasks, now);
  assert.equal(p.band.colour, "Dark red");
  assert.equal(p.label, "Overdue work");
  assert.equal(p.main, 'Overdue: "Report"');
  assert.equal(p.summary, "1 overdue · 8 ahead · 1 done on time this week");
});

test("person: order of colours", () => {
  const now = T0 + 8.5 * D;
  const close = task({ id: "c", title: "C", done: 1 });
  const behind = task({ id: "b", title: "B", done: 6 });
  const fine = task({ id: "f", due: iso(T0 + 40 * D) });
  assert.equal(scorePerson([close, behind, fine], now).label, "Deadline close!");
  assert.equal(scorePerson([behind, fine], now).label, "Work pending - still time");
  assert.equal(scorePerson([fine], now).label, "On track");
});

test("person: nothing open", () => {
  const now = T0 + 10 * D;
  assert.equal(scorePerson([], now).band, null);
  assert.equal(scorePerson([], now).summary, "Nothing assigned");
  const good = task({ status: "done", completed_at: iso(T0 + 9 * D) });
  assert.equal(scorePerson([good], now).band.colour, "Dark green");
  const lateDone = task({ status: "done", completed_at: iso(T0 + 11 * D) });
  assert.equal(scorePerson([lateDone], T0 + 12 * D).band.colour, "Light green");
  assert.equal(scorePerson([good], T0 + 30 * D).band, null); // a week later: nothing recent
});

test("person: lists a few tasks then +N more", () => {
  const ts = ["A", "B", "C", "D"].map((t) => task({ id: t, title: t, due: iso(T0) }));
  assert.equal(scorePerson(ts, T0 + D).main, 'Overdue: "A", "B" +2 more');
});

test("time zones don't matter", () => {
  const a = scoreTask(task({ start: "2026-10-12T09:00:00Z", due: "2026-10-22T09:00:00Z", done: 2 }), Date.parse("2026-10-17T09:00:00Z"));
  const b = scoreTask(task({ start: "2026-10-12T14:30:00+05:30", due: "2026-10-22T14:30:00+05:30", done: 2 }), Date.parse("2026-10-17T14:30:00+05:30"));
  assert.equal(a.state, b.state);
});
