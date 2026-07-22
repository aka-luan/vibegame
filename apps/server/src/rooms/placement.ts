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
}

export interface MapInstanceSnapshot {
  instanceId: string;
  logicalMapId: string;
  connectedSeats: number;
  reservedSeats: number;
  softPopulationTarget: number;
  hardCapacity: number;
  status: "public" | "disposing";
  createdAtMs: number;
}

export interface PlacementRequest {
  logicalMapId: string;
  seats?: number;
  reconnectInstanceId?: string;
  partyReservation?: {
    instanceId: string;
    seats?: number;
  };
  createInstance?:
    | (() =>
        | {
            instanceId: string;
            logicalMapId: string;
            createdAtMs?: number;
          }
        | undefined)
    | undefined;
}

export type PlacementDecision =
  | {
      kind: "reconnect" | "party" | "existing" | "new" | "overflow";
      instance: MapInstanceSnapshot;
      reservationId: string;
    }
  | {
      kind: "unavailable";
      code: typeof ERROR_CODES.instanceUnavailable;
    };

interface MutableMapInstance {
  instanceId: string;
  logicalMapId: string;
  connectedSeats: number;
  reservedSeats: number;
  status: "public" | "disposing";
  createdAtMs: number;
}

interface Reservation {
  instanceId: string;
  seats: number;
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

/**
 * The in-memory placement decision core. It deliberately has no network,
 * persistence, or Colyseus dependency so reservation races can be tested as
 * one synchronous critical section in the single Node process.
 */
export class InMemoryMapPlacement {
  readonly #config: MapPlacementConfig;
  readonly #instances = new Map<string, MutableMapInstance>();
  readonly #reservations = new Map<string, Reservation>();
  #nextReservation = 0;

  constructor(config: MapPlacementConfig) {
    assertPlacementConfig(config);
    this.#config = config;
  }

  registerInstance(input: {
    instanceId: string;
    logicalMapId: string;
    createdAtMs?: number;
  }): MapInstanceSnapshot {
    if (this.#instances.has(input.instanceId)) {
      throw new Error(`Map instance already registered: ${input.instanceId}`);
    }
    const instance: MutableMapInstance = {
      instanceId: input.instanceId,
      logicalMapId: input.logicalMapId,
      connectedSeats: 0,
      reservedSeats: 0,
      status: "public",
      createdAtMs: input.createdAtMs ?? Date.now(),
    };
    this.#instances.set(instance.instanceId, instance);
    return this.#snapshot(instance);
  }

  setPopulation(
    instanceId: string,
    population: { connectedSeats: number; reservedSeats?: number },
  ): MapInstanceSnapshot | undefined {
    const instance = this.#instances.get(instanceId);
    if (!instance) return undefined;
    if (
      !Number.isInteger(population.connectedSeats) ||
      population.connectedSeats < 0 ||
      !Number.isInteger(population.reservedSeats ?? 0) ||
      (population.reservedSeats ?? 0) < 0
    ) {
      throw new Error("Map instance population must be nonnegative integers");
    }
    if (
      population.connectedSeats + (population.reservedSeats ?? 0) >
      this.#config.hardCapacity
    ) {
      throw new Error("Map instance hard capacity exceeded");
    }
    instance.connectedSeats = population.connectedSeats;
    instance.reservedSeats = population.reservedSeats ?? 0;
    return this.#snapshot(instance);
  }

  beginDisposal(instanceId: string): MapInstanceSnapshot | undefined {
    const instance = this.#instances.get(instanceId);
    if (!instance) return undefined;
    instance.status = "disposing";
    return this.#snapshot(instance);
  }

  completeDisposal(instanceId: string): boolean {
    const instance = this.#instances.get(instanceId);
    if (
      !instance ||
      instance.connectedSeats !== 0 ||
      instance.reservedSeats !== 0
    ) {
      return false;
    }
    this.#instances.delete(instanceId);
    for (const [reservationId, reservation] of this.#reservations) {
      if (reservation.instanceId === instanceId) {
        this.#reservations.delete(reservationId);
      }
    }
    return true;
  }

  list(logicalMapId?: string): MapInstanceSnapshot[] {
    return [...this.#instances.values()]
      .filter(
        (instance) =>
          logicalMapId === undefined || instance.logicalMapId === logicalMapId,
      )
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map((instance) => this.#snapshot(instance));
  }

  place(request: PlacementRequest): PlacementDecision {
    const seats = request.seats ?? 1;
    if (!Number.isInteger(seats) || seats < 1) {
      return { kind: "unavailable", code: ERROR_CODES.instanceUnavailable };
    }
    if (seats > this.#config.hardCapacity) {
      return { kind: "unavailable", code: ERROR_CODES.instanceUnavailable };
    }

    const reconnect = request.reconnectInstanceId
      ? this.#instances.get(request.reconnectInstanceId)
      : undefined;
    if (
      reconnect &&
      reconnect.logicalMapId === request.logicalMapId &&
      this.#canReserve(reconnect, seats)
    ) {
      return this.#reserve(reconnect, seats, "reconnect");
    }
    if (reconnect && reconnect.logicalMapId === request.logicalMapId) {
      return { kind: "unavailable", code: ERROR_CODES.instanceUnavailable };
    }

    const party = request.partyReservation
      ? this.#instances.get(request.partyReservation.instanceId)
      : undefined;
    const partySeats = request.partyReservation?.seats ?? seats;
    if (
      party &&
      party.logicalMapId === request.logicalMapId &&
      partySeats >= seats &&
      this.#canReserve(party, seats)
    ) {
      return this.#reserve(party, seats, "party");
    }
    if (party && party.logicalMapId === request.logicalMapId) {
      return { kind: "unavailable", code: ERROR_CODES.instanceUnavailable };
    }

    const publicCandidate = this.#findCandidate(
      request.logicalMapId,
      seats,
      this.#config.softPopulationTarget,
    );
    if (publicCandidate) {
      return this.#reserve(publicCandidate, seats, "existing");
    }

    if (request.createInstance) {
      const created = request.createInstance();
      if (created && created.logicalMapId === request.logicalMapId) {
        const registered = this.registerInstance(created);
        const instance = this.#instances.get(registered.instanceId);
        if (!instance)
          throw new Error("Created map instance was not registered");
        return this.#reserve(instance, seats, "new");
      }
    }

    const overflowCandidate = this.#findCandidate(
      request.logicalMapId,
      seats,
      this.#config.hardCapacity,
    );
    if (overflowCandidate) {
      return this.#reserve(overflowCandidate, seats, "overflow");
    }
    return { kind: "unavailable", code: ERROR_CODES.instanceUnavailable };
  }

