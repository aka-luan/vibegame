import { describe, expect, it } from "vitest";

import foundationContent from "../content/foundation.json" with { type: "json" };

import {
  dialogueCatalogSchema,
  validateDialogueCatalog,
  validateDialogueInteractiveBindings,
} from "./dialogue.js";

describe("dialogue content validation", () => {
  it("accepts the seeded NPC graph", () => {
    expect(validateDialogueCatalog(foundationContent.dialogue)).toMatchObject({
      success: true,
    });
  });

  it("rejects missing choice nodes and unreachable nodes", () => {
    const invalid = structuredClone(foundationContent.dialogue);
    invalid.graphs[0]!.nodes[0]!.choices[0]!.nextNodeId = "missing_node";
    invalid.graphs[0]!.nodes.push({
      id: "orphan",
      speaker: "Elmira",
      text: "This node cannot be reached.",
      choices: [],
    });

    const result = validateDialogueCatalog(invalid);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Dialogue node is unreachable: orphan",
        }),
        expect.objectContaining({
          message: "Dialogue choice references an unknown node: missing_node",
        }),
      ]),
    );
  });

  it("rejects a root that does not exist", () => {
    const invalid = structuredClone(foundationContent.dialogue);
    invalid.graphs[0]!.rootNodeId = "missing_root";

    const result = dialogueCatalogSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Dialogue graph root does not exist: missing_root",
        }),
      ]),
    );
  });

  it("rejects an NPC graph owned by a different NPC", () => {
    const invalid = structuredClone(foundationContent.dialogue);
    invalid.npcs[0]!.id = "npc:other";

    const result = validateDialogueCatalog(invalid);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Dialogue graph belongs to npc:elmira, not npc:other",
        }),
      ]),
    );
  });

  it("rejects an NPC anchor missing from the compiled map", () => {
    const catalog = dialogueCatalogSchema.parse(foundationContent.dialogue);
    expect(validateDialogueInteractiveBindings(catalog, [])).toEqual([
      {
        path: "npcs[0].interactiveId",
        message: "NPC interaction is missing from the map: notice_board",
      },
    ]);
  });
});
