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

  readonly #handleKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Digit1") {
      event.preventDefault();
      this.#basicAttackRequested = true;
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

  readonly #clear = () => this.#pressed.clear();

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

  focus(): void {
    this.#canvas.focus({ preventScroll: true });
  }

  destroy(): void {
    this.#canvas.removeEventListener("keydown", this.#handleKeyDown);
    window.removeEventListener("keyup", this.#handleKeyUp);
    this.#canvas.removeEventListener("blur", this.#clear);
  }
}
