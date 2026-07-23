# Placeholder Visual Contract

- Status: Approved working contract for issue
  [#18](https://github.com/aka-luan/vibegame/issues/18)
- Recorded: 2026-07-23
- Applies to: the approved vertical-slice placeholder content only
- Supersedes: nothing

## Purpose

This document keeps the vertical-slice placeholder art coherent, readable, and
replaceable while the final production art direction remains deferred. It
translates the product decisions in `PLAN.md` and the asset boundaries in
ADR-0009 and ADR-0011 into visual and generation constraints.

This is not approval for extra content, another rig, additional facings, or a
permanent production style. Compatible replacement art may change the rendering
style without gameplay-code changes when it continues to satisfy the content
and appearance manifests.

## Approved reference hierarchy

The references are concept and calibration material. They are not production
sprite sheets, equipment layers, map sources, or proof of pixel alignment.

1. [World concept](references/direction-d-world-concept.png) is authoritative
   for the placeholder rendering language, broad palette, environment layering,
   and gameplay-scale simplicity.
2. [Character style study](references/character-style-study.png) is
   authoritative for character proportions, large readable shapes, role
   differentiation, and the relationship between a base body and visible
   armor.
3. [Armor alignment study](references/armor-alignment-study.png) is a
   conceptual breakdown of the armor components. Its panels are not
   pixel-aligned production layers.
4. [Armored character concept](references/armored-character-concept.png) is
   authoritative for the placeholder armor's bronze-brown materials and broad
   component shapes. It is not an extracted armor layer.

When references disagree, the world concept controls rendering style, the
character style study controls proportions, and the more focused armor concept
controls armor design. Manifest requirements and validated technical
constraints always override a concept image.

## Visual direction

The placeholder world uses friendly original fantasy imagery constructed from
large matte painted shapes, limited shading, restrained texture, soft geometric
forms, and strong gameplay-readable silhouettes.

- Prefer broad shapes over surface detail.
- Use one primary shadow family and one restrained highlight family per form.
- Keep texture subtle enough that it does not shimmer or become noise after
  browser scaling.
- Use dark local colors for separation when adjacent shapes merge; do not
  require a uniform black outline.
- Keep important hands, feet, equipment, faces, targets, and effects legible at
  the actual gameplay scale.
- Express originality through a coherent shape vocabulary, symbols,
  architecture, flora, creatures, names, and narrative context rather than
  increased rendering detail.
- Keep the mood welcoming and adventurous rather than grim, photorealistic, or
  visually aggressive.

The placeholder style must not imitate a named artist, protected game, or
recognizable franchise. Protected-game images and screenshots are prohibited
as prompt inputs and repository references.

## Perspective and composition

- Maps are horizontally composed side-view spaces.
- Every map shows a readable shallow walkable ground region that supports
  horizontal traversal plus limited vertical positioning.
- The ground may recede gently to communicate depth, but the result must not
  read as top-down, isometric, or platforming.
- Characters render from a side or three-quarter-side perspective.
- The slice authors east and west facings; west may mirror east.
- Vertical movement retains the current horizontal facing.
- Camera compositions favor horizontal travel. Vertical camera range remains
  small.
- Environment art must support the declared render groups: `background`,
  `ground`, `below_entities`, `entities`, `foreground`, and `effects`.
- Foreground elements must not hide required interactions, target feedback,
  telegraphs, portal cues, or the player's foot origin.
- Entity depth is determined from the declared foot origin, never image bounds.

## Working palette

These colors are a compact working palette derived approximately from the
approved world concept. Production placeholder assets may vary values within
the same families when required for lighting and contrast.

| Role                       | Color     |
| -------------------------- | --------- |
| Parchment and warm plaster | `#F1E5CE` |
| Village ochre              | `#D8A13B` |
| Clay accent                | `#B96B43` |
| Weathered wood             | `#654329` |
| Moss                       | `#71834B` |
| Deep pine                  | `#23473E` |
| Muted teal                 | `#287A78` |
| Bronze armor               | `#9A7046` |
| Deep shadow                | `#263A35` |
| Magic cyan                 | `#72E7D5` |

Village scenes emphasize warm plaster, ochre, clay, and wood. Forest scenes
shift toward moss, pine, bark, stone, and cool atmospheric depth while
retaining shared materials and accents. Friendly characters generally use
warmer accents. Hostile creatures use distinct silhouettes and value groupings,
not merely cooler colors.

Color is never the only carrier of target, quest, interaction, range, danger,
or navigation meaning.

## Canonical character rig

The slice uses exactly one manifest-defined raster rig.

- Target approximately three to four heads in total height.
- Use a large readable head, hands, boots, and equipment regions.
- Keep the feet and declared foot origin visually unambiguous.
- Separate arms from the torso enough to survive animation and equipment
  compositing.
- Keep the base body's proportions, logical canvas, display scale, foot origin,
  timing, and facing stable across every compatible layer.
- Keep collision geometry separate from visible pixels.
- Avoid capes, long scarves, long coat tails, complex hair motion, dangling
  accessories, translucent materials, and other features that multiply
  placeholder animation work.
- Author an east-facing source consistently; use the manifest's facing behavior
  for west rather than creating an undeclared body rig.

The required character animation states are:

```text
idle
walk
attack_basic
ability_1
ability_2
ability_3
ability_4
hit
defeated
```

Generation may establish designs and motion ideas, but the accepted production
frames must be normalized to the canonical rig and validated for canvas,
origin, frame arrangement, timing, facing, attachments, layer order, and
fallback behavior.

## Armor

The slice contains exactly one visible armor set.

- Use the approved bronze-brown material family and broad component shapes.
- Limit the placeholder set to readable chest, shoulder, forearm, waist, and
  knee regions as compatible with the final manifest.
- The production armor is a separate raster layer aligned to the base rig.
- Equipping armor must not change the underlying body pose, proportions,
  animation timing, canvas, scale, or foot origin.
- Armor pieces must preserve the readability of hands, feet, weapon or effect
  attachments, hit feedback, and silhouette.
- The missing-asset fallback must leave a valid base appearance.

The approved concept images do not prove pixel alignment. Production acceptance
requires overlay inspection across every required animation state and a
targeted visual or structural regression check.

## NPC and creature readability

- The quest giver and shopkeeper must differ through silhouette, posture, and
  role-relevant props rather than palette alone.
- Friendly NPC poses should be open and readable without relying on facial
  detail.
- Each of the three regular monster types must differ through primary
  silhouette, proportions, locomotion cues, and attack-reading shapes. Palette
  swaps are insufficient.
- The elite or boss must visibly belong to the forest's creature ecology while
  adding scale and one unique high-contrast identifying feature.
- Hostile silhouettes must read as hostile at gameplay scale. Not every forest
  creature should resemble a pet or companion.
- Creature designs must leave a clear foot or ground-contact origin for depth
  sorting and targeting feedback.

## Village and forest

### Village

- Use warm plaster, ochre roofs, honey-toned wood, clay, and restrained teal
  accents.
- Favor broad readable structures, visible doorways, and natural travel routes.
- Keep signs and role cues symbolic and original; do not depend on generated
  lettering.
- Avoid decorative clutter that competes with characters, interaction markers,
  or portals.

### Forest

- Use layered moss, pine, bark, stone, and cool atmospheric depth.
- Keep the walkable region readable against foreground and background foliage.
- Preserve clear encounter space for multiple players, creatures, telegraphs,
  and personal feedback.
- Transition naturally from the village's warmer materials into the forest's
  cooler palette.
- Do not bake collision, hidden spawns, portal destinations, or server-only
  metadata into client art.

## Icons, markers, and effects

- The five action icons share one frame treatment, scale, lighting convention,
  and level of detail.
- Each action has a distinct central silhouette that remains identifiable
  without color.
- Quest, map, interaction, target, portal, and danger markers differ through
  both shape and color.
- Combat telegraphs prioritize area, timing, and ownership communication before
  decoration.
- Effects use simple silhouettes, limited particles, and restrained texture.
- Reduced-motion and limited-flash variants must remain understandable.
- Magic cyan is an available placeholder accent, not a universal meaning for
  every action.

## Image-generation rules

Image generation is a design and source-production aid, not an exemption from
the asset contract.

Every prompt must identify:

- intended asset or concept role;
- source reference images and their roles;
- side-view or three-quarter-side perspective;
- working palette and rendering constraints;
- actual gameplay-scale readability;
- canvas, facing, pose, and invariants when relevant;
- required subjects only;
- exclusions and originality constraints.

Use separate prompts or edits for distinct assets. Do not treat multiple
variants of one generation as distinct content definitions. For edits, repeat
every invariant: change only the requested element and preserve canvas,
position, scale, pose, origin, palette, lighting, and unaffected pixels.

Use this fixed exclusion block:

```text
No protected-game references, named artists, recognizable franchise designs,
logos, watermarks, generated text, photorealism, pixel-art imitation, top-down
perspective, isometric perspective, platforming, excessive texture, intricate
accessories, or unrequested subjects.
```

Generated concept images do not automatically qualify as production sprites,
aligned equipment layers, animations, map components, transparent assets, or
validated fallbacks. Normalize and inspect accepted outputs before connecting
them to a manifest.

## Provenance and license record

Every accepted concept and production asset must record:

```yaml
assetId: stable.namespaced.id
status: concept | placeholder-production
sourceKind: generated | original-authored | third-party
generator:
model:
generatedAt:
prompt:
inputReferences: []
postProcessing: []
license:
licenseEvidence:
reviewer:
originalityReview:
dimensions:
rigVersion:
frameArrangement:
replacementCompatibility:
sha256:
```

Unknown fields remain explicitly `unknown` or `pending`; they must never be
guessed. Third-party assets require their source and license evidence. Generated
assets record the applicable generation service terms and the repository
owner's confirmation of the generation inputs.

### Current concept references

All four references were supplied by the repository owner after generation with
OpenAI GPT Images on 2026-07-22. The exact underlying model identifier and
service-side generation IDs were not available in the supplied files. No
third-party input image was declared; the prompt briefs prohibited protected
references.

| File                            | Status and role                        | Dimensions       | SHA-256                                                            |
| ------------------------------- | -------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `direction-d-world-concept.png` | Concept; rendering and world reference | 1672 × 941 RGBA  | `6e56e258cbb1ecc901f9548cf6595a56f5b6ef4aa76a7d64d4566c6d074c5fe1` |
| `character-style-study.png`     | Concept; character and role study      | 1448 × 1086 RGBA | `ca39d9907605aa0ca38f48ceb2a4919426d4c6ab4d53a531bc04521a05d43e6c` |
| `armor-alignment-study.png`     | Concept; alignment and component study | 2172 × 724 RGBA  | `9d9e399001fbefcf77177b2a181079e3e8ab03d7332f0bdafbae1e6e2c0691fb` |
| `armored-character-concept.png` | Concept; approved armor appearance     | 1048 × 1501 RGBA | `2be131d0872dcd83fca7363f6921ab6eb7187385916c7c7595d237a8faf404a0` |

For these references:

- `sourceKind`: `generated`
- `generator`: `OpenAI GPT Images`
- `model`: `unknown`
- `license`: use governed by the OpenAI terms applicable to the repository
  owner's generation session; production-use review remains part of issue
  #18's originality and provenance check
- `postProcessing`: unknown; the supplied PNG files are preserved byte-for-byte
  in this repository
- `rigVersion`: not applicable; these are concepts
- `replacementCompatibility`: not applicable until converted into validated
  production assets

## Review checklist

Before accepting a placeholder production asset:

- [ ] It is within issue #18's exact approved inventory.
- [ ] Its stable namespaced ID and manifest references validate.
- [ ] It follows the side-view and shallow-ground-region presentation.
- [ ] It remains readable at the actual gameplay scale.
- [ ] Its canvas, origin, facing, frame arrangement, timing, layers, and
      fallbacks validate where applicable.
- [ ] It communicates interactive or combat meaning through shape as well as
      color.
- [ ] It has a complete provenance and license record.
- [ ] Its prompt and references contain no protected-game material.
- [ ] Its originality has received human review.
- [ ] Replacing it with a compatible asset requires no gameplay-code change.

## Explicit non-goals

- Final production art direction.
- Additional classes, maps, quests, items, monster types, rigs, or facings.
- Skeletal animation or a second character renderer.
- Procedural art or map generation.
- Copied or traced reference material.
- Treating generated concept sheets as production-ready sprite sheets.
