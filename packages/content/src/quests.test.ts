import { describe, expect, it } from "vitest";

import foundationContent from "../content/foundation.json" with { type: "json" };
import {
  compileClientQuestCatalog,
  questCatalogSchema,
  validateQuestCatalog,
} from "./quests.js";
import { validateContent } from "./index.js";

describe("quest content validation", () => {
  it("compiles the first quest with only tracker-safe fields", () => {
    const catalog = questCatalogSchema.parse(foundationContent.quests);
    const client = compileClientQuestCatalog(catalog);
    expect(client.quests[0]).toMatchObject({
      id: "quest:forest_mossbacks",
      title: "Mossbacks Near the Path",
      objectiveKind: "kill",
      requiredCount: 1,
    });
    expect(new Set(client.quests.map((quest) => quest.objectiveKind))).toEqual(
      new Set(["kill", "speak", "visit", "interact", "collect"]),
    );
    expect(JSON.stringify(client)).not.toContain("mossback_scale");
    expect(JSON.stringify(client)).not.toContain("currency");
    expect(JSON.stringify(client)).not.toContain("prerequisites");
  });

  it("reports duplicate quest identifiers", () => {
    const input = structuredClone(foundationContent.quests);
    input.quests.push(input.quests[0]!);
    const result = validateQuestCatalog(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues).toContainEqual({
      path: "quests.5.id",
      message: "Duplicate quest identifier: quest:forest_mossbacks",
    });
  });

  it.each(["kill", "speak", "visit", "interact", "collect"] as const)(
    "requires a positive bounded count for %s objectives",
    (kind) => {
      const input = structuredClone(foundationContent.quests);
      const quest = input.quests.find(
        (candidate) => candidate.serverOnly.objective.kind === kind,
      );
      if (!quest) throw new Error(`Missing ${kind} fixture`);
      quest.serverOnly.objective.requiredCount = 0;
      quest.clientVisible.requiredCount = 0;
      expect(validateQuestCatalog(input).success).toBe(false);
    },
  );

  it("rejects a circular prerequisite graph", () => {
    const input = structuredClone(foundationContent.quests);
    input.quests[0]!.serverOnly.prerequisites = [input.quests[1]!.id];
    input.quests[1]!.serverOnly.prerequisites = [input.quests[0]!.id];
    const result = validateQuestCatalog(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.issues.some((issue) => issue.message.includes("Circular")),
    ).toBe(true);
  });

  it("allows a valid prerequisite to appear later in the catalog", () => {
    const input = structuredClone(foundationContent.quests);
    input.quests[0]!.serverOnly.prerequisites = [input.quests[4]!.id];
    input.quests[4]!.serverOnly.prerequisites = [];
    expect(validateQuestCatalog(input).success).toBe(true);
  });

  it("rejects a collect objective whose target no loot table drops", () => {
    const input = structuredClone(foundationContent);
    const collectQuest = input.quests.quests.find(
      (candidate) => candidate.serverOnly.objective.kind === "collect",
    );
    if (!collectQuest) throw new Error("Missing collect fixture");
    collectQuest.serverOnly.objective.targetId = "item:mossback_scale";
    collectQuest.clientVisible.guidance = {
      label: "Mossback drops",
      targetId: "item:mossback_scale",
    };
    const result = validateContent(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.issues.some((issue) =>
        issue.message.includes("Impossible collect objective"),
      ),
    ).toBe(true);
  });

  it("rejects missing objective and prerequisite references in canonical content", () => {
    const input = structuredClone(foundationContent);
    input.definitions = input.definitions.filter(
      (definition) => definition.id !== "monster:mossback",
    );
    input.quests.quests[0]!.serverOnly.prerequisites = ["quest:missing"];
    const result = validateContent(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.issues.some((issue) =>
        issue.message.includes("Missing quest objective reference"),
      ),
    ).toBe(true);
    expect(
      result.issues.some((issue) =>
        issue.message.includes("Missing quest prerequisite reference"),
      ),
    ).toBe(true);
  });
});
