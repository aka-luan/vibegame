const movementBindings = {
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
} as const;

type MovementBinding = (typeof movementBindings)[keyof typeof movementBindings];

export interface MovementDirection {
  x: number;
  y: number;
}

export function normalizeMovementDirection(
  direction: MovementDirection,
): MovementDirection {
  const magnitude = Math.hypot(direction.x, direction.y);
  if (magnitude === 0 || magnitude <= 1) return direction;
  return {
    x: direction.x / magnitude,
    y: direction.y / magnitude,
  };
}

export class MovementInput {
  readonly #pressed = new Set<MovementBinding>();
  readonly #canvas: HTMLCanvasElement;
  #basicAttackRequested = false;
  #interactionRequested = false;
  readonly #abilityRequests = new Set<1 | 2 | 3 | 4>();

  readonly #handleKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Digit1") {
      event.preventDefault();
      this.#basicAttackRequested = true;
      return;
    }
    if (event.code === "KeyE") {
      event.preventDefault();
      this.#interactionRequested = true;
      return;
    }
    const abilitySlot = {
      Digit2: 1,
      Digit3: 2,
      Digit4: 3,
      Digit5: 4,
    }[event.code] as 1 | 2 | 3 | 4 | undefined;
    if (abilitySlot) {
      event.preventDefault();
      this.#abilityRequests.add(abilitySlot);
      return;
    }
    const binding =
      movementBindings[event.code as keyof typeof movementBindings];
    if (!binding) return;
    event.preventDefault();
    this.#pressed.add(binding);
  };

  readonly #handleKeyUp = (event: KeyboardEvent) => {
    const binding =
      movementBindings[event.code as keyof typeof movementBindings];
    if (!binding) return;
    event.preventDefault();
    this.#pressed.delete(binding);
  };

  readonly #clear = () => {
    this.#pressed.clear();
    this.#abilityRequests.clear();
    this.#basicAttackRequested = false;
    this.#interactionRequested = false;
  };

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      "Village world. Use WASD or arrow keys to move.",
    );
    canvas.addEventListener("keydown", this.#handleKeyDown);
    window.addEventListener("keyup", this.#handleKeyUp);
    canvas.addEventListener("blur", this.#clear);
  }

  direction(): MovementDirection {
    return normalizeMovementDirection({
      x: Number(this.#pressed.has("right")) - Number(this.#pressed.has("left")),
      y: Number(this.#pressed.has("down")) - Number(this.#pressed.has("up")),
    });
  }

  consumeBasicAttack(): boolean {
    const requested = this.#basicAttackRequested;
    this.#basicAttackRequested = false;
    return requested;
  }

  consumeInteraction(): boolean {
    const requested = this.#interactionRequested;
    this.#interactionRequested = false;
    return requested;
  }

  consumeAbility(slot: 1 | 2 | 3 | 4): boolean {
    if (!this.#abilityRequests.has(slot)) return false;
    this.#abilityRequests.delete(slot);
    return true;
  }

  focus(): void {
    this.#canvas.focus({ preventScroll: true });
  }

  destroy(): void {
    this.#canvas.removeEventListener("keydown", this.#handleKeyDown);
    window.removeEventListener("keyup", this.#handleKeyUp);
    this.#canvas.removeEventListener("blur", this.#clear);
  }
}
