import type {
  PublicAppearance as PublicAppearanceState,
  PublicMonsterState,
  PublicPlayerState,
  PublicVillageState,
} from "@gameish/protocol";
import type {
  AssertConforms as Conforms,
  PublicAppearance,
  PublicMonster,
  PublicPlayer,
  VillageState,
} from "./village-room.js";

// Positive: the real schema classes conform to the protocol contract.
export type PublicAppearanceConforms = Conforms<
  PublicAppearance,
  PublicAppearanceState
>;
export type PublicPlayerConforms = Conforms<PublicPlayer, PublicPlayerState>;
export type PublicMonsterConforms = Conforms<PublicMonster, PublicMonsterState>;
export type VillageStateConforms = Conforms<VillageState, PublicVillageState>;

// Negative: a stand-in schema missing a required field must fail to
// conform to the protocol's PublicPlayerState.
declare class Missing {
  displayName: string;
  x: number;
  y: number;
  facing: "east" | "west";
  // `animation` intentionally omitted.
  appearance: PublicAppearanceState;
}
// @ts-expect-error - missing `animation` must fail the conformance check.
export type MissingRejected = Conforms<Missing, PublicPlayerState>;

// Negative: a stand-in schema that retypes a field must fail to conform.
declare class Retyped {
  displayName: string;
  x: number;
  y: number;
  facing: "north" | "south";
  animation: "idle" | "walk";
  appearance: PublicAppearanceState;
}
// @ts-expect-error - `facing` retyped to a disjoint union must fail.
export type RetypedRejected = Conforms<Retyped, PublicPlayerState>;
