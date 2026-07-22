import villageCombat from "@gameish/content/village-combat";
import villageDialogue from "@gameish/content/village-dialogue";
import type { ClientMapArtifact } from "@gameish/content";
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
  isTelegraphActive,
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
  map: ClientMapArtifact;
  onSnapshot: (snapshot: WorldSnapshot) => void;
  onReady: (input: MovementInput) => void;
}

interface MonsterDisplay {
  display: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Arc;
  health: Phaser.GameObjects.Rectangle;
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
  readonly #monsterDisplays = new Map<string, MonsterDisplay>();
  readonly #remoteMovement = new Map<string, RemoteInterpolator>();
  readonly #serverClock = new ServerTimeEstimator();
  #input?: MovementInput;
  #unsubscribePresence?: () => void;
  #indicator?: Phaser.GameObjects.Container;
  #telegraph: Phaser.GameObjects.Container | undefined;
  #telegraphEndMs = 0;
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
    const mapArtifact = this.#options.map;
    const background = mapArtifact.layers.find(
      (layer) => layer.name === "background",
    );
    if (background?.type === "imagelayer") {
      this.load.image("village-background", `/assets/${background.image}`);
    }
  }

  create(): void {
    const mapArtifact = this.#options.map;
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
        ...mapArtifact,
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
    const background = mapArtifact.layers.find(
      (layer) => layer.name === "background",
    );
    if (background?.type === "imagelayer") {
      this.add
        .image(
          (mapArtifact.width * mapArtifact.tilewidth) / 2,
          (mapArtifact.height * mapArtifact.tileheight) / 2,
          "village-background",
        )
        .setOrigin(0.5)
        .setDepth(0);
    }
    const layerDepths = new Map([
      ["background", 0],
      ["ground", 1],
      ["below_entities", 2],
      ["entities", 3],
      ["foreground", 6],
      ["effects", 7],
    ]);
    for (const [layerName, depth] of layerDepths) {
      if (layerName === "background" && background?.type === "imagelayer") {
        continue;
      }
      map.createLayer(layerName, tileset, 0, 0)?.setDepth(depth);
    }

    const hint = mapArtifact.interactionHints[0];
    if (hint) {
      const npcBody = this.add
        .rectangle(0, -12, 14, 24, 0x6f87b8)
        .setStrokeStyle(2, 0x17251c);
      const npcName = this.add
        .text(0, -33, villageDialogue.npcs[0]?.displayName ?? "NPC", {
          color: "#fff4b3",
          backgroundColor: "rgb(13 23 17 / 75%)",
          fontFamily: "system-ui, sans-serif",
          fontSize: "7px",
          padding: { x: 2, y: 1 },
        })
        .setOrigin(0.5, 1);
      const marker = this.add
        .circle(0, 3, 9, 0xffe27a, 0.95)
        .setStrokeStyle(2, 0x1b3022);
      const label = this.add
        .text(0, 3, "E", {
          color: "#17251c",
          backgroundColor: "#ffe27a",
          fontFamily: "system-ui, sans-serif",
          fontSize: "10px",
          fontStyle: "bold",
          padding: { x: 3, y: 1 },
        })
        .setOrigin(0.5, 1);
      this.#indicator = this.add
        .container(hint.x, hint.y, [npcBody, npcName, marker, label])
        .setDepth(8);
    }

    this.cameras.main
      .setBounds(
        0,
        0,
        mapArtifact.width * mapArtifact.tilewidth,
        mapArtifact.height * mapArtifact.tileheight,
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
    if (this.#input.consumeInteraction()) {
      const hint = this.#options.map.interactionHints[0];
      const localPlayer = this.#latestPresence?.players.find(
        (player) => player.entityId === this.#latestPresence?.localEntityId,
      );
      if (
        hint &&
        localPlayer &&
        Math.hypot(localPlayer.x - hint.x, localPlayer.y - hint.y) <= 46
      ) {
        this.#options.presence.interact(hint.id);
      }
    }
    if (this.#input.consumeBasicAttack()) {
      this.#options.presence.basicAttack();
    }
    const abilityIds = villageCombat.classes[0]?.abilityIds ?? [];
    for (let slot = 1; slot <= 4; slot += 1) {
      const abilityId = abilityIds[slot - 1];
      if (abilityId && this.#input.consumeAbility(slot as 1 | 2 | 3 | 4)) {
        this.#options.presence.useAbility(abilityId);
      }
    }
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
    if (this.#telegraph) {
      this.#telegraph.setVisible(renderServerTime < this.#telegraphEndMs);
      this.#telegraph.setAlpha(
        renderServerTime < this.#telegraphEndMs
          ? 0.65 + 0.35 * Math.sin(time / 80) ** 2
          : 0,
      );
    }
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
    const estimatedServerTime = this.#serverClock.serverTimeAt(Date.now());
    const currentMonsterIds = new Set(
      snapshot.monsters.map((monster) => monster.entityId),
    );
    for (const [entityId, monsterDisplay] of this.#monsterDisplays) {
      if (currentMonsterIds.has(entityId)) continue;
      monsterDisplay.display.destroy(true);
      this.#monsterDisplays.delete(entityId);
    }
    for (const monster of snapshot.monsters) {
      let monsterDisplay = this.#monsterDisplays.get(monster.entityId);
      if (!monsterDisplay) {
        const body = this.add
          .circle(0, 0, 12, 0x7ca65b)
          .setStrokeStyle(2, 0x17251c)
          .setInteractive({ useHandCursor: true });
        const label = this.add
          .text(0, -28, monster.displayName, {
            color: "#fff4b3",
            backgroundColor: "rgb(13 23 17 / 75%)",
            fontFamily: "system-ui, sans-serif",
            fontSize: "7px",
            padding: { x: 2, y: 1 },
          })
          .setOrigin(0.5, 1);
        const healthBackground = this.add.rectangle(0, -19, 30, 4, 0x17251c);
        const health = this.add.rectangle(0, -19, 28, 2, 0xe46d5c);
        const display = this.add.container(monster.x, monster.y, [
          body,
          healthBackground,
          health,
          label,
        ]);
        body.on("pointerdown", () => {
          this.#options.presence.selectTarget(monster.entityId);
        });
        monsterDisplay = { display, body, health };
        this.#monsterDisplays.set(monster.entityId, monsterDisplay);
      }
      monsterDisplay.display.setPosition(monster.x, monster.y);
      monsterDisplay.display.setDepth(4 + monster.y / 1_000);
      monsterDisplay.body.setFillStyle(
        snapshot.selectedTargetEntityId === monster.entityId
          ? 0xffc857
          : 0x7ca65b,
      );
      monsterDisplay.health.scaleX = Math.max(0, monster.healthFraction);
      monsterDisplay.display.setAlpha(
        monster.animation === "defeated" ? 0.45 : 1,
      );
    }
    const telegraph = snapshot.telegraphs.find(
      (candidate) =>
        candidate.entityId === snapshot.monsters[0]?.entityId &&
        isTelegraphActive(candidate, estimatedServerTime),
    );
    if (telegraph) {
      const monster = snapshot.monsters.find(
        (candidate) => candidate.entityId === telegraph.entityId,
      );
      if (monster) {
        if (!this.#telegraph) {
          const ring = this.add
            .circle(0, 0, 24, 0xe46d5c, 0.15)
            .setStrokeStyle(3, 0xff8c69);
          const label = this.add
            .text(0, -34, "TELEGRAPH", {
              color: "#fff4b3",
              backgroundColor: "#7f3029",
              fontFamily: "system-ui, sans-serif",
              fontSize: "7px",
              fontStyle: "bold",
              padding: { x: 2, y: 1 },
            })
            .setOrigin(0.5, 1);
          this.#telegraph = this.add.container(monster.x, monster.y, [
            ring,
            label,
          ]);
          this.#telegraph.setDepth(5);
        }
        this.#telegraph.setPosition(monster.x, monster.y);
        this.#telegraphEndMs = telegraph.startTimeMs + telegraph.durationMs;
        this.game.canvas.dataset.telegraphActive = "true";
      }
    } else {
      this.#telegraphEndMs = 0;
      this.game.canvas.dataset.telegraphActive = "false";
    }
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
      character.applyAppearance(
        player.entityId === snapshot.localEntityId && snapshot.previewAppearance
          ? snapshot.previewAppearance
          : player.appearance,
      );
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
                world: this.#options.map.movement,
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
    const hint = this.#options.map.interactionHints[0];
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
    for (const monsterDisplay of this.#monsterDisplays.values()) {
      monsterDisplay.display.destroy(true);
    }
    this.#monsterDisplays.clear();
    this.#telegraph?.destroy(true);
    this.#telegraph = undefined;
    this.#characters.clear();
  }
}

export function createWorldRenderer(
  parent: HTMLElement,
  presence: VillagePresence,
  map: ClientMapArtifact,
  onSnapshot: (snapshot: WorldSnapshot) => void,
): WorldRenderer {
  let movementInput: MovementInput | undefined;
  const scene = new VillageScene({
    presence,
    map,
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
      // A portal transition rebuilds the renderer against the destination
      // map, so the outgoing scene must drop its presence subscription
      // here: `game.destroy` does not run the scene's `shutdown`, and a
      // subscription surviving its scene would keep applying snapshots to
      // destroyed Phaser objects.
      scene.shutdown();
      game.destroy(true);
    },
    focus() {
      movementInput?.focus();
    },
  };
}
