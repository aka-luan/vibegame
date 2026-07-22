import { describe, expect, it } from "vitest";

import forestMap from "@gameish/content/forest-map";
import forestMapServer from "@gameish/content/forest-map-server";
import villageMap from "@gameish/content/village-map";
import villageMapServer from "@gameish/content/village-map-server";

/**
 * ADR-0008 regression coverage: a portal's destination is server-authoritative
 * geometry. The client artifact's `portalHints` exist purely so the UI can
 * show a travel prompt and label — they must never carry `destinationMapId`
 * or `destinationEntranceId`, anywhere, in either compiled client map. The
 * server artifacts are asserted to actually carry that data, so this is a
 * real cross-check that the split is happening, not a tautology against an
 * artifact that never had the fields to begin with.
 */
describe("client map artifacts carry no portal destination metadata", () => {
  it.each([
    { name: "village", client: villageMap, server: villageMapServer },
    { name: "forest", client: forestMap, server: forestMapServer },
  ])(
    "the compiled $name client artifact's portalHints omit destination fields",
    ({ client, server }) => {
      expect(server.portals.length).toBeGreaterThan(0);
      expect(client.portalHints.length).toBe(server.portals.length);

      for (const hint of client.portalHints) {
        expect(Object.keys(hint).sort()).toEqual(["id", "label", "x", "y"]);
        expect(hint).not.toHaveProperty("destinationMapId");
        expect(hint).not.toHaveProperty("destinationEntranceId");
        expect(hint).not.toHaveProperty("locked");
        expect(hint).not.toHaveProperty("width");
        expect(hint).not.toHaveProperty("height");
      }

      const serialized = JSON.stringify(client);
      expect(serialized).not.toContain("destinationMapId");
      expect(serialized).not.toContain("destinationEntranceId");
    },
  );

  it("keeps server-only portal geometry off the client artifact entirely", () => {
    expect(villageMap).not.toHaveProperty("portals");
    expect(villageMap).not.toHaveProperty("collision");
    expect(villageMap).not.toHaveProperty("navigation");
    expect(forestMap).not.toHaveProperty("portals");
    expect(forestMap).not.toHaveProperty("collision");
    expect(forestMap).not.toHaveProperty("navigation");
  });
});