  commit(reservationId: string): MapInstanceSnapshot | undefined {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) return undefined;
    const instance = this.#instances.get(reservation.instanceId);
    if (!instance) return undefined;
    instance.reservedSeats -= reservation.seats;
    instance.connectedSeats += reservation.seats;
    this.#reservations.delete(reservationId);
    return this.#snapshot(instance);
  }

  release(reservationId: string): MapInstanceSnapshot | undefined {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) return undefined;
    const instance = this.#instances.get(reservation.instanceId);
    if (!instance) return undefined;
    instance.reservedSeats -= reservation.seats;
    this.#reservations.delete(reservationId);
    return this.#snapshot(instance);
  }

  #findCandidate(
    logicalMapId: string,
    seats: number,
    populationLimit: number,
  ): MutableMapInstance | undefined {
    return [...this.#instances.values()]
      .filter(
        (instance) =>
          instance.logicalMapId === logicalMapId &&
          instance.status === "public" &&
          instance.connectedSeats + instance.reservedSeats + seats <=
            populationLimit &&
          this.#canReserve(instance, seats),
      )
      .sort(
        (left, right) =>
          left.connectedSeats +
            left.reservedSeats -
            (right.connectedSeats + right.reservedSeats) ||
          left.createdAtMs - right.createdAtMs,
      )[0];
  }

  #canReserve(instance: MutableMapInstance, seats: number): boolean {
    return (
      instance.status === "public" &&
      instance.connectedSeats + instance.reservedSeats + seats <=
        this.#config.hardCapacity
    );
  }

  #reserve(
    instance: MutableMapInstance,
    seats: number,
    kind: "reconnect" | "party" | "existing" | "new" | "overflow",
  ): PlacementDecision {
    const reservationId = `placement-reservation:${String(++this.#nextReservation)}`;
    instance.reservedSeats += seats;
    this.#reservations.set(reservationId, {
      instanceId: instance.instanceId,
      seats,
    });
    return {
      kind,
      instance: this.#snapshot(instance),
      reservationId,
    };
  }

  #snapshot(instance: MutableMapInstance): MapInstanceSnapshot {
    return {
      instanceId: instance.instanceId,
      logicalMapId: instance.logicalMapId,
      connectedSeats: instance.connectedSeats,
      reservedSeats: instance.reservedSeats,
      softPopulationTarget: this.#config.softPopulationTarget,
      hardCapacity: this.#config.hardCapacity,
      status: instance.status,
      createdAtMs: instance.createdAtMs,
    };
  }
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

/**
 * Colyseus' local room cache with the logical-map soft target applied during
 * matchmaking. Colyseus still performs the final seat reservation inside the
 * room, where connected and reserved seats are checked atomically.
 */
export class MapPlacementDriver extends LocalDriver {
  readonly #config: MapPlacementConfig;

  constructor(config: MapPlacementConfig) {
    super();
    assertPlacementConfig(config);
    this.#config = config;
  }

  get hardCapacity(): number {
    return this.#config.hardCapacity;
  }

  get softPopulationTarget(): number {
    return this.#config.softPopulationTarget;
  }

  isOverflowInstance(logicalMapId: string, roomId: string): boolean {
    return this.rooms.some((room) => {
      const metadata = room.metadata as MapRoomMetadata | undefined;
      return (
        metadata?.logicalMapId === logicalMapId &&
        metadata.instanceRole === "public" &&
        room.roomId !== roomId
      );
    });
  }

  override async findOne(
    conditions: Partial<IRoomCache>,
    sortOptions?: SortOptions,
  ): Promise<IRoomCache> {
    if (conditions.roomId !== undefined || conditions.name === undefined) {
      return super.findOne(conditions, sortOptions);
    }
    const allCandidates = this.query(conditions, sortOptions);
    if (
      allCandidates.length > 0 &&
      !allCandidates.some(
        (room) =>
          (room.metadata as MapRoomMetadata | undefined)?.instanceRole ===
          "public",
      )
    ) {
      return super.findOne(conditions, sortOptions);
    }
    const candidates = allCandidates.filter(
      (room) =>
        room.clients < Math.min(room.maxClients, this.#config.hardCapacity),
    );
    const publicCandidates = candidates.filter(
      (room) => room.clients < this.#config.softPopulationTarget,
    );
    publicCandidates.sort(
      (left, right) =>
        left.clients - right.clients ||
        (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0),
    );
    return (publicCandidates[0] ?? undefined) as IRoomCache;
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
      .sort((left, right) => {
        const leftCreated = left.createdAt?.getTime() ?? 0;
        const rightCreated = right.createdAt?.getTime() ?? 0;
        return leftCreated - rightCreated;
      })
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
