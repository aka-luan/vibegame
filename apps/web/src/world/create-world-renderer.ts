import Phaser from "phaser";

import foundationMap from "./foundation-map.json";

export interface WorldRenderer {
  destroy(): void;
}

const foundationRig = {
  canvas: { width: 16, height: 24 },
  footOrigin: { x: 8, y: 22 },
} as const;

class FoundationScene extends Phaser.Scene {
  constructor() {
    super("foundation");
  }

  create() {
    const tileTexture = this.textures.createCanvas("foundation-tiles", 48, 16);
    if (!tileTexture) {
      throw new Error("Could not create foundation tile texture");
    }

    const context = tileTexture.context;
    context.fillStyle = "#1d3a2b";
    context.fillRect(0, 0, 16, 16);
    context.fillStyle = "#426b43";
    context.fillRect(16, 0, 16, 16);
    context.fillStyle = "#93b86d";
    context.fillRect(32, 0, 16, 16);
    tileTexture.refresh();

    this.cache.tilemap.add("foundation-map", {
      data: foundationMap,
      format: Phaser.Tilemaps.Formats.TILED_JSON,
    });

    const map = this.make.tilemap({ key: "foundation-map" });
    const tileset = map.addTilesetImage("foundation", "foundation-tiles");
    if (!tileset) {
      throw new Error("Could not bind foundation tileset");
    }

    ["background", "ground", "below_entities"].forEach((layerName, depth) => {
      map.createLayer(layerName, tileset, 0, 0)?.setDepth(depth);
    });

    const characterTexture = this.textures.createCanvas(
      "foundation-character",
      foundationRig.canvas.width,
      foundationRig.canvas.height,
    );
    if (!characterTexture) {
      throw new Error("Could not create foundation character texture");
    }
    characterTexture.context.fillStyle = "#e7c867";
    characterTexture.context.fillRect(1, 1, 14, 22);
    characterTexture.context.strokeStyle = "#fff4b3";
    characterTexture.context.strokeRect(1, 1, 14, 22);
    characterTexture.refresh();

    const shadow = this.add.ellipse(96, 72, 22, 9, 0x0d1711, 0.5);
    const sprite = this.add
      .sprite(96, 72, "foundation-character")
      .setOrigin(
        foundationRig.footOrigin.x / foundationRig.canvas.width,
        foundationRig.footOrigin.y / foundationRig.canvas.height,
      );
    const footDepth = sprite.y / 1_000;
    shadow.setDepth(3 + footDepth);
    sprite.setDepth(4 + footDepth);
    shadow.setData("layer", "below_entities");
    sprite.setData("layer", "entities");

    map.createLayer("entities", tileset, 0, 0)?.setDepth(4);
    map.createLayer("foreground", tileset, 0, 0)?.setDepth(5);
    map.createLayer("effects", tileset, 0, 0)?.setDepth(6);

    this.cameras.main.centerOn(96, 64);
  }
}

export function createWorldRenderer(parent: HTMLElement): WorldRenderer {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: 320,
    height: 240,
    backgroundColor: "#16251c",
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: FoundationScene,
  });

  return {
    destroy() {
      game.destroy(true);
    },
  };
}
