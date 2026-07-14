import { mkdir, readFile, writeFile } from "node:fs/promises";

import { characterManifestSchema } from "./character-manifest.js";
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
      new URL("village-character.js", artifactDirectory),
      moduleSource(manifest.data),
    ),
  ]);
}

await compileCanonicalAssets();
