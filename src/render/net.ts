import * as THREE from 'three';
import { BALL, FieldDims } from '../sim/config';

/**
 * Goal net as a Verlet cloth (visual only). Every frame the ball pushes particles out of its
 * sphere; the soft-net force in the simulation makes the ball itself decelerate, so the
 * bulge the cloth shows is exactly where the ball is. Ripples propagate through the
 * distance constraints. Drawn as LineSegments (the net mesh).
 */

interface Panel {
  cols: number;
  rows: number;
  start: number; // particle offset
}

const SPACING = 0.16;

export class GoalNet {
  pos: Float32Array;
  prev: Float32Array;
  rest: Float32Array;
  pinned: Uint8Array;
  constraints: number[] = []; // pairs i, j
  restLen: number[] = [];
  lines: THREE.LineSegments;
  awake = 2;
  private n = 0;
  private panels: Panel[] = [];
  private lastBall = new THREE.Vector3(1e9, 0, 0);

  constructor(public f: FieldDims, public dir: number) {
    const pts: number[] = [];
    const pin: number[] = [];
    const x0 = (dir * f.length) / 2;
    const hw = f.goalHalfW + 0.03;
    const H = f.goalH;
    const dt = f.goalDepthTop;
    const db = f.goalDepthBottom;
    const world = (u: number, y: number, z: number) => [x0 + dir * u, y, z];

    // 1) roof + back strip: columns across the width, rows along the profile
    const backLen = Math.hypot(db - dt, H);
    const profLen = dt + backLen;
    const cols = Math.round((2 * hw) / SPACING) + 1;
    const rows = Math.round(profLen / SPACING) + 1;
    const p0 = 0;
    for (let r = 0; r < rows; r++) {
      const s = (r / (rows - 1)) * profLen;
      let u: number, y: number;
      if (s <= dt) {
        u = s;
        y = H;
      } else {
        const k = (s - dt) / backLen;
        u = dt + (db - dt) * k;
        y = H * (1 - k);
      }
      for (let c = 0; c < cols; c++) {
        const z = -hw + (c / (cols - 1)) * 2 * hw;
        pts.push(...world(u, y, z));
        pin.push(r === 0 || r === rows - 1 || c === 0 || c === cols - 1 ? 1 : 0);
      }
    }
    this.panels.push({ cols, rows, start: p0 });

    // 2) side panels: rows by height, columns by depth (scaled per row to the panel outline)
    for (const side of [-1, 1]) {
      const start = pts.length / 3;
      const sRows = Math.round(H / SPACING) + 1;
      const sCols = Math.round(db / SPACING) + 1;
      for (let r = 0; r < sRows; r++) {
        const y = H * (1 - r / (sRows - 1));
        const uMax = dt + (db - dt) * (1 - y / H);
        for (let c = 0; c < sCols; c++) {
          const u = (c / (sCols - 1)) * uMax;
          pts.push(...world(u, y, side * hw));
          pin.push(r === 0 || r === sRows - 1 || c === 0 || c === sCols - 1 ? 1 : 0);
        }
      }
      this.panels.push({ cols: sCols, rows: sRows, start });
    }

    this.n = pts.length / 3;
    this.pos = new Float32Array(pts);
    this.prev = new Float32Array(pts);
    this.rest = new Float32Array(pts);
    this.pinned = new Uint8Array(pin);

    const idx: number[] = [];
    for (const p of this.panels) {
      for (let r = 0; r < p.rows; r++) {
        for (let c = 0; c < p.cols; c++) {
          const i = p.start + r * p.cols + c;
          if (c + 1 < p.cols) this.addC(i, i + 1, idx);
          if (r + 1 < p.rows) this.addC(i, i + p.cols, idx);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setIndex(idx);
    const mat = new THREE.LineBasicMaterial({ color: 0xf4f7ff, transparent: true, opacity: 0.8 });
    this.lines = new THREE.LineSegments(geo, mat);
    this.lines.frustumCulled = false;
  }

  private addC(i: number, j: number, idx: number[]) {
    const p = this.pos;
    this.constraints.push(i, j);
    this.restLen.push(Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]));
    idx.push(i, j);
  }

  reset() {
    this.pos.set(this.rest);
    this.prev.set(this.rest);
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Advance the cloth. `ball` is the current rendered ball centre. */
  update(dt: number, ball: THREE.Vector3, time: number) {
    const f = this.f;
    const x0 = (this.dir * f.length) / 2;
    const near = Math.abs(ball.x - x0) < f.goalDepthBottom + 1.2 && Math.abs(ball.z) < f.goalHalfW + 1.2 && ball.y < f.goalH + 1.2;
    if (near) this.awake = 2.5;
    if (this.awake <= 0) {
      this.lastBall.copy(ball);
      return;
    }
    this.awake -= dt;
    const sub = 3;
    const h = Math.min(dt, 1 / 30) / sub;
    const p = this.pos, q = this.prev, rest = this.rest;
    const R = BALL.radius * 1.25 + 0.05;
    const from = this.lastBall.x > 1e8 ? ball.clone() : this.lastBall.clone();
    const tmp = new THREE.Vector3();
    for (let s = 0; s < sub; s++) {
      // verlet + gentle pull back to rest shape (net tension) + breeze
      const breeze = Math.sin(time * 1.3 + s) * 0.02;
      for (let i = 0; i < this.n; i++) {
        if (this.pinned[i]) continue;
        const k = i * 3;
        for (let a = 0; a < 3; a++) {
          const cur = p[k + a];
          let v = (cur - q[k + a]) * 0.965;
          let acc = (rest[k + a] - cur) * 30;
          if (a === 1) acc -= 1.2;
          if (a === 0) acc += breeze * this.dir;
          q[k + a] = cur;
          p[k + a] = cur + v + acc * h * h;
        }
      }
      // ball collision (interpolated along this frame's ball path)
      tmp.lerpVectors(from, ball, (s + 1) / sub);
      if (near) {
        for (let i = 0; i < this.n; i++) {
          if (this.pinned[i]) continue;
          const k = i * 3;
          const dx = p[k] - tmp.x, dy = p[k + 1] - tmp.y, dz = p[k + 2] - tmp.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < R * R && d2 > 1e-8) {
            const d = Math.sqrt(d2);
            const push = (R - d) / d;
            p[k] += dx * push;
            p[k + 1] += dy * push;
            p[k + 2] += dz * push;
          }
        }
      }
      // distance constraints (slightly stretchy)
      const c = this.constraints;
      for (let it = 0; it < 4; it++) {
        for (let ci = 0, li = 0; ci < c.length; ci += 2, li++) {
          const i = c[ci] * 3, j = c[ci + 1] * 3;
          const dx = p[j] - p[i], dy = p[j + 1] - p[i + 1], dz = p[j + 2] - p[i + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          const L = this.restLen[li];
          if (d < L) continue; // nets only resist stretching
          const diff = ((d - L) / d) * 0.5;
          const pi = this.pinned[c[ci]], pj = this.pinned[c[ci + 1]];
          const wi = pi ? 0 : pj ? 1 : 0.5;
          const wj = pj ? 0 : pi ? 1 : 0.5;
          p[i] += dx * diff * 2 * wi;
          p[i + 1] += dy * diff * 2 * wi;
          p[i + 2] += dz * diff * 2 * wi;
          p[j] -= dx * diff * 2 * wj;
          p[j + 1] -= dy * diff * 2 * wj;
          p[j + 2] -= dz * diff * 2 * wj;
        }
      }
      // never below the grass
      for (let i = 0; i < this.n; i++) if (p[i * 3 + 1] < 0.01) p[i * 3 + 1] = 0.01;
    }
    this.lastBall.copy(ball);
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
