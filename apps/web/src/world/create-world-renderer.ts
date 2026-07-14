import villageCharacter from "@gameish/content/village-character";
import villageMap from "@gameish/content/village-map";
import { moveBody } from "@gameish/world";
import Phaser from "phaser";

import {
  type CharacterState,
  type Facing,
  ManifestCharacterRenderer,
  preloadVillageCharacter,
} from "./manifest-character-renderer.js";
import { MovementInput } from "./movement-input.js";

export interface WorldSnapshot {
  x: number;
  y: number;
  facing: Facing;
  state: CharacterState;
  interaction: string | null;
}

export interface WorldRenderer {
  destroy(): void;
  focus(): void;
}

interface VillageSceneOptions {
  onSnapshot: (snapshot: WorldSnapshot) => void;
  onReady: (input: MovementInput) => void;
}

class VillageScene extends Phaser.Scene {
  readonly #options: VillageSceneOptions;
  #input?: MovementInput;
  #character?: ManifestCharacterRenderer;
  #position = { x: 0, y: 0 };
  #facing: Facing = "south";
  #state: CharacterState = "idle";
  #indicator?: Phaser.GameObjects.Container;
  #lastSnapshot = "";

  constructor(options: VillageSceneOptions) {
    super("village");
    this.#options = options;
  }

  preload(): void {
    preloadVillageCharacter(this);
  }

  create(): void {
    const tileTexture = this.textures.createCanvas("village-tiles", 48, 16);
    if (!tileTexture) throw new Error("Could not create village tile texture");
    const context = tileTexture.context;
    context.fillStyle = "#31563d";
    context.fillRect(0, 0, 16, 16);
    context.fillStyle = "#9b8759";
    context.fillRect(16, 0, 16, 16);
    context.fillStyle = "#6e9560";
    context.fillRect(32, 0, 16, 16);
    context.fillStyle = "rgb(255 255 255 / 10%)";
    for (let x = 0; x < 48; x += 4) context.fillRect(x, x % 8, 2, 2);
    tileTexture.refresh();

    this.cache.tilemap.add("village-map", {
      format: Phaser.Tilemaps.Formats.TILED_JSON,
      data: {
        ...villageMap,
        type: "map",
        version: "1.10",
        tiledversion: "1.11.2",
        orientation: "orthogonal",
        renderorder: "right-down",
        infinite: false,
      },
    });
    const map = this.make.tilemap({ key: "village-map" });
    const tileset = map.addTilesetImage("village_placeholder", "village-tiles");
    if (!tileset) throw new Error("Could not bind village tileset");
    const layerDepths = new Map([
      ["background", 0],
      ["ground", 1],
      ["below_entities", 2],
      ["entities", 3],
      ["foreground", 6],
      ["effects", 7],
    ]);
    for (const [layerName, depth] of layerDepths) {
      map.createLayer(layerName, tileset, 0, 0)?.setDepth(depth);
    }

    const spawn = villageMap.movement.start;
    this.#position = {
      x: spawn.x + villageCharacter.collision.offsetX,
      y: spawn.y + villageCharacter.collision.offsetY,
    };
    this.#character = new ManifestCharacterRenderer(this, spawn.x, spawn.y);

    const hint = villageMap.interactionHints[0];
    if (hint) {
      const marker = this.add
        .circle(0, 0, 9, 0xffe27a, 0.95)
        .setStrokeStyle(2, 0x1b3022);
      const label = this.add
        .text(0, -15, "E", {
          color: "#17251c",
          backgroundColor: "#ffe27a",
          fontFamily: "system-ui, sans-serif",
          fontSize: "10px",
          fontStyle: "bold",
          padding: { x: 3, y: 1 },
        })
        .setOrigin(0.5, 1);
      this.#indicator = this.add
        .container(hint.x, hint.y, [marker, label])
        .setDepth(8);
    }

    this.cameras.main
      .setBounds(
        0,
        0,
        villageMap.movement.bounds.width,
        villageMap.movement.bounds.height,
      )
      .setZoom(2)
      .startFollow(this.#character.display, true, 0.18, 0.18)
      .setRoundPixels(true);

    this.#input = new MovementInput(this.game.canvas);
    this.#options.onReady(this.#input);
    this.#input.focus();
    this.#publishSnapshot();
  }

  override update(time: number, delta: number): void {
    if (!this.#input || !this.#character) return;
    const direction = this.#input.direction();
    const isMoving = direction.x !== 0 || direction.y !== 0;
    this.#state = isMoving ? "walk" : "idle";
    if (isMoving) {
      if (direction.y < 0) this.#facing = "north";
      else if (direction.y > 0) this.#facing = "south";
      else if (direction.x < 0) this.#facing = "west";
      else this.#facing = "east";
      this.#position = moveBody({
        position: this.#position,
        direction,
        speed: 92,
        elapsedMs: delta,
        body: {
          width: villageCharacter.collision.width,
          height: villageCharacter.collision.height,
        },
        world: villageMap.movement,
      });
    }

    const footX = this.#position.x - villageCharacter.collision.offsetX;
    const footY = this.#position.y - villageCharacter.collision.offsetY;
    this.#character.applyFacing(this.#facing);
    this.#character.play(this.#state);
    this.#character.setFootPosition(footX, footY);
    this.#character.update(time);
    this.#publishSnapshot();
  }

  #publishSnapshot(): void {
    const hint = villageMap.interactionHints[0];
    const footX = this.#position.x - villageCharacter.collision.offsetX;
    const footY = this.#position.y - villageCharacter.collision.offsetY;
    const nearHint =
      hint !== undefined && Math.hypot(footX - hint.x, footY - hint.y) <= 46;
    this.#indicator?.setVisible(nearHint);
    const snapshot: WorldSnapshot = {
      x: footX,
      y: footY,
      facing: this.#facing,
      state: this.#state,
      interaction: nearHint && hint ? hint.label : null,
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.#lastSnapshot) return;
    this.#lastSnapshot = serialized;
    this.game.canvas.dataset.playerX = snapshot.x.toFixed(2);
    this.game.canvas.dataset.playerY = snapshot.y.toFixed(2);
    this.game.canvas.dataset.facing = snapshot.facing;
    this.game.canvas.dataset.animation = snapshot.state;
    this.#options.onSnapshot(snapshot);
  }

  shutdown(): void {
    this.#input?.destroy();
  }
}

export function createWorldRenderer(
  parent: HTMLElement,
  onSnapshot: (snapshot: WorldSnapshot) => void,
): WorldRenderer {
  let movementInput: MovementInput | undefined;
  const scene = new VillageScene({
    onSnapshot,
    onReady(input) {
      movementInput = input;
    },
  });
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: 640,
    height: 480,
    backgroundColor: "#17291e",
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene,
  });

  return {
    destroy() {
      movementInput?.destroy();
      game.destroy(true);
    },
    focus() {
      movementInput?.focus();
    },
  };
}
