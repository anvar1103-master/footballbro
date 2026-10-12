import { Vector3 } from 'three';
import type { Match } from '../sim/match';

/**
 * Render-side snapshot of the game. The renderer only ever reads FrameViews, so live play
 * and goal replays (recorded FrameViews) go through the same drawing code.
 */
export interface PlayerView {
  id: number;
  team: number;
  model: number;
  role: string;
  x: number;
  z: number;
  fx: number;
  fz: number;
  anim: string;
  speed: number;
  actionT: number;
  actionDur: number;
  diveH: number;
  /** +1 dive to the model's right side, -1 left */
  diveSide: number;
}

export interface FrameView {
  t: number;
  ball: Vector3;
  ballVel: Vector3;
  ballSpin: Vector3;
  players: PlayerView[];
}

export function captureFrame(m: Match): FrameView {
  return {
    t: m.time,
    ball: m.ball.pos.clone(),
    ballVel: m.ball.vel.clone(),
    ballSpin: m.ball.spin.clone(),
    players: m.players.map((p) => {
      let diveSide = 0;
      if (p.action === 'dive') {
        const dx = p.actionTarget.x - p.actionDir.x, dz = p.actionTarget.z - p.actionDir.z;
        diveSide = Math.sign(dx * p.face.z - dz * p.face.x) || 1;
      }
      return {
        id: p.id,
        team: p.team,
        model: p.model,
        role: p.role,
        x: p.pos.x,
        z: p.pos.z,
        fx: p.face.x,
        fz: p.face.z,
        anim: p.anim,
        speed: p.speed,
        actionT: p.actionT,
        actionDur: p.actionDur,
        diveH: p.diveHeight,
        diveSide,
      };
    }),
  };
}

/** Ring buffer of recent frames for goal replays. */
export class ReplayBuffer {
  frames: FrameView[] = [];
  constructor(public seconds = 7) {}
  push(f: FrameView) {
    this.frames.push(f);
    const cutoff = f.t - this.seconds;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
  }
  clear() {
    this.frames.length = 0;
  }
  /** frame at time t (nearest) */
  at(t: number): FrameView | null {
    const fr = this.frames;
    if (!fr.length) return null;
    let lo = 0, hi = fr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fr[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return fr[lo];
  }
}
