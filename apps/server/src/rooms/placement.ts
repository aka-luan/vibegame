import { LocalDriver, type IRoomCache, type SortOptions } from "@colyseus/core";
import { ERROR_CODES } from "@gameish/protocol";

export const DEFAULT_MAP_INSTANCE_SOFT_POPULATION_TARGET = 25;
export const DEFAULT_MAP_INSTANCE_HARD_CAPACITY = 30;

export interface MapPlacementConfig {
  softPopulationTarget: number;
  hardCapacity: number;
}

export interface MapRoomMetadata {
  logicalMapId: string;
  instanceRole: "public";
  partyReservationId?: string | undefined;
}

export interface MapInstanceCandidate {
  roomId: string;
  clients: number;
  maxClients: number;
  locked: boolean;
  instanceRole: string | undefined;
  logicalMapId: string;
  createdAt: number;
  partyReservationId?: string | undefined;
}

export interface PartyCapacityReservationRequest {
  reservationId: string;
  logicalMapId: string;
  memberIds: readonly string[];
  preferredRoomId?: string | undefined;
  expiresAtMs: number;
}

export type PartyCapacityReservationDecision =
  | {
      accepted: true;
      reservationId: string;
      roomId: string | undefined;
    }
  | { accepted: false; code: typeof ERROR_CODES.instanceUnavailable };

interface PartyCapacityReservation {
  reservationId: string;
  logicalMapId: string;
  pendingMemberIds: Set<string>;
  roomId: string | undefined;
  expiresAtMs: number;
}

export interface InstanceInspection {
  logicalMapId: string;
  roomId: string;
  clients: number;
  hardCapacity: number;
  locked: boolean;
  status: "public" | "locked";
  createdAtMs: number | undefined;
}

function assertPlacementConfig(config: MapPlacementConfig): void {
  if (
    !Number.isInteger(config.softPopulationTarget) ||
    config.softPopulationTarget < 1
  ) {
    throw new Error("Map instance soft population target must be positive");
  }
  if (!Number.isInteger(config.hardCapacity) || config.hardCapacity < 1) {
    throw new Error("Map instance hard capacity must be positive");
  }
  if (config.hardCapacity < config.softPopulationTarget) {
    throw new Error(
      "Map instance hard capacity must be at least the soft population target",
    );
  }
}

function sortCandidates(
  left: MapInstanceCandidate,
  right: MapInstanceCandidate,
): number {
  return left.clients - right.clients || left.createdAt - right.createdAt;
}

/**
 * Selects one existing public instance for a logical map. An exact soft-target
 * population deliberately creates a new instance; an already over-target
 * instance is only selected as overflow when it still has hard capacity.
 */
export function selectMapInstance(
  candidates: readonly MapInstanceCandidate[],
  logicalMapId: string,
  config: MapPlacementConfig,
): string | undefined {
  assertPlacementConfig(config);

  const available = candidates.filter(
    (candidate) =>
      candidate.logicalMapId === logicalMapId &&
      candidate.instanceRole === "public" &&
      !candidate.locked &&
      candidate.clients < candidate.maxClients &&
      candidate.clients < config.hardCapacity &&
      candidate.partyReservationId === undefined,
  );
  const underSoftTarget = available
    .filter((candidate) => candidate.clients < config.softPopulationTarget)
    .sort(sortCandidates);
  const overflow = available
    .filter((candidate) => candidate.clients > config.softPopulationTarget)
    .sort(sortCandidates);

  return (underSoftTarget[0] ?? overflow[0])?.roomId;
}

/**
 * Selects a single public instance that can hold every requested party seat.
 * Existing party reservations are counted as occupied so a later placement
 * race cannot consume capacity already promised to a coordinated travel.
 */
export function selectPartyMapInstance(
  candidates: readonly MapInstanceCandidate[],
  logicalMapId: string,
  requiredSeats: number,
  config: MapPlacementConfig,
  reservedSeatsByRoom: ReadonlyMap<string, number>,
  preferredRoomId?: string,
): string | undefined {
  assertPlacementConfig(config);
  if (
    !Number.isInteger(requiredSeats) ||
    requiredSeats < 1 ||
    requiredSeats > config.hardCapacity
  ) {
    return undefined;
  }
  const available = candidates.filter((candidate) => {
    const occupied =
      candidate.clients + (reservedSeatsByRoom.get(candidate.roomId) ?? 0);
    return (
      candidate.logicalMapId === logicalMapId &&
      candidate.instanceRole === "public" &&
      !candidate.locked &&
      occupied + requiredSeats <= candidate.maxClients &&
      occupied + requiredSeats <= config.hardCapacity
    );
  });
  if (preferredRoomId !== undefined) {
    return available.find((candidate) => candidate.roomId === preferredRoomId)
      ?.roomId;
  }
  const underSoftTarget = available
    .filter(
      (candidate) =>
        candidate.clients + (reservedSeatsByRoom.get(candidate.roomId) ?? 0) <
        config.softPopulationTarget,
    )
    .sort(sortCandidates);
  // No under-target instance means "new public instance". The caller may
  // fall back to overflow only if creation itself is unavailable; the local
  // single-process driver can create, so it deliberately returns undefined
  // here rather than packing a party into an over-target room.
  return underSoftTarget[0]?.roomId;
}

