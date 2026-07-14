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
  #previous: TimedPoint | undefined;
  #latest: TimedPoint | undefined;

  push(position: Point, serverTimeMs: number): void {
    if (this.#latest && serverTimeMs <= this.#latest.serverTimeMs) return;
    this.#previous = this.#latest;
    this.#latest = { ...position, serverTimeMs };
  }

  sample(serverTimeMs: number): Point | undefined {
    if (!this.#latest) return undefined;
    if (!this.#previous || serverTimeMs >= this.#latest.serverTimeMs) {
      return { x: this.#latest.x, y: this.#latest.y };
    }
    if (serverTimeMs <= this.#previous.serverTimeMs) {
      return { x: this.#previous.x, y: this.#previous.y };
    }
    const progress =
      (serverTimeMs - this.#previous.serverTimeMs) /
      (this.#latest.serverTimeMs - this.#previous.serverTimeMs);
    return {
      x: this.#previous.x + (this.#latest.x - this.#previous.x) * progress,
      y: this.#previous.y + (this.#latest.y - this.#previous.y) * progress,
    };
  }
}
