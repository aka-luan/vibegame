export interface PortalHint {
  id: string;
  label: string;
  x: number;
  y: number;
}

export interface ActivePortalPrompt {
  portalId: string;
  label: string;
}

/**
 * How close (in world pixels, from a portal's center) the local player must
 * be before the client offers a travel prompt for it. This is purely a UI
 * affordance derived from the client-safe `portalHints` on the current
 * map's client artifact — the server independently re-validates proximity
 * against the authoritative portal rectangle when a transition is actually
 * requested, so a generous client-side radius here cannot let a player
 * transition from somewhere the server would reject.
 */
export const PORTAL_PROMPT_RADIUS = 64;

/**
 * Picks the nearest portal hint within `radius` of the local player's foot
 * position, or `null` if none is close enough. Pure and framework-free so
 * it is unit-testable without a Colyseus connection or a browser.
 */
export function computeActivePortalPrompt(
  portalHints: readonly PortalHint[],
  playerFoot: { x: number; y: number },
  radius: number,
): ActivePortalPrompt | null {
  let nearest: { hint: PortalHint; distance: number } | undefined;
  for (const hint of portalHints) {
    const distance = Math.hypot(playerFoot.x - hint.x, playerFoot.y - hint.y);
    if (distance > radius) continue;
    if (!nearest || distance < nearest.distance) {
      nearest = { hint, distance };
    }
  }
  return nearest
    ? { portalId: nearest.hint.id, label: nearest.hint.label }
    : null;
}
