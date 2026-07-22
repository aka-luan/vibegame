import { randomUUID } from "node:crypto";

import { InMemoryQuestPersistence } from "./persistence.js";
import { runQuestPersistenceContract } from "./persistence-contract.js";

runQuestPersistenceContract("in-memory", () => {
  const persistence = new InMemoryQuestPersistence(
    "quest:contract_placeholder",
  );
  return Promise.resolve({
    persistence,
    characterId: `character:contract-${randomUUID()}`,
    countRewards: () => Promise.resolve(persistence.rewards().length),
  });
});
