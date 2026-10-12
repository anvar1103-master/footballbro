// Global tuning constants. Units: metres, seconds, kilograms, radians.
// Coordinate system: x = pitch length (goals at x = ±length/2), z = pitch width, y = up.

export type TeamSize = 5 | 7 | 11;

export const SIM_DT = 1 / 120;

export const BALL = {
  radius: 0.11,
  gravity: 9.81,
  /** quadratic air drag: a = dragK * |v| * v  (0.5*rho*Cd*A/m) */
  dragK: 0.0125,
  /** Magnus acceleration: a = magnusK * (spin x v). Drives finesse curl and topspin dip. */
  magnusK: 0.0052,
  /** spin decay per second in the air */
  airSpinDecay: 0.35,
  restitution: 0.62,
  /** rolling deceleration on grass: a = rollC + rollLin * |v| */
  rollC: 1.05,
  rollLin: 0.075,
  postRadius: 0.06,
  postRestitution: 0.72,
  /** soft goal-net spring/damping (critically damped: ~0.7 m bulge at 18 m/s, ~1.1 m at 30 m/s) */
  netK: 90,
  netC: 19,
};

export const PLAYER = {
  jogSpeed: 5.6,
  sprintSpeed: 8.2,
  dribbleSpeedMul: 0.9,
  accel: 13,
  decel: 20,
  turnRate: 14,
  controlRadius: 0.95,
  gkControlRadius: 1.25,
  kickReach: 1.35,
  bodyRadius: 0.38,
  /** visual scale applied to the Kenney mini character (0.55 m tall chibi model -> ~1.45 m) */
  modelScale: 2.65,
};

export interface FieldDims {
  length: number;
  width: number;
  goalHalfW: number;
  goalH: number;
  /** depth of the net roof behind the line */
  goalDepthTop: number;
  /** depth of the net at ground level */
  goalDepthBottom: number;
  boxDepth: number;
  boxHalfW: number;
  smallBoxDepth: number;
  smallBoxHalfW: number;
  penaltySpot: number;
  centerRadius: number;
  /** distance from touch/goal lines to advertising boards */
  boardMargin: number;
}

export function fieldFor(size: TeamSize): FieldDims {
  const base = {
    goalHalfW: 3.66,
    goalH: 2.44,
    goalDepthTop: 1.6,
    goalDepthBottom: 2.4,
    boardMargin: 5,
  };
  if (size === 11)
    return { ...base, length: 105, width: 68, boxDepth: 16.5, boxHalfW: 20.15, smallBoxDepth: 5.5, smallBoxHalfW: 9.16, penaltySpot: 11, centerRadius: 9.15 };
  if (size === 7)
    return { ...base, length: 78, width: 50, boxDepth: 13, boxHalfW: 15, smallBoxDepth: 5, smallBoxHalfW: 8, penaltySpot: 9, centerRadius: 7 };
  return { ...base, length: 58, width: 38, boxDepth: 10, boxHalfW: 11, smallBoxDepth: 4, smallBoxHalfW: 6.5, penaltySpot: 7.5, centerRadius: 5.5 };
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export const DIFFICULTY: Record<Difficulty, { aiSkill: number; reaction: number; gk: number }> = {
  easy: { aiSkill: 0.6, reaction: 0.35, gk: 0.6 },
  normal: { aiSkill: 0.8, reaction: 0.22, gk: 0.78 },
  hard: { aiSkill: 0.95, reaction: 0.12, gk: 0.9 },
};
