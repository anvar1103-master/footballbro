import * as THREE from 'three';
import { BALL, FieldDims } from '../sim/config';
import { BALL_VIS_SCALE } from './ball';

/**
 * Goal net as a Verlet cloth (visual only), rendered as a textured mesh with a diamond mesh
 * pattern (alpha-tested, casts real shadows). The net is slightly slack so it hangs and sways;
 * the ball pushes particles out of its sphere, so the bulge sits exactly where the ball is.
 * The soft-net force in the simulation (ball.ts) decelerates the ball itself.
 */

interface Panel {
  cols: number;
  rows: number;
  start: number;
}

const SPACING = 0.2; // simulation grid (m)
const TILE = 0.12; // size of one diamond of the net texture (m)
const SLACK = 1.05; // rest length vs. rigged length: real nets hang loose

let netTexture: THREE.Texture | null = null;
/** (legacy) bitmap net pattern — kept for reference; the shader version below is used. */
export function getNetTexture() {
  if (netTexture) return netTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 9;
  g.lineCap = 'round';
  // two diagonal families -> diamond mesh, drawn with wrap-around so it tiles seamlessly
  for (const o of [-128, 0, 128]) {
    g.beginPath();
    g.moveTo(o, 0);
    g.lineTo(o + 128, 128);
    g.moveTo(o + 128, 0);
    g.lineTo(o, 128);
    g.stroke();
  }
  // knots
  g.fillStyle = '#ffffff';
  for (const [x, y] of [[0, 0], [128, 0], [0, 128], [128, 128], [64, 64]]) {
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  netTexture = t;
  return t;
}

export class GoalNet {
  pos: Float32Array;
  prev: Float32Array;
  rest: Float32Array;
  pinned: Uint8Array;
  constraints: number[] = [];
  restLen: number[] = [];
  mesh: THREE.Mesh;
  awake = 3;
  private n = 0;
  private panels: Panel[] = [];
  private lastBall = new THREE.Vector3(1e9, 0, 0);
  private geo: THREE.BufferGeometry;

  constructor(public f: FieldDims, public dir: number, public ballRadius = BALL.radius * BALL_VIS_SCALE) {
    const pts: number[] = [];
    const uvs: number[] = [];
    const pin: number[] = [];
    const x0 = (dir * f.length) / 2;
    const hw = f.goalHalfW + 0.04;
    const H = f.goalH;
    const dt = f.goalDepthTop;
    const db = f.goalDepthBottom;
    const world = (u: number, y: number, z: number) => [x0 + dir * u, y, z];

    // 1) roof + back strip: columns across the width, rows along the profile
    const backLen = Math.hypot(db - dt, H);
    const profLen = dt + backLen;
    const cols = Math.round((2 * hw) / SPACING) + 1;
    const rows = Math.round(profLen / SPACING) + 1;
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
        uvs.push(z / TILE, s / TILE);
        pin.push(r === 0 || r === rows - 1 || c === 0 || c === cols - 1 ? 1 : 0);
      }
    }
    this.panels.push({ cols, rows, start: 0 });

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
          uvs.push(u / TILE, y / TILE);
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
          if (c + 1 < p.cols) this.addC(i, i + 1);
          if (r + 1 < p.rows) this.addC(i, i + p.cols);
          if (c + 1 < p.cols && r + 1 < p.rows) idx.push(i, i + p.cols, i + 1, i + 1, i + p.cols, i + p.cols + 1);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.geo = geo;
    geo.setAttribute('netUv', new THREE.Float32BufferAttribute(uvs, 2));
    // Procedural diamond mesh: line width is kept >= ~1 px with fwidth(), so the net never
    // vanishes at broadcast distance (a texture's sub-pixel threads would mip away).
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x9aa4b4,
      emissiveIntensity: 0.35,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
      transparent: true,
      depthWrite: false,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 netUv;\nvarying vec2 vNetUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNetUv = netUv;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vNetUv;')
        .replace(
          '#include <alphatest_fragment>',
          `#include <alphatest_fragment>
          vec2 dg = vec2(vNetUv.x + vNetUv.y, vNetUv.x - vNetUv.y) * 0.5;
          vec2 dist = abs(fract(dg) - 0.5);
          vec2 fw = max(fwidth(dg), vec2(1e-4));
          float thick = 0.07;
          vec2 a = 1.0 - smoothstep(thick - fw, thick + fw * 1.5, 0.5 - dist);
          float lineA = max(a.x, a.y);
          // far away the cells are sub-pixel: fade to a soft veil instead of shimmering
          float veil = clamp(max(fw.x, fw.y) * 2.5, 0.0, 1.0);
          diffuseColor.a = mix(lineA, 0.38, veil) * 0.95;
          if (diffuseColor.a < 0.02) discard;`,
        );
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = false;
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
  }

  private addC(i: number, j: number) {
    const p = this.pos;
    this.constraints.push(i, j);
    this.restLen.push(Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]) * SLACK);
  }

  reset() {
    this.pos.set(this.rest);
    this.prev.set(this.rest);
    this.awake = 3;
  }

  /** Advance the cloth. `ball` is the current rendered ball centre. */
  update(dt: number, ball: THREE.Vector3, time: number) {
    const f = this.f;
    const x0 = (this.dir * f.length) / 2;
    const near = Math.abs(ball.x - x0) < f.goalDepthBottom + 1.5 && Math.abs(ball.z) < f.goalHalfW + 1.5 && ball.y < f.goalH + 1.5;
    if (near) this.awake = 3;
    // idle nets still breathe a little; do it at a low rate when far from the ball
    const idle = this.awake <= 0;
    if (idle && Math.floor(time * 20) % 3 !== 0) {
      this.lastBall.copy(ball);
      return;
    }
    this.awake -= dt;
    const sub = idle ? 1 : 3;
    const h = Math.min(dt * (idle ? 3 : 1), 1 / 20) / sub;
    const p = this.pos, q = this.prev, rest = this.rest;
    const R = this.ballRadius + 0.04;
    const from = this.lastBall.x > 1e8 ? ball.clone() : this.lastBall.clone();
    const tmp = new THREE.Vector3();
    for (let s = 0; s < sub; s++) {
      const gust = Math.sin(time * 0.9 + s * 0.3) * 0.6 + Math.sin(time * 2.3) * 0.3;
      for (let i = 0; i < this.n; i++) {
        if (this.pinned[i]) continue;
        const k = i * 3;
        // phase varies across the net so the breeze ripples instead of pumping
        const w = gust * Math.sin(rest[k + 2] * 0.9 + rest[k + 1] * 1.3 + time * 1.7);
        for (let a = 0; a < 3; a++) {
          const cur = p[k + a];
          const v = (cur - q[k + a]) * 0.982;
          let acc = (rest[k + a] - cur) * 10;
          if (a === 1) acc -= 2.2;
          if (a === 0) acc += w * 0.9 * this.dir;
          if (a === 2) acc += w * 0.35;
          q[k + a] = cur;
          p[k + a] = cur + v + acc * h * h;
        }
      }
      if (near) {
        tmp.lerpVectors(from, ball, (s + 1) / sub);
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
      const c = this.constraints;
      for (let it = 0; it < 4; it++) {
        for (let ci = 0, li = 0; ci < c.length; ci += 2, li++) {
          const i = c[ci] * 3, j = c[ci + 1] * 3;
          const dx = p[j] - p[i], dy = p[j + 1] - p[i + 1], dz = p[j + 2] - p[i + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          const L = this.restLen[li];
          if (d < L) continue; // nets only resist stretching
          const diff = (d - L) / d;
          const pi = this.pinned[c[ci]], pj = this.pinned[c[ci + 1]];
          const wi = pi ? 0 : pj ? 1 : 0.5;
          const wj = pj ? 0 : pi ? 1 : 0.5;
          p[i] += dx * diff * wi;
          p[i + 1] += dy * diff * wi;
          p[i + 2] += dz * diff * wi;
          p[j] -= dx * diff * wj;
          p[j + 1] -= dy * diff * wj;
          p[j + 2] -= dz * diff * wj;
        }
      }
      for (let i = 0; i < this.n; i++) if (p[i * 3 + 1] < 0.02) p[i * 3 + 1] = 0.02;
    }
    this.lastBall.copy(ball);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}
