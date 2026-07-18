import { describe, expect, it } from "vitest";

import foundationContent from "../content/foundation.json" with { type: "json" };
import {
  compileClientQuestCatalog,
  questCatalogSchema,
  validateQuestCatalog,
} from "./quests.js";

describe("quest content validation", () => {
  it("compiles the first quest with only tracker-safe fields", () => {
    const catalog = questCatalogSchema.parse(foundationContent.quests);
    const client = compileClientQuestCatalog(catalog);
    expect(client.quests[0]).toMatchObject({
      id: "quest:forest_mossbacks",
      title: "Mossbacks Near the Path",
      requiredCount: 1,
    });
    expect(JSON.stringify(client)).not.toContain("mossback_scale");
    expect(JSON.stringify(client)).not.toContain("currency");
  });

  it("reports duplicate quest identifiers", () => {
    const input = structuredClone(foundationContent.quests);
    input.quests.push(input.quests[0]!);
    expect(validateQuestCatalog(input)).toMatchObject({
      success: false,
      issues: [
        { message: "Duplicate quest identifier: quest:forest_mossbacks" },
      ],
    });
  });
});
