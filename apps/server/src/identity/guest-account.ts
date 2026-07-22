import { randomBytes, randomUUID } from "node:crypto";

import { forestSlice } from "@gameish/content/slices/forest";
import { villageSlice } from "@gameish/content/slices/village";
import type {
  AccountCharacter,
  CharacterCreationInput,
  GuestSessionRecord,
} from "@gameish/database";

import { hashSecret } from "./play-tickets.js";

export const GUEST_COOKIE_NAME = "gameish_guest";
export const GUEST_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const GUEST_SESSION_ROTATION_MS = 24 * 60 * 60 * 1_000;
export const PLAY_TICKET_TTL_MS = 15_000;

export interface AccountRepository {
  createGuestSession(input: {
    id: string;
    userId: string;
    secretHash: string;
    now: Date;
    expiresAt: Date;
    rotatedAt: Date;
  }): Promise<void>;
  findSession(
    secretHash: string,
    now: Date,
  ): Promise<GuestSessionRecord | undefined>;
  touchSession(id: string, now: Date): Promise<void>;
  revokeSession(id: string, now: Date): Promise<boolean>;
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
      selectedCharacterId?: string | null;
    };
  }): Promise<boolean>;
  listCharacters(userId: string): Promise<AccountCharacter[]>;
  createCharacter(input: CharacterCreationInput): Promise<AccountCharacter>;
  selectCharacter(
    sessionId: string,
    userId: string,
    characterId: string,
    now: Date,
  ): Promise<boolean>;
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
  }): Promise<boolean>;
}

export interface AccountCharacterInput {
  name: string;
  requestId: string;
}

export interface AccountSession {
  id: string;
  userId: string;
  selectedCharacterId: string | null;
}

export interface SessionContext {
  session: AccountSession;
  setCookie?: string | undefined;
}

export interface AccountServiceOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

const CONTENT_VERSION_BY_MAP_ID: Readonly<Record<string, string>> = {
  [villageSlice.mapId]: villageSlice.contentVersion,
  [forestSlice.mapId]: forestSlice.contentVersion,
};

function contentVersionForMap(mapId: string): string | undefined {
  return CONTENT_VERSION_BY_MAP_ID[mapId];
}

function makeCookie(secret: string): string {
  return `${GUEST_COOKIE_NAME}=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(Math.floor(GUEST_SESSION_TTL_MS / 1_000))}`;
}

