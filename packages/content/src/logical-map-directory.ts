/**
 * The only logical maps that are safe to name in client-facing payloads.
 * Instance identity, access rules, and map geometry remain outside this
 * directory.
 */
export interface LogicalMapDirectoryEntry {
  logicalMapId: string;
  displayName: string;
}

export const LOGICAL_MAP_DIRECTORY: readonly LogicalMapDirectoryEntry[] =
  Object.freeze([
    { logicalMapId: "map:village", displayName: "Village" },
    { logicalMapId: "map:forest", displayName: "Forest" },
  ]);
