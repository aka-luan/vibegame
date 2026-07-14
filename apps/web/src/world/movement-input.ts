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

export class MovementInput {
  readonly #pressed = new Set<MovementBinding>();
  readonly #canvas: HTMLCanvasElement;

  readonly #handleKeyDown = (event: KeyboardEvent) => {
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

  direction(): { x: number; y: number } {
    return {
      x: Number(this.#pressed.has("right")) - Number(this.#pressed.has("left")),
      y: Number(this.#pressed.has("down")) - Number(this.#pressed.has("up")),
    };
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
