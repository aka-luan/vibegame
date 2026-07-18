import { describe, expect, it } from "vitest";

import { dialogueCatalogSchema } from "@gameish/content/dialogue";

import {
  evaluateDialogueCondition,
  resolveDialogueChoice,
  resolveDialogueNode,
  type DialogueCharacterState,
} from "./resolver.js";

const catalog = dialogueCatalogSchema.parse({
  schemaVersion: 1,
  npcs: [
    {
      id: "npc:test",
      interactiveId: "test_npc",
      graphId: "dialogue:test",
      clientVisible: { displayName: "Test NPC" },
    },
  ],
  graphs: [
    {
      id: "dialogue:test",
      npcId: "npc:test",
      rootNodeId: "root",
      nodes: [
        {
          id: "root",
          speaker: "Test NPC",
          text: "Choose.",
          choices: [
            {
              id: "open",
              label: "Open the path",
              nextNodeId: "open_path",
              condition: { kind: "minimum_level", level: 2 },
            },
            { id: "close", label: "Close" },
          ],
        },
        {
          id: "open_path",
          speaker: "Test NPC",
          text: "The path is open.",
          choices: [],
        },
      ],
    },
  ],
});

const character = (level: number): DialogueCharacterState => ({
  level,
  flags: new Set(),
  completedQuestIds: new Set(),
});

describe("server dialogue resolver", () => {
  it("evaluates conditions from server-owned character state", () => {
    expect(
      evaluateDialogueCondition(
        { kind: "minimum_level", level: 2 },
        character(1),
      ),
    ).toBe(false);
    expect(
      evaluateDialogueCondition(
        { kind: "minimum_level", level: 2 },
        character(2),
      ),
    ).toBe(true);
  });

  it("filters unavailable choices and resolves only approved transitions", () => {
    const blocked = resolveDialogueNode(
      catalog,
      "npc:test",
      "root",
      character(1),
    );
    expect(blocked).toMatchObject({
      success: true,
      node: { choices: [{ id: "close" }] },
    });

    const open = resolveDialogueChoice(
      catalog,
      "npc:test",
      "root",
      "open",
      character(1),
    );
    expect(open).toEqual({ success: false, reason: "choice_not_found" });

    const resolved = resolveDialogueChoice(
      catalog,
      "npc:test",
      "root",
      "open",
      character(2),
    );
    expect(resolved).toMatchObject({
      success: true,
      node: { nodeId: "open_path", text: "The path is open." },
    });
  });
});
