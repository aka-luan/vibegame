import type Phaser from "phaser";

import villageCharacter from "@gameish/content/village-character";
import type { PublicAppearance } from "@gameish/protocol";

export type Facing = "north" | "south" | "east" | "west";
export type CharacterState = "idle" | "walk";

export interface CharacterRenderer {
  readonly display: Phaser.GameObjects.Container;
  applyFacing(facing: Facing): void;
  play(state: CharacterState): void;
  setFootPosition(x: number, y: number): void;
  update(time: number): void;
}

function textureKey(layerId: string): string {
  return `village-character-${layerId}`;
}

function sourceForLayer(layerId: string) {
  const visited = new Set<string>();
  let layer = villageCharacter.layers.find(
    (candidate) => candidate.id === layerId,
  );
  while (layer) {
    if (layer.source) return layer.source;
    if (layer.fallback === null || visited.has(layer.fallback)) break;
    visited.add(layer.id);
    const fallbackId = layer.fallback;
    layer = villageCharacter.layers.find(
      (candidate) => candidate.id === fallbackId,
    );
  }
  throw new Error(`No sprite sheet source is available for layer: ${layerId}`);
}

export function preloadVillageCharacter(scene: Phaser.Scene): void {
  for (const layer of villageCharacter.layers) {
    const source = sourceForLayer(layer.id);
    scene.load.spritesheet(textureKey(layer.id), source.dataUri, {
      frameWidth: villageCharacter.canvas.width,
      frameHeight: villageCharacter.canvas.height,
    });
  }
}

function facingRow(facing: Facing): number {
  const definition = villageCharacter.facings[facing];
  if ("row" in definition) return definition.row;
  const mirrored = villageCharacter.facings[definition.mirror];
  if ("row" in mirrored) return mirrored.row;
  throw new Error(`Mirrored facing has no sprite-sheet row: ${facing}`);
}

function isMirrored(facing: Facing): boolean {
  return "mirror" in villageCharacter.facings[facing];
}

export class ManifestCharacterRenderer implements CharacterRenderer {
  readonly display: Phaser.GameObjects.Container;
  readonly #sprites: { layerId: string; sprite: Phaser.GameObjects.Sprite }[];
  #facing: Facing = "south";
  #state: CharacterState = "idle";

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    displayName: string,
    appearance?: PublicAppearance,
  ) {
    const shadow = scene.add.ellipse(0, -2, 16, 6, 0x0d1711, 0.45);
    const nameLabel = scene.add
      .text(0, -29, displayName, {
        color: "#f4f4dd",
        backgroundColor: "rgb(13 23 17 / 75%)",
        fontFamily: "system-ui, sans-serif",
        fontSize: "7px",
        padding: { x: 2, y: 1 },
      })
      .setOrigin(0.5, 1);
    if (appearance && appearance.rigId !== villageCharacter.id) {
      throw new Error(`Unsupported public rig: ${appearance.rigId}`);
    }
    const visibleLayerIds = appearance
      ? new Set([appearance.baseLayerId, appearance.armorLayerId])
      : undefined;
    const orderedLayers = villageCharacter.layers
      .filter((layer) => visibleLayerIds?.has(layer.id) ?? true)
      .sort((first, second) => first.depth - second.depth);
    this.#sprites = orderedLayers.map((layer) => {
      const source = sourceForLayer(layer.id);
      const sprite = scene.add
        .sprite(
          0,
          0,
          textureKey(layer.id),
          facingRow("south") * source.frameColumns,
        )
        .setOrigin(
          villageCharacter.footOrigin.x / villageCharacter.canvas.width,
          villageCharacter.footOrigin.y / villageCharacter.canvas.height,
        );
      return { layerId: layer.id, sprite };
    });
    this.display = scene.add.container(x, y, [
      shadow,
      ...this.#sprites.map(({ sprite }) => sprite),
      nameLabel,
    ]);
    this.display.setScale(villageCharacter.displayScale);
    this.setFootPosition(x, y);
  }

  applyFacing(facing: Facing): void {
    this.#facing = facing;
    for (const { sprite } of this.#sprites) sprite.setFlipX(isMirrored(facing));
  }

  play(state: CharacterState): void {
    this.#state = state;
  }

  setFootPosition(x: number, y: number): void {
    this.display.setPosition(x, y);
    this.display.setDepth(4 + y / 1_000);
  }

  update(time: number): void {
    const animation = villageCharacter.animations[this.#state]!;
    const frameIndex =
      Math.floor(time / animation.frameDurationMs) % animation.frames.length;
    const frame = animation.frames[frameIndex] ?? 0;
    for (const { layerId, sprite } of this.#sprites) {
      const source = sourceForLayer(layerId);
      sprite.setFrame(facingRow(this.#facing) * source.frameColumns + frame);
    }
  }
}