/**
 * Adapts Colyseus' room cache to the pure placement rule. Colyseus owns the
 * connected and reserved seat count and atomically enforces maxClients when a
 * selected room reserves a seat.
 */
export class MapPlacementDriver extends LocalDriver {
  readonly #config: MapPlacementConfig;
  readonly #now: () => number;
  readonly #partyReservations = new Map<string, PartyCapacityReservation>();

  constructor(config: MapPlacementConfig, options?: { now?: () => number }) {
    super();
    assertPlacementConfig(config);
    this.#config = config;
    this.#now = options?.now ?? Date.now;
  }

  get hardCapacity(): number {
    return this.#config.hardCapacity;
  }

  get softPopulationTarget(): number {
    return this.#config.softPopulationTarget;
  }

  isMapInstance(roomId: string): boolean {
    const room = this.rooms.find((candidate) => candidate.roomId === roomId);
    const metadata = room?.metadata as MapRoomMetadata | undefined;
    return metadata?.instanceRole === "public";
  }

  override async findOne(
    conditions: Partial<IRoomCache>,
    sortOptions?: SortOptions,
  ): Promise<IRoomCache> {
    if (conditions.roomId !== undefined || conditions.name === undefined) {
      return super.findOne(conditions, sortOptions);
    }

    this.#purgeExpiredReservations();
    const partyReservationId = (
      conditions as Partial<IRoomCache> & { partyReservationId?: string }
    ).partyReservationId;
    if (partyReservationId !== undefined) {
      const reservation = this.#partyReservations.get(partyReservationId);
      if (!reservation || reservation.roomId === undefined) {
        return undefined as unknown as IRoomCache;
      }
      return (this.rooms.find(
        (candidate) =>
          candidate.roomId === reservation.roomId && !candidate.locked,
      ) ?? undefined) as IRoomCache;
    }

    const allCandidates = this.query(conditions, sortOptions);
    const mapCandidates = allCandidates.filter((room) => {
      const metadata = room.metadata as MapRoomMetadata | undefined;
      return metadata?.instanceRole === "public";
    });
    if (mapCandidates.length === 0) {
      return super.findOne(conditions, sortOptions);
    }

    const reservedSeatsByRoom = this.#reservedSeatsByRoom();
    const selectedRoomId = selectMapInstance(
      mapCandidates.map((room) => {
        const metadata = room.metadata as MapRoomMetadata;
        return {
          roomId: room.roomId,
          // A coordinated reservation is already promised capacity even
          // before those clients have completed destination matchmaking.
          // Treat those seats as occupied so an unrelated join cannot steal
          // them between reservation and arrival.
          clients: room.clients + (reservedSeatsByRoom.get(room.roomId) ?? 0),
          maxClients: room.maxClients,
          locked: room.locked === true,
          instanceRole: metadata.instanceRole,
          logicalMapId: metadata.logicalMapId,
          createdAt: room.createdAt?.getTime() ?? 0,
          partyReservationId: metadata.partyReservationId,
        } satisfies MapInstanceCandidate;
      }),
      (mapCandidates[0]?.metadata as MapRoomMetadata).logicalMapId,
      this.#config,
    );

    return (mapCandidates.find((room) => room.roomId === selectedRoomId) ??
      undefined) as IRoomCache;
  }

  override persist(room: IRoomCache, create?: boolean): boolean {
    const persisted = super.persist(room, create);
    if (create) {
      const metadata = room.metadata as MapRoomMetadata | undefined;
      const reservationId = metadata?.partyReservationId;
      const reservation = reservationId
        ? this.#partyReservations.get(reservationId)
        : undefined;
      if (reservation && reservation.roomId === undefined) {
        reservation.roomId = room.roomId;
      } else if (!reservation && metadata?.partyReservationId !== undefined) {
        delete metadata.partyReservationId;
      }
    }
    return persisted;
  }

