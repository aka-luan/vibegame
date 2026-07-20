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
