import { useEffect, useRef, useState } from "react";

import {
  createWorldRenderer,
  type WorldRenderer,
  type WorldSnapshot,
} from "../world/create-world-renderer.js";

const initialSnapshot: WorldSnapshot = {
  x: 128,
  y: 224,
  facing: "south",
  state: "idle",
  interaction: null,
};

export function App({ worldRoot }: { worldRoot: HTMLElement }) {
  const renderer = useRef<WorldRenderer | null>(null);
  const [snapshot, setSnapshot] = useState(initialSnapshot);

  useEffect(() => {
    renderer.current = createWorldRenderer(worldRoot, setSnapshot);
    return () => {
      renderer.current?.destroy();
      renderer.current = null;
    };
  }, [worldRoot]);

  return (
    <aside className="world-panel" aria-labelledby="world-heading">
      <p className="eyebrow">Offline authored world</p>
      <h1 id="world-heading">Village walk test</h1>
      <p className="control-hint">Move with WASD or arrow keys.</p>
      <p className="world-status" aria-live="polite">
        Facing {snapshot.facing}; {snapshot.state}.
      </p>
      {snapshot.interaction ? (
        <p className="interaction-hint">E — {snapshot.interaction}</p>
      ) : null}
      <button type="button" onClick={() => renderer.current?.focus()}>
        Return to world
      </button>
    </aside>
  );
}
