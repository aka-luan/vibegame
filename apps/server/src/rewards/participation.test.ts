import { describe, expect, it } from "vitest";

import {
  ParticipationWindow,
  type ParticipationCandidate,
} from "./participation.js";

const candidate = (
  overrides: Partial<ParticipationCandidate> = {},
): ParticipationCandidate => ({
  characterId: "character:one",
  partyId: undefined,
  x: 100,
  y: 100,
  connected: true,
  joinedAtMs: 0,
  lastActivityAtMs: 900,
  ...overrides,
});

describe("participation windows", () => {
  it("credits active solo and nearby non-party participants", () => {
    const window = new ParticipationWindow({
      proximityRadius: 100,
      afkAfterMs: 250,
    });
    window.recordActivity({ characterId: "character:one", atMs: 100 });
    window.recordActivity({ characterId: "character:two", atMs: 900 });

    expect(
      window.eligibleCharacters({
        defeatedAtMs: 1_000,
        monsterPosition: { x: 100, y: 100 },
        candidates: [
          candidate(),
          candidate({ characterId: "character:two", x: 150 }),
        ],
      }),
    ).toEqual(["character:one", "character:two"]);
  });

  it("excludes distant, disconnected, spectator, late, and AFK characters", () => {
    const window = new ParticipationWindow({
      proximityRadius: 100,
      afkAfterMs: 250,
    });
    window.recordActivity({ characterId: "character:one", atMs: 900 });
    window.close(1_000);

    expect(
      window.eligibleCharacters({
        defeatedAtMs: 1_000,
        monsterPosition: { x: 100, y: 100 },
        candidates: [
          candidate(),
          candidate({ characterId: "character:distant", x: 250 }),
          candidate({
            characterId: "character:disconnected",
            connected: false,
          }),
          candidate({
            characterId: "character:spectator",
            lastActivityAtMs: 1_000,
          }),
          candidate({ characterId: "character:afk", lastActivityAtMs: 600 }),
          candidate({
            characterId: "character:late",
            joinedAtMs: 1_001,
            lastActivityAtMs: 1_000,
          }),
        ],
      }),
    ).toEqual(["character:one"]);
  });

  it("allows an active nearby party member to share a party participant's window", () => {
    const window = new ParticipationWindow({
      proximityRadius: 100,
      afkAfterMs: 250,
    });
    window.recordActivity({
      characterId: "character:one",
      partyId: "party:green",
      atMs: 900,
    });

    expect(
      window.eligibleCharacters({
        defeatedAtMs: 1_000,
        monsterPosition: { x: 100, y: 100 },
        candidates: [
          candidate({ characterId: "character:one", partyId: "party:green" }),
          candidate({
            characterId: "character:two",
            partyId: "party:green",
            x: 150,
            lastActivityAtMs: 950,
          }),
          candidate({
            characterId: "character:three",
            partyId: "party:blue",
            x: 150,
          }),
        ],
      }),
    ).toEqual(["character:one", "character:two"]);
  });

  it("rejects activity after the window closes", () => {
    const window = new ParticipationWindow({
      proximityRadius: 100,
      afkAfterMs: 250,
    });
    window.recordActivity({ characterId: "character:one", atMs: 900 });
    window.close(1_000);

    expect(
      window.recordActivity({ characterId: "character:two", atMs: 1_001 }),
    ).toBe(false);
  });
});
