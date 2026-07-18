export interface ParticipationCandidate {
  characterId: string;
  partyId: string | undefined;
  x: number;
  y: number;
  connected: boolean;
  joinedAtMs: number;
  lastActivityAtMs: number;
}

interface ParticipationRecord {
  partyId: string | undefined;
}

export class ParticipationWindow {
  readonly #proximityRadius: number;
  readonly #afkAfterMs: number;
  readonly #records = new Map<string, ParticipationRecord>();
  #closedAtMs: number | undefined;

  constructor(options: { proximityRadius: number; afkAfterMs: number }) {
    this.#proximityRadius = options.proximityRadius;
    this.#afkAfterMs = options.afkAfterMs;
  }

  recordActivity(input: {
    characterId: string;
    partyId?: string | undefined;
    atMs: number;
  }): boolean {
    if (this.#closedAtMs !== undefined || !Number.isFinite(input.atMs)) {
      return false;
    }
    const existing = this.#records.get(input.characterId);
    if (existing) {
      if (existing.partyId === undefined && input.partyId !== undefined) {
        existing.partyId = input.partyId;
      }
      return true;
    }
    this.#records.set(input.characterId, {
      partyId: input.partyId,
    });
    return true;
  }

  close(atMs: number): void {
    if (this.#closedAtMs === undefined) this.#closedAtMs = atMs;
  }

  eligibleCharacters(input: {
    defeatedAtMs: number;
    monsterPosition: { x: number; y: number };
    candidates: readonly ParticipationCandidate[];
  }): string[] {
    const closedAtMs = this.#closedAtMs ?? input.defeatedAtMs;
    const partyIds = new Set(
      [...this.#records.values()]
        .map((record) => record.partyId)
        .filter((partyId): partyId is string => partyId !== undefined),
    );
    return input.candidates
      .filter((candidate) => {
        const record = this.#records.get(candidate.characterId);
        const sharesPartyWindow =
          record === undefined &&
          candidate.partyId !== undefined &&
          partyIds.has(candidate.partyId);
        if (!record && !sharesPartyWindow) return false;
        if (!candidate.connected || candidate.joinedAtMs > closedAtMs) {
          return false;
        }
        if (
          input.defeatedAtMs - candidate.lastActivityAtMs >
          this.#afkAfterMs
        ) {
          return false;
        }
        return (
          Math.hypot(
            candidate.x - input.monsterPosition.x,
            candidate.y - input.monsterPosition.y,
          ) <= this.#proximityRadius
        );
      })
      .map((candidate) => candidate.characterId)
      .sort();
  }
}
