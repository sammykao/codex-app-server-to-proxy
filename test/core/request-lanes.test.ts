import assert from "node:assert/strict";
import { test } from "vitest";
import {
  RequestLanes,
  retryAfterMilliseconds,
  fallbackDelay,
} from "../../src/core/request-lanes.js";

/** Builds contact jobs without real personal data. */
function jobs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `contact-${i}`,
    turn: 0,
    readyAt: 0,
  }));
}

test("500 lanes accept 500 distinct contacts without batches", () => {
  const queue = new RequestLanes(500, jobs(2000));
  const assignments = Array.from({ length: 500 }, () => queue.take(0)!);
  assert.equal(new Set(assignments.map((value) => value.job.id)).size, 500);
  assert.equal(queue.take(0), undefined);
  queue.succeed(assignments[0]!, 1, 5000, 10);
  assert.equal(queue.take(1)?.job.id, "contact-500");
});

test("lane cooldown survives reassignment and does not pause healthy lanes", () => {
  const queue = new RequestLanes(2, jobs(3));
  const first = queue.take(0)!;
  queue.retry(first, 0, 30_000);
  const second = queue.take(1)!;
  assert.equal(second.lane.id, 1);
  assert.equal(second.job.id, "contact-1");
  queue.succeed(second, 2, 5000, 1);
  assert.equal(queue.take(2)?.job.id, "contact-2");
  assert.equal(queue.take(29_999), undefined);
  assert.equal(queue.take(30_000)?.job.id, "contact-0");
});

test("search delay only affects contact and snapshots recover interrupted jobs", () => {
  const queue = new RequestLanes(1, jobs(2));
  const first = queue.take(0)!;
  queue.succeed(first, 1, 15_000, 10);
  assert.equal(queue.take(1)?.job.id, "contact-1");
  const restored = new RequestLanes(1, [], queue.snapshot());
  assert.equal(restored.take(2)?.job.id, "contact-1");
  assert.throws(() => new RequestLanes(2, [], queue.snapshot()));
});

test("Retry-After seconds and dates are honored without a maximum cap", () => {
  assert.equal(retryAfterMilliseconds("900", 0), 900_000);
  assert.equal(
    retryAfterMilliseconds("Thu, 01 Jan 1970 00:10:00 GMT", 0),
    600_000,
  );
  assert.equal(retryAfterMilliseconds("garbage", 0), undefined);
  assert.equal(retryAfterMilliseconds(null, 0), undefined);
  assert.equal(retryAfterMilliseconds("0", 0), 0);
  assert.ok(fallbackDelay(429, 4, 0) > fallbackDelay(503, 1, 0));
});

test("restored checkpoints preserve absolute lane cooldown deadlines", () => {
  const queue = new RequestLanes(1, jobs(2));
  queue.retry(queue.take(0)!, 0, 900000);
  const restored = new RequestLanes(1, [], queue.snapshot());
  assert.equal(restored.take(899999), undefined);
  assert.equal(restored.take(900000)?.lane.id, 0);
});

test("nonretryable jobs release lanes and invalid input is rejected", () => {
  assert.throws(() => new RequestLanes(0, []));
  assert.throws(() => new RequestLanes(501, []));
  assert.throws(() => new RequestLanes(1, [jobs(1)[0]!, jobs(1)[0]!]));
  const queue = new RequestLanes(1, jobs(1));
  const assignment = queue.take(0)!;
  assert.throws(() => queue.retry(assignment, 0, -1));
  queue.fail(assignment);
  assert.equal(queue.jobs.length, 0);
  assert.throws(() => queue.fail(assignment));
  assert.throws(() => queue.succeed(assignment, 0, 0, 1));
  assert.throws(() => queue.retry(assignment, 0, 1000));
});
