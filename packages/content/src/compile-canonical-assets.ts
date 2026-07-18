import { mkdir, readFile, writeFile } from "node:fs/promises";

import { characterManifestSchema } from "./character-manifest.js";
import { compileClientCombatCatalog } from "./combat.js";
import {
  compileClientDialogueCatalog,
  validateDialogueInteractiveBindings,
} from "./dialogue.js";
import { contentSchema } from "./index.js";
import { compileTiledMap } from "./maps.js";

const packageRoot = new URL("../", import.meta.url);
const artifactDirectory = new URL("./artifacts/", import.meta.url);

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, packageRoot), "utf8"));
}

function moduleSource(value: unknown): string {
  return `export default ${JSON.stringify(value, null, 2)};\n`;
}

async function compileCanonicalAssets(): Promise<void> {
  const canonicalContent = await readJson("content/foundation.json");
  const parsedContent = contentSchema.safeParse(canonicalContent);
  if (
    !parsedContent.success ||
    !parsedContent.data.combat ||
    !parsedContent.data.dialogue
  ) {
    throw new Error(
      `Canonical combat/dialogue content failed:\n${parsedContent.success ? "Combat or dialogue catalog is missing" : parsedContent.error.message}`,
    );
  }
  const parsedCombat = parsedContent.data.combat;
  const parsedDialogue = parsedContent.data.dialogue;
  const clientCombat = compileClientCombatCatalog(parsedCombat);
  const clientDialogue = compileClientDialogueCatalog(parsedDialogue);

  const manifest = characterManifestSchema.safeParse(
    await readJson("manifests/village-character.json"),
  );
  if (!manifest.success) {
    throw new Error(
      `Village character manifest failed:\n${manifest.error.message}`,
    );
  }

  const map = compileTiledMap(
    "map:village",
    "content:village_m1_v1",
    await readJson("maps/village.tiled.json"),
    manifest.data.collision,
  );
  if (!map.success) {
    throw new Error(
      `Village map compilation failed:\n${map.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }
  const dialogueIssues = validateDialogueInteractiveBindings(
    parsedDialogue,
    map.server.interactives.map((interactive) => interactive.id),
  );
  if (dialogueIssues.length > 0) {
    throw new Error(
      `Dialogue map bindings failed:\n${dialogueIssues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  await mkdir(artifactDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      new URL("village-map.js", artifactDirectory),
      moduleSource(map.client),
    ),
    writeFile(
      new URL("village-map.server.json", artifactDirectory),
      `${JSON.stringify(map.server, null, 2)}\n`,
    ),
    writeFile(
      new URL("village-map.server.js", artifactDirectory),
      moduleSource(map.server),
    ),
    writeFile(
      new URL("village-character.js", artifactDirectory),
      moduleSource(manifest.data),
    ),
    writeFile(
      new URL("village-combat-server.js", artifactDirectory),
      moduleSource(parsedCombat),
    ),
    writeFile(
      new URL("village-combat.js", artifactDirectory),
      moduleSource(clientCombat),
    ),
    writeFile(
      new URL("village-dialogue-server.js", artifactDirectory),
      moduleSource(parsedDialogue),
    ),
    writeFile(
      new URL("village-dialogue.js", artifactDirectory),
      moduleSource(clientDialogue),
    ),
  ]);
}

await compileCanonicalAssets();
