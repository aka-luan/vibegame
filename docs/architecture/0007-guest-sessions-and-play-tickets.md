# ADR-0007: Cookie guest sessions and one-time play tickets

- Status: Accepted
- Date: 2026-07-14

## Context

The first session must enter quickly without email or passwords, while room joins must be authenticated without exposing a reusable account credential to browser JavaScript or trusting client-selected character/destination claims.

## Decision

Create browser-bound guest users and opaque sessions. Store only a hash of the session secret server-side and deliver the credential through an `HttpOnly`, `Secure`, `SameSite` cookie. Use same-origin delivery or approved same-site subdomains.

After character selection, issue a short-lived, single-use play ticket bound to user, character, logical destination, content version, expiry, and nonce. Colyseus admission consumes it exactly once. Development login exists only behind an explicit gate that cannot activate in production mode.

Losing the browser guest credential loses access during the slice. Named registration, recovery, and conversion are deferred.

## Consequences

- JavaScript does not need direct access to the durable session credential.
- Room admission uses a narrowly scoped replay-resistant capability.
- Split-origin hosting on unrelated sites is incompatible with the approved cookie flow.
- Guest recovery is intentionally limited and must be communicated honestly.

## Alternatives considered

### Local-storage bearer token

Rejected because JavaScript-accessible long-lived tokens increase the impact of script injection and are unnecessary for the approved same-origin shape.

### Email/password accounts in the slice

Rejected because verification, password reset, abuse controls, privacy handling, and account support expand scope without proving the core game loop.

### Reusing the session cookie directly for room identity

Rejected because a single-use play ticket binds the exact character, destination, version, and expiry while limiting replay and cross-room misuse.

### Unrestricted deterministic development identity

Rejected because any production reachability would bypass authentication. The development path must fail closed.
