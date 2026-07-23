import { useEffect, useRef, useState } from "react";

import type { ClientMapArtifact } from "@gameish/content";
import type { MapOverviewMessage } from "@gameish/protocol";

interface LocalPosition {
  x: number;
  y: number;
}

function clampPercent(value: number, minimum: number, maximum: number): number {
  if (maximum <= minimum) return 50;
  return Math.max(
    0,
    Math.min(100, ((value - minimum) / (maximum - minimum)) * 100),
  );
}

export function MapPanel({
  currentMap,
  currentMapName,
  overview,
  localPosition,
  onClose,
}: {
  currentMap: ClientMapArtifact;
  currentMapName: string;
  overview: MapOverviewMessage | undefined;
  localPosition: LocalPosition | undefined;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<"local" | "world">("local");
  const [textScale, setTextScale] = useState(1);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const firstFocusable =
      dialog.querySelector<HTMLElement>("[data-map-focus]");
    (firstFocusable ?? dialog).focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled)",
        ),
      ];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      if (dialog.open) dialog.close();
    };
  }, []);

  const bounds = currentMap.movement.bounds;
  const points = [
    ...currentMap.portalHints.map((point) => ({
      kind: "Portal",
      label: point.label,
      x: point.x,
      y: point.y,
    })),
    ...currentMap.interactionHints.map((point) => ({
      kind: "Interaction",
      label: point.label,
      x: point.x,
      y: point.y,
    })),
  ];
  const displayNameById = new Map(
    (overview?.locations ?? []).map((location) => [
      location.logicalMapId,
      location.displayName,
    ]),
  );

  return (
    <dialog
      ref={dialogRef}
      className="map-dialog"
      aria-labelledby="map-heading"
      aria-modal="true"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{ "--map-scale": textScale } as React.CSSProperties}
    >
      <div className="map-dialog-heading">
        <div>
          <p className="eyebrow">Map</p>
          <h2 id="map-heading">
            {view === "local" ? "Local map" : "World map"}
          </h2>
        </div>
        <button type="button" onClick={onClose} data-map-focus>
          Close
        </button>
      </div>

      <div className="map-tabs" role="tablist" aria-label="Map views">
        <button
          type="button"
          role="tab"
          aria-selected={view === "local"}
          data-map-focus
          onClick={() => setView("local")}
        >
          Local map
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "world"}
          onClick={() => setView("world")}
        >
          World map
        </button>
      </div>

      {view === "local" ? (
        <section
          className="map-view"
          role="tabpanel"
          aria-labelledby="map-heading"
        >
          <p>
            {currentMapName}. Your position is shown as <strong>You</strong>.
          </p>
          <div
            className="local-map-visual"
            role="img"
            aria-label={`Named points in ${currentMapName}`}
          >
            {localPosition ? (
              <span
                className="local-map-player"
                style={{
                  left: `${clampPercent(localPosition.x, bounds.x, bounds.x + bounds.width)}%`,
                  top: `${clampPercent(localPosition.y, bounds.y, bounds.y + bounds.height)}%`,
                }}
              >
                You
              </span>
            ) : null}
            {points.map((point, index) => (
              <span
                className="local-map-point"
                key={`${point.kind}-${point.label}-${index}`}
                style={{
                  left: `${clampPercent(point.x, bounds.x, bounds.x + bounds.width)}%`,
                  top: `${clampPercent(point.y, bounds.y, bounds.y + bounds.height)}%`,
                }}
              >
                {point.label}
              </span>
            ))}
          </div>
          {points.length > 0 ? (
            <ul className="map-points" aria-label="Named local points">
              {points.map((point, index) => (
                <li key={`${point.kind}-${point.label}-${index}`}>
                  <strong>{point.kind}:</strong> {point.label}
                </li>
              ))}
            </ul>
          ) : (
            <p>No named points in this area.</p>
          )}
        </section>
      ) : (
        <section
          className="map-view"
          role="tabpanel"
          aria-labelledby="map-heading"
        >
          {overview ? (
            <>
              {overview.guidance ? (
                <p className="map-guidance" role="status">
                  Guidance: {overview.guidance.label}
                </p>
              ) : null}
              <h3>Locations</h3>
              <ul className="world-map-list">
                {overview.locations.map((location) => (
                  <li key={location.logicalMapId}>
                    <strong>{location.displayName}</strong> —{" "}
                    {location.discovered ? "Discovered" : "Not discovered"};{" "}
                    {location.accessible ? "Available" : "Unavailable"}
                  </li>
                ))}
              </ul>
              <h3>Connections</h3>
              {overview.connections.length > 0 ? (
                <ul className="world-map-list">
                  {overview.connections.map((connection, index) => {
                    const from = displayNameById.get(connection.fromMapId);
                    const to = displayNameById.get(connection.toMapId);
                    if (!from || !to) return null;
                    return (
                      <li
                        key={`${connection.fromMapId}-${connection.toMapId}-${index}`}
                      >
                        {from} to {to}: {connection.label}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p>No available connections.</p>
              )}
              <h3>Recommendations</h3>
              {overview.recommendations.length > 0 ? (
                <ul className="world-map-list">
                  {overview.recommendations.map((recommendation) => (
                    <li
                      key={`${recommendation.logicalMapId}-${recommendation.reason}`}
                    >
                      {recommendation.displayName} —{" "}
                      {recommendation.reason === "quest"
                        ? "Quest guidance"
                        : "Unexplored nearby area"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No recommendations right now.</p>
              )}
            </>
          ) : (
            <p role="status">Loading world map…</p>
          )}
        </section>
      )}

      <label className="map-scale-control">
        Map text size
        <input
          aria-label="Map text scale"
          type="range"
          min="1"
          max="1.75"
          step="0.05"
          value={textScale}
          onChange={(event) => setTextScale(Number(event.currentTarget.value))}
        />
      </label>
    </dialog>
  );
}