export function readGuestCookie(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name === GUEST_COOKIE_NAME) {
      const value = part.slice(separator + 1).trim();
      return /^[A-Za-z0-9_-]{40,100}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

export function normalizeCharacterName(name: string): string {
  return name
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export class GuestAccountService {
  readonly #repository: AccountRepository;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(
    repository: AccountRepository,
    options: AccountServiceOptions = {},
  ) {
    this.#repository = repository;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  async ensureSession(cookie: string | undefined): Promise<SessionContext> {
    const nowMs = this.#now();
    const now = new Date(nowMs);
    const secret = readGuestCookie(cookie);
    const existing = secret
      ? await this.#repository.findSession(hashSecret(secret), now)
      : undefined;
    if (!existing) return this.#createSession(nowMs);

    if (nowMs - existing.rotatedAt.getTime() >= GUEST_SESSION_ROTATION_MS) {
      const replacement = this.#newSession(existing.userId, nowMs);
      const rotated = await this.#repository.rotateSession({
        oldId: existing.id,
        oldSecretHash: existing.secretHash,
        replacement: {
          id: replacement.id,
          userId: existing.userId,
          secretHash: replacement.secretHash,
          now,
          expiresAt: replacement.expiresAt,
          rotatedAt: now,
          selectedCharacterId: existing.selectedCharacterId,
        },
      });
      if (rotated) {
        return {
          session: {
            id: replacement.id,
            userId: existing.userId,
            selectedCharacterId: existing.selectedCharacterId,
          },
          setCookie: makeCookie(replacement.secret),
        };
      }
    }

    await this.#repository.touchSession(existing.id, now);
    return {
      session: {
        id: existing.id,
        userId: existing.userId,
        selectedCharacterId: existing.selectedCharacterId,
      },
    };
  }

  listCharacters(userId: string): Promise<AccountCharacter[]> {
    return this.#repository.listCharacters(userId);
  }

  async revokeSession(cookie: string | undefined): Promise<boolean> {
    const secret = readGuestCookie(cookie);
    if (!secret) return false;
    const session = await this.#repository.findSession(
      hashSecret(secret),
      new Date(this.#now()),
    );
    if (!session) return false;
    return this.#repository.revokeSession(session.id, new Date(this.#now()));
  }

  async createCharacter(
    userId: string,
    input: AccountCharacterInput,
  ): Promise<AccountCharacter> {
    const combatClass = this.#villageClass();
    const abilityIds = combatClass.serverOnly.abilityIds;
    if (abilityIds.length !== 4)
      throw new Error("Village class loadout is incomplete");
    return this.#repository.createCharacter({
      id: `character:${randomUUID()}`,
      userId,
      name: input.name.trim().replace(/\s+/g, " "),
      normalizedName: normalizeCharacterName(input.name),
      creationRequestId: input.requestId,
      now: new Date(this.#now()),
      contentVersion: villageSlice.contentVersion,
      classId: combatClass.id,
      basicAttackId: combatClass.serverOnly.basicAttackId,
      abilityIds: [
        abilityIds[0]!,
        abilityIds[1]!,
        abilityIds[2]!,
        abilityIds[3]!,
      ],
      starterEquipmentItemId: villageSlice.starterItemId,
      rigId: villageSlice.rigId,
      baseLayerId: "base",
      armorLayerId: "tunic",
      logicalMapId: villageSlice.mapId,
      entranceId: villageSlice.entranceId,
    });
  }

  async selectCharacter(
    session: AccountSession,
    characterId: string,
  ): Promise<boolean> {
    return this.#repository.selectCharacter(
      session.id,
      session.userId,
      characterId,
      new Date(this.#now()),
    );
  }

  /**
   * Issues a play ticket for the character's checkpointed logical location
   * (`AccountCharacter.logicalMapId` / `.entranceId`), not a hardcoded
   * village entrance. This is what lets a client that fails to reach a
   * portal transition's destination ask for a fresh ticket and land back at
   * its last safe checkpoint, wherever that is (AC4).
   */
  async issuePlayTicket(
    session: AccountSession,
    characterId: string | undefined,
  ): Promise<{ ticket: string; expiresAt: number; mapId: string } | undefined> {
    const selectedCharacterId =
      characterId ?? session.selectedCharacterId ?? undefined;
    if (!selectedCharacterId) return undefined;
    const characters = await this.#repository.listCharacters(session.userId);
    const character = characters.find(
      (candidate) => candidate.id === selectedCharacterId,
    );
    if (!character) return undefined;
    // The ticket is bound to the character's checkpointed logical map, so it
    // must carry that map's own content version rather than the village's.
    const contentVersion = contentVersionForMap(character.logicalMapId);
    if (!contentVersion) return undefined;
    const ticket = this.#randomBytes(32).toString("base64url");
    const nowMs = this.#now();
    const expiresAt = nowMs + PLAY_TICKET_TTL_MS;
    const created = await this.#repository.issuePlayTicket({
      tokenHash: hashSecret(ticket),
      userId: session.userId,
      characterId: selectedCharacterId,
      logicalDestination: character.logicalMapId,
      entranceId: character.entranceId,
      contentVersion,
      nonce: randomUUID(),
      now: new Date(nowMs),
      expiresAt: new Date(expiresAt),
    });
    // The caller cannot know which room to join without this: the ticket is
    // bound to wherever the character was last checkpointed, which after a
    // completed transition is the forest, not the village.
    return created
      ? { ticket, expiresAt, mapId: character.logicalMapId }
      : undefined;
  }

  async #createSession(nowMs: number): Promise<SessionContext> {
    const session = this.#newSession(`user:${randomUUID()}`, nowMs);
    const now = new Date(nowMs);
    await this.#repository.createGuestSession({
      id: session.id,
      userId: session.userId,
      secretHash: session.secretHash,
      now,
      expiresAt: session.expiresAt,
      rotatedAt: now,
    });
    return {
      session: {
        id: session.id,
        userId: session.userId,
        selectedCharacterId: null,
      },
      setCookie: makeCookie(session.secret),
    };
  }

  #newSession(userId: string, nowMs: number) {
    const secret = this.#randomBytes(32).toString("base64url");
    return {
      id: `session:${randomUUID()}`,
      userId,
      secret,
      secretHash: hashSecret(secret),
      expiresAt: new Date(nowMs + GUEST_SESSION_TTL_MS),
    };
  }

  #villageClass() {
    // Kept as a lazy import boundary in the module below to keep account
    // tests independent from the generated content artifacts.
    return villageClass;
  }
}

import villageCombat from "@gameish/content/village-combat-server";

const villageClass = villageCombat.classes.find(
  (combatClass) => combatClass.id === villageSlice.classId,
)!;

export function guestCookieForTesting(secret: string): string {
  return makeCookie(secret);
}
