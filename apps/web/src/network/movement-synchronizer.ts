import type { MovementIntention } from "@gameish/protocol";

interface Point {
  x: number;
  y: number;
}

interface MovementSynchronizerOptions {
  initialPosition: Point;
  fixedStepMs: number;
  correctionTolerance: number;
  integrate: (position: Point, direction: Point, elapsedMs: number) => Point;
}

interface AuthoritativeMovement {
  x: number;
  y: number;
  lastProcessedSequence: number;
}

export class MovementSynchronizer {
  readonly #fixedStepMs: number;
  readonly #correctionTolerance: number;
  readonly #integrate: MovementSynchronizerOptions["integrate"];
  readonly #pending = new Map<number, MovementIntention>();
  #position: Point;
  #accumulatedMs = 0;
  #lastProcessedSequence = -1;
  #nextSequence = 1;

  constructor(options: MovementSynchronizerOptions) {
    this.#position = { ...options.initialPosition };
    this.#fixedStepMs = options.fixedStepMs;
    this.#correctionTolerance = options.correctionTolerance;
    this.#integrate = options.integrate;
  }

  get position(): Point {
    return { ...this.#position };
  }

  advance(direction: Point, elapsedMs: number): MovementIntention[] {
    this.#accumulatedMs += elapsedMs;
    const intentions: MovementIntention[] = [];
    while (this.#accumulatedMs >= this.#fixedStepMs) {
      const intention = {
        x: direction.x,
        y: direction.y,
        sequence: this.#nextSequence++,
      };
      this.#pending.set(intention.sequence, intention);
      this.#position = this.#integrate(
        this.#position,
        intention,
        this.#fixedStepMs,
      );
      intentions.push(intention);
      this.#accumulatedMs -= this.#fixedStepMs;
    }
    return intentions;
  }

  reconcile(authoritative: AuthoritativeMovement): {
    corrected: boolean;
    error: number;
  } {
    if (authoritative.lastProcessedSequence <= this.#lastProcessedSequence) {
      return { corrected: false, error: 0 };
    }
    this.#lastProcessedSequence = authoritative.lastProcessedSequence;
    for (const sequence of this.#pending.keys()) {
      if (sequence <= authoritative.lastProcessedSequence) {
        this.#pending.delete(sequence);
      }
    }
    let replayed = { x: authoritative.x, y: authoritative.y };
    for (const intention of this.#pending.values()) {
      replayed = this.#integrate(replayed, intention, this.#fixedStepMs);
    }
    const error = Math.hypot(
      replayed.x - this.#position.x,
      replayed.y - this.#position.y,
    );
    const corrected = error > this.#correctionTolerance;
    if (corrected) this.#position = replayed;
    return { corrected, error };
  }
}

export class ServerTimeEstimator {
  #offsetMs: number | undefined;

  get offsetMs(): number {
    return this.#offsetMs ?? 0;
  }

  observe(serverTimeMs: number, receivedAtMs: number): void {
    if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return;
    const sample = serverTimeMs - receivedAtMs;
    this.#offsetMs =
      this.#offsetMs === undefined
        ? sample
        : this.#offsetMs * 0.9 + sample * 0.1;
  }

  serverTimeAt(clientTimeMs: number): number {
    return clientTimeMs + this.offsetMs;
  }
}

interface TimedPoint extends Point {
  serverTimeMs: number;
}

export class RemoteInterpolator {
  readonly #history: TimedPoint[] = [];

  push(position: Point, serverTimeMs: number): void {
    const latest = this.#history.at(-1);
    if (latest && serverTimeMs <= latest.serverTimeMs) return;
    this.#history.push({ ...position, serverTimeMs });
    if (this.#history.length > 20) this.#history.shift();
  }

  sample(serverTimeMs: number): Point | undefined {
    const first = this.#history[0];
    const latest = this.#history.at(-1);
    if (!first || !latest) return undefined;
    if (serverTimeMs <= first.serverTimeMs) return { x: first.x, y: first.y };
    if (serverTimeMs >= latest.serverTimeMs)
      return { x: latest.x, y: latest.y };
    const latestIndex = this.#history.findIndex(
      (point) => point.serverTimeMs >= serverTimeMs,
    );
    const previous = this.#history[latestIndex - 1];
    const next = this.#history[latestIndex];
    if (!previous || !next) return { x: latest.x, y: latest.y };
    const progress =
      (serverTimeMs - previous.serverTimeMs) /
      (next.serverTimeMs - previous.serverTimeMs);
    return {
      x: previous.x + (next.x - previous.x) * progress,
      y: previous.y + (next.y - previous.y) * progress,
    };
  }
}
