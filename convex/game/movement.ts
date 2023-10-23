import { Doc, Id } from '../_generated/dataModel';
import { movementSpeed } from '../../data/characters';
import { COLLISION_THRESHOLD } from '../constants';
import { Point, Vector } from '../util/types';
import { distance, manhattanDistance, pointsEqual } from '../util/geometry';
import { MinHeap } from '../util/minheap';
import { AiTown } from './aiTown';

type PathCandidate = {
  position: Point;
  facing?: Vector;
  t: number;
  length: number;
  cost: number;
  prev?: PathCandidate;
};

export function stopPlayer(game: AiTown, now: number, playerId: Id<'players'>) {
  const player = game.players.lookup(playerId);
  const location = game.locations.lookup(now, player.locationId);
  delete player.pathfinding;
  location.velocity = 0;
}

export function movePlayer(
  game: AiTown,
  now: number,
  playerId: Id<'players'>,
  destination: Point,
  allowInConversation?: boolean,
) {
  const player = game.players.lookup(playerId);
  const location = game.locations.lookup(now, player.locationId);
  if (Math.floor(destination.x) !== destination.x || Math.floor(destination.y) !== destination.y) {
    throw new Error(`Non-integral destination: ${JSON.stringify(destination)}`);
  }

  const position = { x: location.x, y: location.y };
  // Close enough to current position or destination => no-op.
  if (pointsEqual(position, destination)) {
    return;
  }
  // Don't allow players in a conversation to move.
  const member = game.conversationMembers.find(
    (m) => m.playerId === playerId && m.status.kind === 'participating',
  );
  if (member && !allowInConversation) {
    throw new Error(`Can't move when in a conversation. Leave the conversation first!`);
  }
  player.pathfinding = {
    destination: destination,
    started: now,
    state: {
      kind: 'needsPath',
    },
  };
  return;
}

export function findRoute(game: AiTown, now: number, player: Doc<'players'>, destination: Point) {
  const minDistances: PathCandidate[][] = [];
  const explore = (current: PathCandidate): Array<PathCandidate> => {
    const { x, y } = current.position;
    const neighbors = [];

    // If we're not on a grid point, first try to move horizontally
    // or vertically to a grid point. Note that this can create very small
    // deltas between the current position and the nearest grid point so
    // be careful to preserve the `facing` vectors rather than trying to
    // derive them anew.
    if (x !== Math.floor(x)) {
      neighbors.push(
        { position: { x: Math.floor(x), y }, facing: { dx: -1, dy: 0 } },
        { position: { x: Math.floor(x) + 1, y }, facing: { dx: 1, dy: 0 } },
      );
    }
    if (y !== Math.floor(y)) {
      neighbors.push(
        { position: { x, y: Math.floor(y) }, facing: { dx: 0, dy: -1 } },
        { position: { x, y: Math.floor(y) + 1 }, facing: { dx: 0, dy: 1 } },
      );
    }
    // Otherwise, just move to adjacent grid points.
    if (x == Math.floor(x) && y == Math.floor(y)) {
      neighbors.push(
        { position: { x: x + 1, y }, facing: { dx: 1, dy: 0 } },
        { position: { x: x - 1, y }, facing: { dx: -1, dy: 0 } },
        { position: { x, y: y + 1 }, facing: { dx: 0, dy: 1 } },
        { position: { x, y: y - 1 }, facing: { dx: 0, dy: -1 } },
      );
    }
    const next = [];
    for (const { position, facing } of neighbors) {
      const segmentLength = distance(current.position, position);
      const length = current.length + segmentLength;
      if (blocked(game, now, position, player._id)) {
        continue;
      }
      const remaining = manhattanDistance(position, destination);
      const path = {
        position,
        facing,
        // Movement speed is in tiles per second.
        t: current.t + (segmentLength / movementSpeed) * 1000,
        length,
        cost: length + remaining,
        prev: current,
      };
      const existingMin = minDistances[position.y]?.[position.x];
      if (existingMin && existingMin.cost <= path.cost) {
        continue;
      }
      minDistances[position.y] ??= [];
      minDistances[position.y][position.x] = path;
      next.push(path);
    }
    return next;
  };

  const startingLocation = game.locations.lookup(now, player.locationId);
  const startingPosition = { x: startingLocation.x, y: startingLocation.y };
  let current: PathCandidate | undefined = {
    position: startingPosition,
    facing: { dx: startingLocation.dx, dy: startingLocation.dy },
    t: now,
    length: 0,
    cost: manhattanDistance(startingPosition, destination),
    prev: undefined,
  };
  let bestCandidate = current;
  const minheap = MinHeap<PathCandidate>((p0, p1) => p0.cost > p1.cost);
  while (current) {
    if (pointsEqual(current.position, destination)) {
      break;
    }
    if (
      manhattanDistance(current.position, destination) <
      manhattanDistance(bestCandidate.position, destination)
    ) {
      bestCandidate = current;
    }
    for (const candidate of explore(current)) {
      minheap.push(candidate);
    }
    current = minheap.pop();
  }
  let newDestination = null;
  if (!current) {
    if (bestCandidate.length === 0) {
      return null;
    }
    current = bestCandidate;
    newDestination = current.position;
  }
  const densePath = [];
  let facing = current.facing!;
  while (current) {
    densePath.push({ position: current.position, t: current.t, facing });
    facing = current.facing!;
    current = current.prev;
  }
  densePath.reverse();

  return { path: densePath, newDestination };
}

export function blocked(game: AiTown, now: number, pos: Point, playerId?: Id<'players'>) {
  const otherPositions = game.players
    .allDocuments()
    .filter((p) => p._id !== playerId)
    .map((p) => game.locations.lookup(now, p.locationId));
  return blockedWithPositions(pos, otherPositions, game.map);
}

export function blockedWithPositions(position: Point, otherPositions: Point[], map: Doc<'maps'>) {
  if (isNaN(position.x) || isNaN(position.y)) {
    throw new Error(`NaN position in ${JSON.stringify(position)}`);
  }
  if (position.x < 0 || position.y < 0 || position.x >= map.width || position.y >= map.height) {
    return 'out of bounds';
  }
  if (map.objectTiles[Math.floor(position.y)][Math.floor(position.x)] !== -1) {
    return 'world blocked';
  }
  for (const otherPosition of otherPositions) {
    if (distance(otherPosition, position) < COLLISION_THRESHOLD) {
      return 'player';
    }
  }
  return null;
}