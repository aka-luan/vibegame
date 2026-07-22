import { describe, expect, it } from "vitest";

import {
  compileClientEquipmentCatalog,
  validateEquipmentManifestCompatibility,
  validateEquipmentCatalog,
} from "./equipment.js";

const catalog = {
  schemaVersion: 1,
  items: [
    {
      id: "item:trailwarden_tunic",
      slot: "body",
      clientVisible: { displayName: "Trailwarden Tunic", layerId: "tunic" },
      serverOnly: {
        rigId: "rig:village_placeholder",
        requirements: { minimumLevel: 1, classId: "class:trailwarden" },
      },
    },
  ],
} as const;

describe("equipment catalog", () => {
  it("keeps compatibility rules server-only when compiling the client catalog", () => {
    const result = validateEquipmentCatalog(catalog);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(compileClientEquipmentCatalog(result.data)).toEqual({
      schemaVersion: 1,
      items: [
        {
          id: "item:trailwarden_tunic",
          slot: "body",
          displayName: "Trailwarden Tunic",
          layerId: "tunic",
        },
      ],
    });
    expect(
      JSON.stringify(compileClientEquipmentCatalog(result.data)),
    ).not.toContain("village_placeholder");
    expect(
      JSON.stringify(compileClientEquipmentCatalog(result.data)),
    ).not.toContain("minimumLevel");
  });

  it("rejects duplicate equipment identifiers", () => {
    expect(
      validateEquipmentCatalog({
        ...catalog,
        items: [...catalog.items, catalog.items[0]],
      }),
    ).toEqual({
      success: false,
      issues: [
        {
          path: "items.1.id",
          message:
            "Duplicate equipment item identifier: item:trailwarden_tunic",
        },
      ],
    });
  });

  it("rejects equipment that declares a slot outside the approved body slot", () => {
    expect(
      validateEquipmentCatalog({
        ...catalog,
        items: [{ ...catalog.items[0], slot: "head" }],
      }),
    ).toMatchObject({
      success: false,
      issues: [
        {
          path: "items.0.slot",
          message: 'Invalid input: expected "body"',
        },
      ],
    });
  });

  it("requires equipment compatibility references to resolve in the rig", () => {
    expect(
      validateEquipmentManifestCompatibility(catalog, {
        id: "rig:village_placeholder",
        layers: [{ id: "base" }, { id: "tunic" }],
      }),
    ).toEqual([]);
    expect(
      validateEquipmentManifestCompatibility(
        {
          ...catalog,
          items: [
            {
              ...catalog.items[0],
              serverOnly: {
                rigId: "rig:other",
                requirements: {
                  minimumLevel: 1,
                  classId: "class:trailwarden",
                },
              },
              clientVisible: {
                ...catalog.items[0].clientVisible,
                layerId: "missing_layer",
              },
            },
          ],
        },
        {
          id: "rig:village_placeholder",
          layers: [{ id: "base" }, { id: "tunic" }],
        },
      ),
    ).toEqual([
      {
        path: "items.0.serverOnly.rigId",
        message:
          "Equipment rig does not match the canonical character manifest: rig:other",
      },
      {
        path: "items.0.clientVisible.layerId",
        message:
          "Equipment layer does not exist in the canonical character manifest: missing_layer",
      },
    ]);
  });
});
