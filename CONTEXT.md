# Gameish

Browser-first, 2D side-view multiplayer action RPG. Single context; server-authoritative simulation with durable character progression.

## Language

### Quest progression

**Quest Snapshot**:
A character's current durable state of one quest: status, progress, applied objective events, and revision.

**Quest Status**:
The lifecycle position of a quest for one character: `available`, `active`, `ready`, or `completed`. Transitions move strictly forward.

**Quest Transition**:
A requested change to a Quest Snapshot — accept, objective progress, or complete. A transition either applies or is rejected with a reason; it never partially applies.
_Avoid_: quest update, quest mutation

**Quest Transition Decider**:
The single rule that judges a Quest Transition against a Quest Snapshot and yields the next snapshot or a rejection. There is exactly one decider; persistence adapters apply its decision, never re-derive it.
_Avoid_: quest state machine (historically implied two parallel implementations)

**Objective Event**:
A uniquely identified gameplay occurrence (e.g. a qualifying kill) that advances a quest objective. Each event applies at most once per character per quest.

**Completion Id**:
The deterministic identifier of one character completing one quest, making completion replay-safe. Required for every complete transition.
_Avoid_: action id (combat's replay-dedup concept)

### Equipment rules

**Equipment Snapshot**:
A character's current durable equipment state: character revision, appearance revision, appearance (rig/base/armor layer), inventory, and equipped items.

**Equip Decision** / **Unequip Decision**:
The result of judging a requested equip or unequip against an Equipment Snapshot: either it applies, yielding the next snapshot, or it is rejected with a reason (`stale_revision`, `item_not_owned`, `incompatible_item`, `requirements_not_met`, `already_equipped`, `not_equipped`). Never partially applies.

**Equipment Rules Module**:
The single decider (`decideEquip`/`decideUnequip`) that judges every Equip Decision and Unequip Decision. There is exactly one; persistence adapters apply its decision, never re-derive it.
_Avoid_: equipment validation (historically implied per-adapter copies)

**Equipment Rules Context**:
The character facts a decision needs beyond the snapshot and the request — class id and level. Read from storage by the adapter, interpreted only by the Equipment Rules Module.

**Requirements**:
An item's equip gate (minimum level and/or required class), declared once on the item in the equipment catalog. Never re-derived or hardcoded by a persistence adapter.
