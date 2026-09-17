/** Persistent lane state, independent of whichever contact it last served. */
export interface RequestLane {
  id: number;
  readyAt: number;
  failures: number;
  jobId: string | null;
}

/** One contact's next turn; only one turn per contact can be queued. */
export interface LaneJob {
  id: string;
  turn: number;
  readyAt: number;
}

/** Durable metadata only; no prompts, credentials or model output. */
export interface LaneSnapshot {
  version: 1;
  lanes: RequestLane[];
  jobs: LaneJob[];
}

/** A reservation binds one ready job to one ready lane until completion. */
export interface LaneAssignment {
  lane: RequestLane;
  job: LaneJob;
}

/** Parses either Retry-After format without shortening an upstream delay. */
export function retryAfterMilliseconds(
  value: string | null,
  now: number,
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? Math.max(0, instant - now) : undefined;
}

/** Provides jittered backoff only when no upstream timing survived translation. */
export function fallbackDelay(
  status: number,
  failures: number,
  random = Math.random(),
): number {
  const base = status === 429 ? 10_000 : 3_000;
  return (
    Math.min(120_000, base * 2 ** Math.min(6, Math.max(0, failures - 1))) *
    (1 + random)
  );
}

/**
 * Pattern: State with an event-driven delay queue.
 * Lanes retain cooldowns across contact reassignment. Jobs also retain their
 * retry deadline so another lane cannot send the same job before Retry-After.
 * Snapshots enable at-least-once recovery, not exactly-once remote execution.
 */
export class RequestLanes {
  readonly lanes: RequestLane[];
  readonly jobs: LaneJob[];

  constructor(count: number, jobs: LaneJob[], saved?: LaneSnapshot) {
    if (!Number.isInteger(count) || count < 1 || count > 500)
      throw new Error("Lane count must be between 1 and 500.");
    if (new Set(jobs.map((job) => job.id)).size !== jobs.length)
      throw new Error("Duplicate contact job.");
    if (saved && (saved.version !== 1 || saved.lanes.length !== count))
      throw new Error("Checkpoint does not match lane count.");
    this.jobs = structuredClone(saved?.jobs ?? jobs);
    this.lanes = saved
      ? structuredClone(saved.lanes)
      : Array.from({ length: count }, (_, id) => ({
          id,
          readyAt: 0,
          failures: 0,
          jobId: null,
        }));
    // An interrupted request has unknown remote status and is eligible for retry.
    for (const lane of this.lanes) lane.jobId = null;
  }

  /** Reserves ready work without creating batches or a global launch pause. */
  take(now: number): LaneAssignment | undefined {
    const lane = this.lanes.find(
      (candidate) => candidate.jobId === null && candidate.readyAt <= now,
    );
    if (!lane) return undefined;
    const busy = new Set(this.lanes.map((candidate) => candidate.jobId));
    const job = this.jobs.find(
      (candidate) => candidate.readyAt <= now && !busy.has(candidate.id),
    );
    if (!job) return undefined;
    lane.jobId = job.id;
    return { lane, job };
  }

  /** Releases a successful lane and delays only this contact's next turn. */
  succeed(
    assignment: LaneAssignment,
    now: number,
    searchDelay: number,
    turns: number,
  ): void {
    this.assertActive(assignment);
    assignment.lane.jobId = null;
    assignment.lane.failures = 0;
    assignment.lane.readyAt = now;
    this.jobs.splice(this.jobs.indexOf(assignment.job), 1);
    if (assignment.job.turn + 1 < turns)
      this.jobs.push({
        ...assignment.job,
        turn: assignment.job.turn + 1,
        readyAt: now + searchDelay,
      });
  }

  /** Retains failed work while cooling just its lane, not the whole scheduler. */
  retry(assignment: LaneAssignment, now: number, delay: number): void {
    this.assertActive(assignment);
    if (!Number.isFinite(delay) || delay < 0)
      throw new Error("Invalid retry delay.");
    assignment.lane.jobId = null;
    assignment.lane.failures += 1;
    assignment.lane.readyAt = now + Math.max(1000, delay);
    assignment.job.readyAt = assignment.lane.readyAt;
  }

  /** Removes a nonretryable job without leaving its lane permanently occupied. */
  fail(assignment: LaneAssignment): void {
    this.assertActive(assignment);
    assignment.lane.jobId = null;
    this.jobs.splice(this.jobs.indexOf(assignment.job), 1);
  }

  /** Copies metadata so atomic checkpoint writes cannot mutate live state. */
  snapshot(): LaneSnapshot {
    return structuredClone({
      version: 1 as const,
      lanes: this.lanes,
      jobs: this.jobs,
    });
  }

  /** Rejects duplicate or stale completion callbacks before they corrupt jobs. */
  private assertActive(assignment: LaneAssignment): void {
    if (
      this.lanes[assignment.lane.id] !== assignment.lane ||
      assignment.lane.jobId !== assignment.job.id ||
      !this.jobs.includes(assignment.job)
    )
      throw new Error("Assignment is no longer active.");
  }
}