  reservePartyCapacity(
    request: PartyCapacityReservationRequest,
  ): PartyCapacityReservationDecision {
    this.#purgeExpiredReservations();
    const memberIds = [...new Set(request.memberIds)];
    if (
      memberIds.length !== request.memberIds.length ||
      memberIds.length < 1 ||
      request.expiresAtMs <= this.#now() ||
      this.#partyReservations.has(request.reservationId)
    ) {
      return { accepted: false, code: ERROR_CODES.instanceUnavailable };
    }
    const candidates = this.#mapCandidates(request.logicalMapId);
    const roomId = selectPartyMapInstance(
      candidates,
      request.logicalMapId,
      memberIds.length,
      this.#config,
      this.#reservedSeatsByRoom(),
      request.preferredRoomId,
    );
    if (
      roomId === undefined &&
      (request.preferredRoomId !== undefined ||
        memberIds.length > this.#config.hardCapacity)
    ) {
      return { accepted: false, code: ERROR_CODES.instanceUnavailable };
    }
    this.#partyReservations.set(request.reservationId, {
      reservationId: request.reservationId,
      logicalMapId: request.logicalMapId,
      pendingMemberIds: new Set(memberIds),
      roomId,
      expiresAtMs: request.expiresAtMs,
    });
    return { accepted: true, reservationId: request.reservationId, roomId };
  }

  hasPartyReservation(
    reservationId: string,
    logicalMapId: string,
    memberId: string,
  ): boolean {
    this.#purgeExpiredReservations();
    const reservation = this.#partyReservations.get(reservationId);
    return (
      reservation?.logicalMapId === logicalMapId &&
      reservation.pendingMemberIds.has(memberId)
    );
  }

  hasPartyReservationToken(
    reservationId: string,
    logicalMapId: string,
  ): boolean {
    this.#purgeExpiredReservations();
    return (
      this.#partyReservations.get(reservationId)?.logicalMapId === logicalMapId
    );
  }

  extendPartyReservation(reservationId: string, expiresAtMs: number): boolean {
    this.#purgeExpiredReservations();
    const reservation = this.#partyReservations.get(reservationId);
    if (!reservation || expiresAtMs <= this.#now()) return false;
    reservation.expiresAtMs = Math.max(reservation.expiresAtMs, expiresAtMs);
    return true;
  }

  claimPartySeat(
    reservationId: string,
    logicalMapId: string,
    memberId: string,
    roomId: string,
  ): boolean {
    this.#purgeExpiredReservations();
    const reservation = this.#partyReservations.get(reservationId);
    if (
      !reservation ||
      reservation.logicalMapId !== logicalMapId ||
      reservation.roomId !== roomId ||
      !reservation.pendingMemberIds.delete(memberId)
    ) {
      return false;
    }
    if (reservation.pendingMemberIds.size === 0) {
      this.#removePartyReservation(reservationId);
    }
    return true;
  }

  releasePartyReservation(reservationId: string): void {
    this.#removePartyReservation(reservationId);
  }

  reservedSeats(roomId: string): number {
    this.#purgeExpiredReservations();
    let total = 0;
    for (const reservation of this.#partyReservations.values()) {
      if (reservation.roomId === roomId) {
        total += reservation.pendingMemberIds.size;
      }
    }
    return total;
  }

  #mapCandidates(logicalMapId: string): MapInstanceCandidate[] {
    return this.rooms
      .filter((room) => {
        const metadata = room.metadata as MapRoomMetadata | undefined;
        return (
          metadata?.instanceRole === "public" &&
          metadata.logicalMapId === logicalMapId
        );
      })
      .map((room) => {
        const metadata = room.metadata as MapRoomMetadata;
        return {
          roomId: room.roomId,
          clients: room.clients,
          maxClients: room.maxClients,
          locked: room.locked === true,
          instanceRole: metadata.instanceRole,
          logicalMapId: metadata.logicalMapId,
          createdAt: room.createdAt?.getTime() ?? 0,
          partyReservationId: metadata.partyReservationId,
        };
      });
  }

  #reservedSeatsByRoom(): Map<string, number> {
    const reserved = new Map<string, number>();
    for (const reservation of this.#partyReservations.values()) {
      if (reservation.roomId === undefined) continue;
      reserved.set(
        reservation.roomId,
        (reserved.get(reservation.roomId) ?? 0) +
          reservation.pendingMemberIds.size,
      );
    }
    return reserved;
  }

  #purgeExpiredReservations(): void {
    const now = this.#now();
    for (const [reservationId, reservation] of this.#partyReservations) {
      if (now >= reservation.expiresAtMs) {
        this.#removePartyReservation(reservationId);
      }
    }
  }

  #removePartyReservation(reservationId: string): void {
    this.#partyReservations.delete(reservationId);
    const room = this.rooms.find((candidate) => {
      const metadata = candidate.metadata as MapRoomMetadata | undefined;
      return metadata?.partyReservationId === reservationId;
    });
    const metadata = room?.metadata as MapRoomMetadata | undefined;
    if (metadata?.partyReservationId === reservationId) {
      delete metadata.partyReservationId;
    }
  }

  inspectInstances(logicalMapId?: string): InstanceInspection[] {
    return this.rooms
      .filter((room) => {
        const metadata = room.metadata as MapRoomMetadata | undefined;
        return (
          metadata?.instanceRole === "public" &&
          (logicalMapId === undefined || metadata.logicalMapId === logicalMapId)
        );
      })
      .sort(
        (left, right) =>
          (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0),
      )
      .map((room) => ({
        logicalMapId: (room.metadata as MapRoomMetadata).logicalMapId,
        roomId: room.roomId,
        clients: room.clients,
        hardCapacity: this.#config.hardCapacity,
        locked: room.locked === true,
        status: room.locked === true ? "locked" : "public",
        createdAtMs: room.createdAt?.getTime(),
      }));
  }
}
