import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  AccountCharacter as DatabaseCharacter,
  CharacterCreationInput,
  GuestSessionRecord,
} from "@gameish/database";

import { createHttpApp } from "../http/app.js";
import {
  GUEST_SESSION_ROTATION_MS,
  GuestAccountService,
  readGuestCookie,
} from "./guest-account.js";
import type { AccountRepository } from "./guest-account.js";

class MemoryAccountRepository implements AccountRepository {
  readonly sessions = new Map<string, GuestSessionRecord>();
  readonly characters = new Map<
    string,
    DatabaseCharacter & { userId: string; requestId: string }
  >();
  readonly tickets = new Set<string>();

  createGuestSession(input: {
    id: string;
    userId: string;
    secretHash: string;
    now: Date;
    expiresAt: Date;
    rotatedAt: Date;
  }): Promise<void> {
    this.sessions.set(input.secretHash, {
      id: input.id,
      userId: input.userId,
      secretHash: input.secretHash,
      lastSeenAt: input.now,
      expiresAt: input.expiresAt,
      rotatedAt: input.rotatedAt,
      selectedCharacterId: null,
    });
    return Promise.resolve();
  }

  findSession(
    secretHash: string,
    now: Date,
  ): Promise<GuestSessionRecord | undefined> {
    const session = this.sessions.get(secretHash);
    return Promise.resolve(
      session && session.expiresAt > now ? { ...session } : undefined,
    );
  }

  touchSession(id: string, now: Date): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.id === id) session.lastSeenAt = now;
    }
    return Promise.resolve();
  }

  revokeSession(id: string, now: Date): Promise<boolean> {
    void now;
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.id === id,
    );
    if (!session) return Promise.resolve(false);
    this.sessions.delete(session.secretHash);
    return Promise.resolve(true);
  }

  rotateSession(input: {
    oldId: string;
    oldSecretHash: string;
    replacement: {
      id: string;
      userId: string;
      secretHash: string;
      now: Date;
      expiresAt: Date;
      rotatedAt: Date;
    };
  }): Promise<boolean> {
    const old = this.sessions.get(input.oldSecretHash);
    if (!old || old.id !== input.oldId) return Promise.resolve(false);
    this.sessions.delete(input.oldSecretHash);
    this.sessions.set(input.replacement.secretHash, {
      id: input.replacement.id,
      userId: input.replacement.userId,
      secretHash: input.replacement.secretHash,
      lastSeenAt: input.replacement.now,
      expiresAt: input.replacement.expiresAt,
      rotatedAt: input.replacement.rotatedAt,
      selectedCharacterId: old.selectedCharacterId,
    });
    return Promise.resolve(true);
  }

  listCharacters(userId: string): Promise<DatabaseCharacter[]> {
    const characters = [...this.characters.values()]
      .filter((character) => character.userId === userId)
      .map((character) => {
        const {
          userId: ignoredUserId,
          requestId: ignoredRequestId,
          ...publicCharacter
        } = character;
        void ignoredUserId;
        void ignoredRequestId;
        return publicCharacter;
      });
    return Promise.resolve(characters);
  }

  createCharacter(input: CharacterCreationInput): Promise<DatabaseCharacter> {
    const replay = [...this.characters.values()].find(
      (character) =>
        character.userId === input.userId &&
        character.requestId === input.creationRequestId,
    );
    if (replay) {
      const {
        userId: ignoredUserId,
        requestId: ignoredRequestId,
        ...character
      } = replay;
      void ignoredUserId;
      void ignoredRequestId;
      return Promise.resolve(character);
    }
    const character: DatabaseCharacter & { userId: string; requestId: string } =
      {
        id: input.id,
        userId: input.userId,
        requestId: input.creationRequestId,
        name: input.name,
        revision: 0,
        appearance: {
          rigId: input.rigId,
          baseLayerId: input.baseLayerId,
          armorLayerId: input.armorLayerId,
        },
        logicalMapId: input.logicalMapId,
        entranceId: input.entranceId,
      };
    this.characters.set(character.id, character);
    return Promise.resolve(character);
  }

  selectCharacter(
    sessionId: string,
    userId: string,
    characterId: string,
    now: Date,
  ): Promise<boolean> {
    void now;
    const character = this.characters.get(characterId);
    if (!character || character.userId !== userId)
      return Promise.resolve(false);
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) return Promise.resolve(false);
    session.selectedCharacterId = characterId;
    return Promise.resolve(true);
  }

  issuePlayTicket(input: {
    tokenHash: string;
    userId: string;
    characterId: string;
    logicalDestination: string;
    entranceId: string;
    contentVersion: string;
    nonce: string;
    now: Date;
    expiresAt: Date;
  }): Promise<boolean> {
    const character = this.characters.get(input.characterId);
    if (!character || character.userId !== input.userId)
      return Promise.resolve(false);
    this.tickets.add(input.tokenHash);
    return Promise.resolve(true);
  }
}

