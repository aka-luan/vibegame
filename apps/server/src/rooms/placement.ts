import { LocalDriver, type IRoomCache, type SortOptions } from "@colyseus/core";

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

export interface MapInstanceCandidate {
  roomId: string;
  clients: number;
  maxClients: number;
  locked: boolean;
  instanceRole: string | undefined;
  logicalMapId: string;
  createdAt: number;
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
      candidate.clients < config.hardCapacity,
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
 * Adapts Colyseus' room cache to the pure placement rule. Colyseus owns the
 * connected and reserved seat count and atomically enforces maxClients when a
 * selected room reserves a seat.
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

    const allCandidates = this.query(conditions, sortOptions);
    const mapCandidates = allCandidates.filter((room) => {
      const metadata = room.metadata as MapRoomMetadata | undefined;
      return metadata?.instanceRole === "public";
    });
    if (mapCandidates.length === 0) {
      return super.findOne(conditions, sortOptions);
    }

    const selectedRoomId = selectMapInstance(
      mapCandidates.map((room) => {
        const metadata = room.metadata as MapRoomMetadata;
        return {
          roomId: room.roomId,
          clients: room.clients,
          maxClients: room.maxClients,
          locked: room.locked === true,
          instanceRole: metadata.instanceRole,
          logicalMapId: metadata.logicalMapId,
          createdAt: room.createdAt?.getTime() ?? 0,
        } satisfies MapInstanceCandidate;
      }),
      (mapCandidates[0]?.metadata as MapRoomMetadata).logicalMapId,
      this.#config,
    );

    return (mapCandidates.find((room) => room.roomId === selectedRoomId) ??
      undefined) as IRoomCache;
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
