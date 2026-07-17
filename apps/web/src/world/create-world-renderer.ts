import villageMap from "@gameish/content/village-map";
import type { PublicPlayerPresence } from "@gameish/protocol";
import villageCharacter from "@gameish/content/village-character";
import { moveCharacterFoot, PLAYER_MOVEMENT } from "@gameish/world";
import Phaser from "phaser";

import type {
  VillagePresence,
  VillagePresenceSnapshot,
} from "../network/village-presence.js";
import {
  ManifestCharacterRenderer,
  preloadVillageCharacter,
} from "./manifest-character-renderer.js";
import { MovementInput } from "./movement-input.js";
import {
  MovementSynchronizer,
  RemoteInterpolator,
  ServerTimeEstimator,
} from "../network/movement-synchronizer.js";

export interface WorldSnapshot {
  x: number;
  y: number;
  facing: PublicPlayerPresence["facing"];
  state: PublicPlayerPresence["animation"];
  interaction: string | null;
  publicPlayerCount: number;
  connectionStatus: VillagePresenceSnapshot["connectionStatus"];
  predictionError: number;
  serverTimeOffsetMs: number;
}

export interface WorldRenderer {
  destroy(): void;
  focus(): void;
}

interface VillageSceneOptions {
  presence: VillagePresence;
  onSnapshot: (snapshot: WorldSnapshot) => void;
  onReady: (input: MovementInput) => void;
}

function predictedFacing(
  direction: { x: number; y: number },
  current: PublicPlayerPresence["facing"],
): PublicPlayerPresence["facing"] {
  if (direction.x < 0) return "west";
  if (direction.x > 0) return "east";
  return current;
}