const openApps: Array<ReturnType<typeof createHttpApp>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("guest account lifecycle", () => {
  it("creates a secure browser session and restores it without exposing the secret", async () => {
    let now = Date.parse("2026-07-18T12:00:00.000Z");
    const repository = new MemoryAccountRepository();
    const service = new GuestAccountService(repository, { now: () => now });

    const created = await service.ensureSession(undefined);
    expect(created.setCookie).toMatch(
      /^gameish_guest=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax;/,
    );
    const cookie = created.setCookie?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    const restored = await service.ensureSession(cookie);
    expect(restored.session.userId).toBe(created.session.userId);
    expect(restored.setCookie).toBeUndefined();
    expect(readGuestCookie(created.setCookie)).toBeTruthy();

    now += GUEST_SESSION_ROTATION_MS + 1;
    const rotated = await service.ensureSession(cookie);
    expect(rotated.session.userId).toBe(created.session.userId);
    expect(rotated.setCookie).toBeTruthy();
    expect(readGuestCookie(cookie)).toBeTruthy();

    await expect(service.revokeSession(rotated.setCookie)).resolves.toBe(true);
    const afterRevoke = await service.ensureSession(rotated.setCookie);
    expect(afterRevoke.session.userId).not.toBe(created.session.userId);
  });

  it("rejects a cross-origin account mutation and supports create/select/ticket flow", async () => {
    const repository = new MemoryAccountRepository();
    const service = new GuestAccountService(repository);
    const app = createHttpApp({
      readinessProbe: { check: () => Promise.resolve() },
      accountService: service,
      allowedOrigin: "http://localhost",
      logger: false,
    });
    openApps.push(app);

    const invalidOrigin = await app.inject({
      method: "POST",
      url: "/api/guest/session",
      headers: { origin: "https://attacker.example" },
      payload: {},
    });
    expect(invalidOrigin.statusCode).toBe(403);
    expect(invalidOrigin.json()).toEqual({ code: "INVALID_ORIGIN" });

    const session = await app.inject({
      method: "POST",
      url: "/api/guest/session",
      headers: { origin: "http://localhost" },
      payload: {},
    });
    expect(session.statusCode).toBe(200);
    const rawSetCookie = session.headers["set-cookie"];
    const setCookie = Array.isArray(rawSetCookie)
      ? rawSetCookie[0]
      : rawSetCookie;
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie!.split(";", 1)[0]!;
    expect(readGuestCookie(cookie)).toBe(cookie.split("=", 2)[1]);

    const created = await app.inject({
      method: "POST",
      url: "/api/characters",
      headers: { cookie, origin: "http://localhost" },
      payload: { name: "Aster", requestId: "create-1" },
    });
    expect(created.statusCode).toBe(201);
    const characterId = z
      .object({ character: z.object({ id: z.string() }) })
      .parse(JSON.parse(created.body) as unknown).character.id;

    const selected = await app.inject({
      method: "POST",
      url: `/api/characters/${characterId}/select`,
      headers: { cookie, origin: "http://localhost" },
    });
    expect(selected.statusCode).toBe(200);

    const ticket = await app.inject({
      method: "POST",
      url: "/api/play-ticket",
      headers: { cookie, origin: "http://localhost" },
      payload: { characterId },
    });
    expect(ticket.statusCode).toBe(201);
    const ticketBody = z
      .object({ ticket: z.string(), expiresAt: z.number() })
      .parse(JSON.parse(ticket.body) as unknown);
    expect(ticketBody.ticket).toEqual(expect.any(String));
    expect(ticketBody.expiresAt).toEqual(expect.any(Number));
  });
});
