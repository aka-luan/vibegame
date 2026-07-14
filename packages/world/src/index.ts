export interface Point {
  x: number;
  y: number;
}

export interface Rectangle extends Point {
  width: number;
  height: number;
}

export interface MovementWorld {
  bounds: Rectangle;
  obstacles: readonly Rectangle[];
}

export interface MovementRequest {
  position: Point;
  direction: Point;
  speed: number;
  elapsedMs: number;
  body: { width: number; height: number };
  world: MovementWorld;
}

function rangesOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): boolean {
  return firstStart < secondEnd && firstEnd > secondStart;
}

function moveOnXAxis(
  position: Point,
  distance: number,
  body: MovementRequest["body"],
  world: MovementWorld,
): number {
  const halfWidth = body.width / 2;
  const halfHeight = body.height / 2;
  const minimum = world.bounds.x + halfWidth;
  const maximum = world.bounds.x + world.bounds.width - halfWidth;
  let target = Math.min(maximum, Math.max(minimum, position.x + distance));

  for (const obstacle of world.obstacles) {
    if (
      !rangesOverlap(
        position.y - halfHeight,
        position.y + halfHeight,
        obstacle.y,
        obstacle.y + obstacle.height,
      )
    ) {
      continue;
    }

    const currentLeft = position.x - halfWidth;
    const currentRight = position.x + halfWidth;
    if (distance > 0 && currentRight <= obstacle.x) {
      target = Math.min(target, obstacle.x - halfWidth);
    } else if (distance < 0 && currentLeft >= obstacle.x + obstacle.width) {
      target = Math.max(target, obstacle.x + obstacle.width + halfWidth);
    }
  }

  return target;
}

function moveOnYAxis(
  position: Point,
  distance: number,
  body: MovementRequest["body"],
  world: MovementWorld,
): number {
  const halfWidth = body.width / 2;
  const halfHeight = body.height / 2;
  const minimum = world.bounds.y + halfHeight;
  const maximum = world.bounds.y + world.bounds.height - halfHeight;
  let target = Math.min(maximum, Math.max(minimum, position.y + distance));

  for (const obstacle of world.obstacles) {
    if (
      !rangesOverlap(
        position.x - halfWidth,
        position.x + halfWidth,
        obstacle.x,
        obstacle.x + obstacle.width,
      )
    ) {
      continue;
    }

    const currentTop = position.y - halfHeight;
    const currentBottom = position.y + halfHeight;
    if (distance > 0 && currentBottom <= obstacle.y) {
      target = Math.min(target, obstacle.y - halfHeight);
    } else if (distance < 0 && currentTop >= obstacle.y + obstacle.height) {
      target = Math.max(target, obstacle.y + obstacle.height + halfHeight);
    }
  }

  return target;
}

function moveBodyStep(request: MovementRequest): Point {
  const directionLength = Math.hypot(request.direction.x, request.direction.y);
  if (directionLength === 0 || request.elapsedMs <= 0 || request.speed <= 0) {
    return { ...request.position };
  }

  const distance = (request.speed * request.elapsedMs) / 1_000;
  const xDistance = (request.direction.x / directionLength) * distance;
  const yDistance = (request.direction.y / directionLength) * distance;
  const x = moveOnXAxis(
    request.position,
    xDistance,
    request.body,
    request.world,
  );
  const y = moveOnYAxis(
    { x, y: request.position.y },
    yDistance,
    request.body,
    request.world,
  );

  return { x, y };
}

export function moveBody(request: MovementRequest): Point {
  if (request.elapsedMs <= 0) return { ...request.position };
  let position = { ...request.position };
  let remainingMs = request.elapsedMs;
  while (remainingMs > 0) {
    const elapsedMs = Math.min(1, remainingMs);
    position = moveBodyStep({ ...request, position, elapsedMs });
    remainingMs -= elapsedMs;
  }
  return position;
}
