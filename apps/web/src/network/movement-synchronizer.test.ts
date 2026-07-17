import type { MovementIntention } from "@gameish/protocol";
import { describe, expect, it } from "vitest";

import {
  MovementSynchronizer,
  RemoteInterpolator,
  ServerTimeEstimator,
} from "./movement-synchronizer.js";

const integrate = (
  position: { x: number; y: number },
  direction: { x: number; y: number },
  elapsedMs: number,
) => ({
  x: position.x + direction.x * (elapsedMs / 10),
  y: position.y + direction.y * (elapsedMs / 10),
});

describe("movement synchronization", () => {
  it("sequences fixed-step inputs and replays unacknowledged movement after a correction", () => {
    const movement = new MovementSynchronizer({
      initialPosition: { x: 10, y: 20 },
      fixedStepMs: 50,
      correctionTolerance: 0.25,
      integrate,
    });

    expect(movement.advance({ x: 1, y: 0 }, 120)).toEqual([
      { x: 1, y: 0, sequence: 1 },
      { x: 1, y: 0, sequence: 2 },
    ]);
    expect(movement.position).toEqual({ x: 20, y: 20 });

    expect(
      movement.reconcile({ x: 14, y: 20, lastProcessedSequence: 1 }),
    ).toEqual({ corrected: true, error: 1 });
    expect(movement.position).toEqual({ x: 19, y: 20 });

    expect(movement.advance({ x: 0, y: 1 }, 30)).toEqual([
      { x: 0, y: 1, sequence: 3 },
    ]);
    expect(movement.position).toEqual({ x: 19, y: 25 });
  });

  it("ignores duplicate and out-of-order authoritative acknowledgements", () => {
    const movement = new MovementSynchronizer({
      initialPosition: { x: 0, y: 0 },
      fixedStepMs: 50,
      correctionTolerance: 0.25,
      integrate,
    });
    movement.advance({ x: 1, y: 0 }, 150);

    movement.reconcile({ x: 15, y: 0, lastProcessedSequence: 3 });
    expect(movement.position).toEqual({ x: 15, y: 0 });

    expect(
      movement.reconcile({ x: 5, y: 0, lastProcessedSequence: 1 }),
    ).toEqual({ corrected: false, error: 0 });
    expect(movement.position).toEqual({ x: 15, y: 0 });
  });

  it("estimates server time and interpolates remote movement without drift", () => {
    const clock = new ServerTimeEstimator();
    clock.observe(0, 700);
    clock.observe(1_000, 800);
    expect(clock.serverTimeAt(900)).toBe(1_100);

    const remote = new RemoteInterpolator();
    remote.push({ x: 0, y: 10 }, 1_000);
    remote.push({ x: 20, y: 30 }, 1_200);
    remote.push({ x: -100, y: -100 }, 1_100);

    expect(remote.sample(1_100)).toEqual({ x: 10, y: 20 });
    expect(remote.sample(1_500)).toEqual({ x: 20, y: 30 });
  });

  it("keeps enough remote history to interpolate at a buffered render time", () => {
    const remote = new RemoteInterpolator();
    remote.push({ x: 0, y: 0 }, 1_000);
    remote.push({ x: 10, y: 0 }, 1_100);
    remote.push({ x: 20, y: 0 }, 1_200);
    remote.push({ x: 30, y: 0 }, 1_300);

    expect(remote.sample(1_150)).toEqual({ x: 15, y: 0 });
  });

  it("stays convergent for ten simulated minutes at 200 ms round-trip latency", () => {
    const fixedStepMs = 50;
    const prediction = new MovementSynchronizer({
      initialPosition: { x: 0, y: 0 },
      fixedStepMs,
      correctionTolerance: 0.25,
      integrate,
    });
    const outbound = new Map<number, MovementIntention[]>();
    const inbound = new Map<
      number,
      Array<{ x: number; y: number; lastProcessedSequence: number }>
    >();
    const serverPending = new Map<number, MovementIntention>();
    let authoritative = { x: 0, y: 0 };
    let lastProcessedSequence = 0;
    let maximumError = 0;
    const movementSteps = (10 * 60 * 1_000) / fixedStepMs;

    for (let step = 0; step < movementSteps + 4; step += 1) {
      if (step < movementSteps) {
        const direction = Math.floor(step / 80) % 2 === 0 ? 1 : -1;
        const intentions = prediction.advance(
          { x: direction, y: 0 },
          fixedStepMs,
        );
        outbound.set(step + 2, intentions);
      }
      for (const intention of outbound.get(step) ?? []) {
        serverPending.set(intention.sequence, intention);
      }
      const next = serverPending.get(lastProcessedSequence + 1);
      if (next) {
        serverPending.delete(next.sequence);
        authoritative = integrate(authoritative, next, fixedStepMs);
        lastProcessedSequence = next.sequence;
        inbound.set(step + 2, [{ ...authoritative, lastProcessedSequence }]);
      }
      for (const snapshot of inbound.get(step) ?? []) {
        maximumError = Math.max(
          maximumError,
          prediction.reconcile(snapshot).error,
        );
      }
    }

    expect(lastProcessedSequence).toBe(movementSteps);
    expect(prediction.position).toEqual(authoritative);
    expect(maximumError).toBeLessThanOrEqual(0.25);
  });
});