class VillageScene extends Phaser.Scene {
  readonly #options: VillageSceneOptions;
  readonly #characters = new Map<string, ManifestCharacterRenderer>();
  readonly #remoteMovement = new Map<string, RemoteInterpolator>();
  readonly #serverClock = new ServerTimeEstimator();
  #input?: MovementInput;
  #unsubscribePresence?: () => void;
  #indicator?: Phaser.GameObjects.Container;
  #movement?: MovementSynchronizer;
  #latestPresence?: VillagePresenceSnapshot;
  #predictionError = 0;
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
        villageMap.width * villageMap.tilewidth,
        villageMap.height * villageMap.tileheight,
      )
      .setZoom(2)
      .setRoundPixels(true);

    this.#input = new MovementInput(this.game.canvas);
    this.#options.onReady(this.#input);
    this.#input.focus();
    this.#unsubscribePresence = this.#options.presence.subscribe((snapshot) => {
      this.#applyPresence(snapshot);
    });
  }

  override update(time: number, delta: number): void {
    if (!this.#input) return;
    const direction = this.#input.direction();
    if (this.#movement) {
      for (const intention of this.#movement.advance(direction, delta)) {
        this.#options.presence.sendMovement(intention);
      }
      const localId = this.#latestPresence?.localEntityId;
      const localCharacter = localId
        ? this.#characters.get(localId)
        : undefined;
      const localPlayer = this.#latestPresence?.players.find(
        (player) => player.entityId === localId,
      );
      if (localCharacter && localPlayer) {
        const predicted = this.#movement.position;
        const presentation = {
          ...localPlayer,
          ...predicted,
          facing: predictedFacing(direction, localPlayer.facing),
          animation:
            direction.x === 0 && direction.y === 0
              ? ("idle" as const)
              : ("walk" as const),
        };
        localCharacter.applyFacing(presentation.facing);
        localCharacter.play(presentation.animation);
        localCharacter.setFootPosition(predicted.x, predicted.y);
        this.#publishSnapshot(
          presentation,
          this.#latestPresence?.players.length ?? 0,
        );
      }
    }
    const renderServerTime = this.#serverClock.serverTimeAt(Date.now()) - 100;
    for (const [entityId, interpolator] of this.#remoteMovement) {
      const position = interpolator.sample(renderServerTime);
      if (position) {
        this.#characters.get(entityId)?.setFootPosition(position.x, position.y);
      }
    }
    for (const character of this.#characters.values()) character.update(time);
  }

  #applyPresence(snapshot: VillagePresenceSnapshot): void {
    this.#latestPresence = snapshot;
    this.#serverClock.observe(snapshot.serverTimeMs, Date.now());
    const currentIds = new Set(
      snapshot.players.map((player) => player.entityId),
    );
    for (const [entityId, character] of this.#characters) {
      if (currentIds.has(entityId)) continue;
      character.display.destroy(true);
      this.#characters.delete(entityId);
      this.#remoteMovement.delete(entityId);
    }

    for (const player of snapshot.players) {
      let character = this.#characters.get(player.entityId);
      if (!character) {
        character = new ManifestCharacterRenderer(
          this,
          player.x,
          player.y,
          player.displayName,
          player.appearance,
        );
        this.#characters.set(player.entityId, character);
        if (player.entityId === snapshot.localEntityId) {
          this.cameras.main.startFollow(character.display, true, 0.18, 0.18);
        }
      }
      character.applyFacing(player.facing);
      character.play(player.animation);
      if (player.entityId === snapshot.localEntityId) {
        if (!this.#movement) {
          this.#movement = new MovementSynchronizer({
            initialPosition: player,
            fixedStepMs: PLAYER_MOVEMENT.fixedStepMs,
            correctionTolerance: 1.5,
            integrate: (position, direction, elapsedMs) => {
              return moveCharacterFoot({
                footPosition: position,
                direction,
                speed: PLAYER_MOVEMENT.speed,
                elapsedMs,
                collision: villageCharacter.collision,
                world: villageMap.movement,
              });
            },
          });
        }
        const reconciliation = snapshot.localMovement
          ? this.#movement.reconcile(snapshot.localMovement)
          : { corrected: false, error: 0 };
        this.#predictionError = reconciliation.error;
        const predicted = this.#movement.position;
        character.setFootPosition(predicted.x, predicted.y);
      } else {
        let interpolator = this.#remoteMovement.get(player.entityId);
        if (!interpolator) {
          interpolator = new RemoteInterpolator();
          this.#remoteMovement.set(player.entityId, interpolator);
        }
        interpolator.push(player, snapshot.serverTimeMs);
      }
    }

    this.game.canvas.dataset.publicPlayerCount = String(this.#characters.size);
    this.game.canvas.dataset.publicPlayerNames = JSON.stringify(
      snapshot.players.map((player) => player.displayName).sort(),
    );
    const local = snapshot.players.find(
      (player) => player.entityId === snapshot.localEntityId,
    );
    if (local) this.#publishSnapshot(local, snapshot.players.length);
  }

  #publishSnapshot(local: PublicPlayerPresence, playerCount: number): void {
    const hint = villageMap.interactionHints[0];
    const nearHint =
      hint !== undefined &&
      Math.hypot(local.x - hint.x, local.y - hint.y) <= 46;
    this.#indicator?.setVisible(nearHint);
    const snapshot: WorldSnapshot = {
      x: local.x,
      y: local.y,
      facing: local.facing,
      state: local.animation,
      interaction: nearHint && hint ? hint.label : null,
      publicPlayerCount: playerCount,
      connectionStatus: this.#latestPresence?.connectionStatus ?? "connected",
      predictionError: this.#predictionError,
      serverTimeOffsetMs: this.#serverClock.offsetMs,
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
    this.#unsubscribePresence?.();
    this.#input?.destroy();
    this.#characters.clear();
  }
}

export function createWorldRenderer(
  parent: HTMLElement,
  presence: VillagePresence,
  onSnapshot: (snapshot: WorldSnapshot) => void,
): WorldRenderer {
  let movementInput: MovementInput | undefined;
  const scene = new VillageScene({
    presence,
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
