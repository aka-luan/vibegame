import type { MapOverviewMessage } from "@gameish/protocol";

export interface MapOverviewPortal {
  destinationMapId: string;
  label: string;
  locked: boolean;
}

export interface MapOverviewLogicalMap {
  displayName: string;
  portals: readonly MapOverviewPortal[];
}

export interface BuildMapOverviewInput {
  logicalMaps: Readonly<Record<string, MapOverviewLogicalMap>>;
  isAccessible: (logicalMapId: string) => boolean;
  discoveredMapIds: ReadonlySet<string>;
  currentMapId: string;
  questGuidance?: { logicalMapId: string; label: string } | undefined;
}

/**
 * Builds the deliberately small, client-safe map payload. The catalog passed
 * here is already limited to public logical maps; portal geometry and room
 * placement data never enter the result.
 */
export function buildMapOverview({
  logicalMaps,
  isAccessible,
  discoveredMapIds,
  currentMapId,
  questGuidance,
}: BuildMapOverviewInput): MapOverviewMessage {
  const entries = Object.entries(logicalMaps).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const knownMapIds = new Set(entries.map(([logicalMapId]) => logicalMapId));
  const accessibleMapIds = new Set(
    entries
      .map(([logicalMapId]) => logicalMapId)
      .filter((logicalMapId) => isAccessible(logicalMapId)),
  );

  const locations = entries.map(([logicalMapId, map]) => ({
    logicalMapId,
    displayName: map.displayName,
    accessible: accessibleMapIds.has(logicalMapId),
    discovered: discoveredMapIds.has(logicalMapId),
  }));

  const connections = entries
    .filter(([fromMapId]) => accessibleMapIds.has(fromMapId))
    .flatMap(([fromMapId, map]) =>
      map.portals
        .filter(
          (portal) =>
            !portal.locked &&
            knownMapIds.has(portal.destinationMapId) &&
            accessibleMapIds.has(portal.destinationMapId),
        )
        .map((portal) => ({
          fromMapId,
          toMapId: portal.destinationMapId,
          label: portal.label,
        })),
    )
    .sort(
      (left, right) =>
        left.fromMapId.localeCompare(right.fromMapId) ||
        left.toMapId.localeCompare(right.toMapId) ||
        left.label.localeCompare(right.label),
    );

  const adjacentMapIds = new Set(
    connections
      .filter((connection) => connection.fromMapId === currentMapId)
      .map((connection) => connection.toMapId)
      .filter((logicalMapId) => logicalMapId !== currentMapId),
  );
  const recommendations: MapOverviewMessage["recommendations"] = [];
  const questTarget = questGuidance?.logicalMapId;
  if (
    questGuidance &&
    questTarget !== currentMapId &&
    questTarget !== undefined &&
    accessibleMapIds.has(questTarget) &&
    knownMapIds.has(questTarget)
  ) {
    recommendations.push({
      logicalMapId: questTarget,
      displayName: logicalMaps[questTarget]!.displayName,
      reason: "quest",
    });
  }
  for (const logicalMapId of [...adjacentMapIds].sort()) {
    if (!discoveredMapIds.has(logicalMapId) && logicalMapId !== questTarget) {
      recommendations.push({
        logicalMapId,
        displayName: logicalMaps[logicalMapId]!.displayName,
        reason: "unexplored",
      });
    }
  }

  return {
    locations,
    connections,
    recommendations,
    ...(questGuidance &&
    questTarget !== currentMapId &&
    questTarget !== undefined &&
    accessibleMapIds.has(questTarget) &&
    knownMapIds.has(questTarget)
      ? { guidance: { label: questGuidance.label } }
      : {}),
  };
}
