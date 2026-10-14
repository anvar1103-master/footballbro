import * as THREE from 'three';
import type { TeamInfo } from '../sim/team';
import { ARENA, HALL_H } from './world';

/**
 * Indoor football hall ("манеж"): real-looking grass pitch, padded boards all round, glass walls up
 * to a roof with steel trusses and light panels. No stands, no crowd — the ball bounces off the walls
 * and the roof and never leaves. Also the rotating sweeper bar for the "ВЕРТУШКА" chaos event.
 */

const L = ARENA.length / 2;
const W = ARENA.width / 2;

function pitchTexture() {
  const S = 28; // px per metre
  const PW = ARENA.length + 2, PH = ARENA.width + 2;
  const c = document.createElement('canvas');
  c.width = Math.round(PW * S);
  c.height = Math.round(PH * S);
  const g = c.getContext('2d')!;
  // mowing stripes
  const n = 14;
  for (let i = 0; i < n; i++) {
    g.fillStyle = i % 2 ? '#3f8f34' : '#4a9f3c';
    g.fillRect((i * c.width) / n, 0, c.width / n + 1, c.height);
  }
  // grain
  const img = g.getImageData(0, 0, c.width, c.height);
  let seed = 9;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < img.data.length; i += 4) {
    const k = (rnd() - 0.5) * 16;
    img.data[i] += k * 0.5;
    img.data[i + 1] += k;
    img.data[i + 2] += k * 0.4;
  }
  g.putImageData(img, 0, 0);
  // lines
  g.strokeStyle = 'rgba(245,248,245,0.9)';
  g.lineWidth = 0.12 * S;
  const X = (x: number) => (x + PW / 2) * S, Y = (z: number) => (z + PH / 2) * S;
  g.strokeRect(X(-L + 0.3), Y(-W + 0.3), (ARENA.length - 0.6) * S, (ARENA.width - 0.6) * S);
  g.beginPath();
  g.moveTo(X(0), Y(-W + 0.3));
  g.lineTo(X(0), Y(W - 0.3));
  g.stroke();
  g.beginPath();
  g.arc(X(0), Y(0), ARENA.centerRadius * S, 0, Math.PI * 2);
  g.stroke();
  const dot = (x: number, z: number) => {
    g.fillStyle = 'rgba(245,248,245,0.95)';
    g.beginPath();
    g.arc(X(x), Y(z), 0.2 * S, 0, Math.PI * 2);
    g.fill();
  };
  dot(0, 0);
  for (const s of [-1, 1]) {
    const gx = s * (L - 0.3);
    const box = (depth: number, half: number) => g.strokeRect(Math.min(X(gx), X(gx - s * depth)), Y(-half), depth * S, half * 2 * S);
    box(9, 9);
    box(3.5, 5);
    dot(s * (L - 7), 0);
    g.beginPath();
    const a = Math.acos(2 / 5);
    if (s > 0) g.arc(X(s * (L - 7)), Y(0), 5 * S, Math.PI - a, Math.PI + a);
    else g.arc(X(s * (L - 7)), Y(0), 5 * S, -a, a);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** tiling blade-noise multiplied over the pitch so it looks like grass up close */
function grassDetail() {
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(200,200,200)';
  g.fillRect(0, 0, N, N);
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 5200; k++) {
    const x = rnd() * N, y = rnd() * N;
    const a = -Math.PI / 2 + (rnd() - 0.5) * 0.9;
    const len = 2 + rnd() * 5;
    const v = rnd() < 0.5 ? 120 + rnd() * 50 : 230 + rnd() * 25;
    g.strokeStyle = `rgb(${v},${v},${v})`;
    g.lineWidth = 1;
    for (const ox of [-N, 0, N])
      for (const oy of [-N, 0, N]) {
        g.beginPath();
        g.moveTo(x + ox, y + oy);
        g.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len);
        g.stroke();
      }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** padded advertising boards: dark panels with a light top edge and the game's name */
function boardTexture(teams: TeamInfo[]) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 64;
  const g = c.getContext('2d')!;
  const items = [
    { t: 'FOOTBALLBRO', bg: '#14182a', fg: '#ffd23f' },
    { t: teams[0].name.toUpperCase(), bg: teams[0].primary, fg: '#ffffff' },
    { t: 'КРАШ-ТЕСТ ФК', bg: '#1e2a44', fg: '#ffffff' },
    { t: teams[1].name.toUpperCase(), bg: teams[1].primary, fg: '#ffffff' },
  ];
  items.forEach((it, i) => {
    g.fillStyle = it.bg;
    g.fillRect(i * 256, 0, 256, 64);
    g.fillStyle = it.fg;
    g.font = 'bold 30px "Russo One", "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(it.t, i * 256 + 128, 34, 240);
  });
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(0, 0, 1024, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** LED ribbon: bright text on black with a pixel grid, scrolls along */
function ledRibbonTexture() {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#05060a';
  g.fillRect(0, 0, 2048, 64);
  const items = ['FOOTBALLBRO', 'КРАШ-ТЕСТ ЛИГА', '🔥 ОГОНЬ', 'ФИНТЫ · ПОДКАТЫ · УДАРЫ ЧЕРЕЗ СЕБЯ', 'МАНЕКЕНЫ НЕ ЧУВСТВУЮТ БОЛИ'];
  const cols = ['#ffd23f', '#3bc8ff', '#ff7a1a', '#ffffff', '#ff4fa3'];
  g.font = 'bold 38px "Russo One", "Arial Black", sans-serif';
  g.textBaseline = 'middle';
  let x = 20;
  let i = 0;
  while (x < 2048) {
    g.fillStyle = cols[i % cols.length];
    const t = items[i % items.length];
    g.fillText(t, x, 34);
    x += g.measureText(t).width + 40;
    g.fillStyle = '#444';
    g.fillText('◆', x - 30, 34);
    i++;
  }
  // LED pixel grid
  g.fillStyle = 'rgba(0,0,0,0.45)';
  for (let y = 0; y < 64; y += 4) g.fillRect(0, y, 2048, 1);
  for (let xx = 0; xx < 2048; xx += 4) g.fillRect(xx, 0, 1, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** big LED screen above a goal: score, clock and big messages */
class LedScreen {
  canvas = document.createElement('canvas');
  tex: THREE.CanvasTexture;
  group = new THREE.Group();
  private key = '';
  constructor(x: number, face: number) {
    this.canvas.width = 640;
    this.canvas.height = 256;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const W = 9, H = 3.6;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }));
    const frame = new THREE.Mesh(new THREE.BoxGeometry(W + 0.5, H + 0.5, 0.3), new THREE.MeshStandardMaterial({ color: '#1b1f2a', roughness: 0.5, metalness: 0.6 }));
    frame.position.z = -0.17;
    this.group.add(frame, screen);
    this.group.position.set(x, 5.4, 0);
    this.group.rotation.y = face * Math.PI / 2;
  }
  draw(teams: TeamInfo[], score: [number, number], clock: string, msg: string, flash: boolean) {
    const key = `${score}|${clock}|${msg}|${flash}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.canvas.getContext('2d')!;
    g.fillStyle = flash ? '#2a0a00' : '#06070c';
    g.fillRect(0, 0, 640, 256);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (msg) {
      g.font = 'bold 120px "Lilita One", "Arial Black", sans-serif';
      g.fillStyle = flash ? '#ffd23f' : '#ff7a1a';
      g.fillText(msg, 320, 128, 600);
    } else {
      for (let i = 0; i < 2; i++) {
        const cx = i ? 520 : 120;
        g.fillStyle = teams[i].primary;
        g.fillRect(cx - 95, 40, 190, 70);
        g.fillStyle = '#ffffff';
        g.font = 'bold 54px "Russo One", "Arial Black", sans-serif';
        g.fillText(teams[i].short, cx, 78);
      }
      g.font = 'bold 130px "Lilita One", "Arial Black", sans-serif';
      g.fillStyle = '#ffffff';
      g.fillText(`${score[0]}:${score[1]}`, 320, 92);
      g.font = 'bold 60px "Russo One", "Arial Black", sans-serif';
      g.fillStyle = '#ffd23f';
      g.fillText(clock, 320, 200);
    }
    // LED pixel grid
    g.fillStyle = 'rgba(0,0,0,0.5)';
    for (let y = 0; y < 256; y += 4) g.fillRect(0, y, 640, 1);
    for (let x = 0; x < 640; x += 4) g.fillRect(x, 0, 1, 256);
    this.tex.needsUpdate = true;
  }
}

function hazardTexture() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 16; i++) {
    g.fillStyle = i % 2 ? '#1b1b1b' : '#ffcc00';
    g.fillRect(0, i * 16, 32, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export class Arena {
  group = new THREE.Group();
  sweeper: THREE.Group;
  hype = 0;
  private lights: THREE.Mesh[] = [];
  /** LED screens above the goals (score, clock, messages) */
  screens: LedScreen[] = [];
  private scrolling: THREE.Texture[] = [];
  private ribbons: THREE.Texture[] = [];
  private ribbonTex = ledRibbonTexture();
  /** wall parts on the long sides: the one between the TV camera and the pitch is cut away */
  private cutaway: { o: THREE.Object3D; side: number; kind: 'hide' | 'fade' }[] = [];
  private cutSide = 0;

  constructor(teams: TeamInfo[]) {
    // ---- grass ----
    const grassMat = new THREE.MeshStandardMaterial({ map: pitchTexture(), roughness: 0.95 });
    const detail = { value: grassDetail() };
    grassMat.onBeforeCompile = (sh) => {
      sh.uniforms.uDetail = detail;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWXZ;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\nvarying vec2 vWXZ;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float d1 = texture2D(uDetail, vWXZ * 0.6).r;
          float d2 = texture2D(uDetail, vWXZ * 0.07 + 0.37).r;
          diffuseColor.rgb *= (0.62 + 0.5 * d1) * (0.85 + 0.25 * d2);`,
        );
    };
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.length + 2, ARENA.width + 2), grassMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.receiveShadow = true;
    this.group.add(pitch);
    // hall floor beyond the pitch
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.length + 40, ARENA.width + 40), new THREE.MeshStandardMaterial({ color: '#2d4f86', roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.receiveShadow = true;
    this.group.add(floor);

    // ---- boards + glass along every wall segment ----
    const boardTex = boardTexture(teams);
    const glassMat = new THREE.MeshPhysicalMaterial({ color: '#bfe3ff', transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0, side: THREE.DoubleSide, depthWrite: false });
    const steel = new THREE.MeshStandardMaterial({ color: '#8d96a6', metalness: 0.6, roughness: 0.4 });
    const BH = 1.1; // board height
    /** side = which long side the segment belongs to (+1 / -1 for z > 0 / z < 0, 0 = ends): the TV camera cuts the near one away */
    const wall = (x1: number, z1: number, x2: number, z2: number, side = 0) => {
      const cut = (o: THREE.Object3D, kind: 'hide' | 'fade') => {
        if (side) this.cutaway.push({ o, side, kind });
      };
      const len = Math.hypot(x2 - x1, z2 - z1);
      const yaw = -Math.atan2(z2 - z1, x2 - x1);
      const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
      const tex = boardTex.clone();
      tex.needsUpdate = true;
      tex.repeat.set(len / 10, 1);
      this.scrolling.push(tex);
      const st = side ? steel.clone() : steel;
      const board = new THREE.Mesh(new THREE.BoxGeometry(len, BH, 0.3), [
        st, st, new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.6 }), st,
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.35 }),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.35 }),
      ]);
      cut(board, 'fade');
      board.position.set(cx, BH / 2, cz);
      board.rotation.y = yaw;
      board.castShadow = true;
      board.receiveShadow = true;
      this.group.add(board);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(len, HALL_H - BH), glassMat);
      glass.position.set(cx, BH + (HALL_H - BH) / 2, cz);
      glass.rotation.y = yaw;
      this.group.add(glass);
      cut(glass, 'hide');
      // mullions
      const n = Math.max(1, Math.round(len / 4));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, HALL_H - BH, 0.1), steel);
        post.position.set(x1 + (x2 - x1) * t, BH + (HALL_H - BH) / 2, z1 + (z2 - z1) * t);
        this.group.add(post);
        cut(post, 'hide');
      }
      if (side) {
        // second tier: a thin scrolling LED ribbon on the glass just above the boards
        const rt = this.ribbonTex.clone();
        rt.needsUpdate = true;
        rt.repeat.set(len / 30, 1);
        this.ribbons.push(rt);
        const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.42), new THREE.MeshBasicMaterial({ map: rt, toneMapped: false }));
        ribbon.position.set(cx, BH + 0.32, cz + side * 0.02);
        ribbon.rotation.y = side > 0 ? Math.PI : 0;
        this.group.add(ribbon);
        cut(ribbon, 'hide');
      }
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.08, 0.12), steel);
      rail.position.set(cx, BH + 1.6, cz);
      rail.rotation.y = yaw;
      this.group.add(rail);
      cut(rail, 'hide');
    };
    const c = ARENA.corner, o = 0.15;
    wall(-L + c, -W - o, L - c, -W - o, -1);
    wall(-L + c, W + o, L - c, W + o, 1);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        wall(sx * (L + o), sz * (ARENA.goalHalfW + 0.2), sx * (L + o), sz * (W - c));
        wall(sx * (L - c), sz * (W + o), sx * (L + o), sz * (W - c), sz);
      }
      // glass above the goal and boards behind the net
      const gx = sx * (L + o);
      const above = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.goalHalfW * 2 + 0.4, HALL_H - ARENA.goalH - 0.5), glassMat);
      above.position.set(gx, ARENA.goalH + 0.5 + (HALL_H - ARENA.goalH - 0.5) / 2, 0);
      above.rotation.y = Math.PI / 2;
      this.group.add(above);
      const backX = sx * (L + ARENA.goalDepthBottom + 0.6);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.3, BH, ARENA.goalHalfW * 2 + 1.6), new THREE.MeshStandardMaterial({ color: '#14182a', roughness: 0.6 }));
      back.position.set(backX, BH / 2, 0);
      this.group.add(back);
      for (const sz of [-1, 1]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(ARENA.goalDepthBottom + 0.6, BH, 0.3), new THREE.MeshStandardMaterial({ color: '#14182a', roughness: 0.6 }));
        side.position.set(sx * (L + (ARENA.goalDepthBottom + 0.6) / 2), BH / 2, sz * (ARENA.goalHalfW + 0.8));
        this.group.add(side);
      }
    }

    // ---- hall shell: outer walls, roof, trusses, light panels ----
    const shell = new THREE.MeshStandardMaterial({ color: '#4b5466', roughness: 0.95, side: THREE.BackSide });
    const hall = new THREE.Mesh(new THREE.BoxGeometry(ARENA.length + 26, HALL_H + 6, ARENA.width + 22), shell);
    hall.position.y = (HALL_H + 6) / 2 - 0.02;
    this.group.add(hall);
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.length + 26, ARENA.width + 22), new THREE.MeshStandardMaterial({ color: '#5d6677', roughness: 0.9, side: THREE.DoubleSide }));
    roof.rotation.x = Math.PI / 2;
    roof.position.y = HALL_H + 2.5;
    this.group.add(roof);
    const truss = new THREE.MeshStandardMaterial({ color: '#c9cfd8', metalness: 0.5, roughness: 0.45 });
    for (let x = -L - 6; x <= L + 6; x += 6) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.35, ARENA.width + 20), truss);
      beam.position.set(x, HALL_H + 0.4, 0);
      const top = beam.clone();
      top.position.y = HALL_H + 1.9;
      this.group.add(beam, top);
      for (let z = -W - 8; z <= W + 8; z += 2.4) {
        const diag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.9, 0.08), truss);
        diag.position.set(x, HALL_H + 1.15, z);
        diag.rotation.x = (Math.round(z / 2.4) % 2 ? 1 : -1) * 0.55;
        this.group.add(diag);
      }
    }
    // rows of light panels (emissive; the real light comes from view.ts)
    const lightMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff6e0', emissiveIntensity: 2.2 });
    for (let x = -L + 3; x <= L - 3; x += 6)
      for (const z of [-W * 0.55, 0, W * 0.55]) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 1.2), lightMat);
        panel.position.set(x, HALL_H + 0.15, z);
        this.group.add(panel);
        this.lights.push(panel);
      }

    // ---- LED screens high above each goal ----
    for (const sx of [-1, 1]) {
      const sc = new LedScreen(sx * (L + 0.1), -sx);
      this.screens.push(sc);
      this.group.add(sc.group);
    }
    this.teams = teams;
    this.setScoreboard([0, 0], '3:00', '');

    // ---- goals ----
    for (const dir of [-1, 1]) {
      const white = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3, metalness: 0.1 });
      const r = 0.1, x0 = dir * L;
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(r, r, ARENA.goalH + r, 16), white);
        post.position.set(x0, (ARENA.goalH + r) / 2, sz * (ARENA.goalHalfW + r));
        post.castShadow = true;
        this.group.add(post);
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, ARENA.goalHalfW * 2 + r * 2, 16), white);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(x0, ARENA.goalH + r, 0);
      bar.castShadow = true;
      this.group.add(bar);
    }

    // ---- sweeper bar ("ВЕРТУШКА" event) ----
    this.sweeper = new THREE.Group();
    const tex = hazardTexture();
    tex.repeat.set(1, 5);
    const sbar = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 20, 16), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, metalness: 0.2 }));
    sbar.rotation.z = Math.PI / 2;
    sbar.position.y = 0.55;
    sbar.castShadow = true;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 1.2, 24), new THREE.MeshStandardMaterial({ color: '#4a5263', metalness: 0.6, roughness: 0.35 }));
    hub.position.y = 0.6;
    hub.castShadow = true;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), new THREE.MeshStandardMaterial({ color: '#ff3b3b', emissive: '#ff2020', emissiveIntensity: 2 }));
    lamp.position.y = 1.3;
    lamp.name = 'lamp';
    this.sweeper.add(sbar, hub, lamp);
    this.sweeper.visible = false;
    this.group.add(this.sweeper);
  }

  private teams: TeamInfo[];
  private msgT = 0;
  private msg = '';
  /** what the LED screens show; `msg` (e.g. ГОЛ!) flashes for a few seconds */
  setScoreboard(score: [number, number], clock: string, msg: string, dur = 3) {
    if (msg) {
      this.msg = msg;
      this.msgT = dur;
    }
    const flash = this.msgT > 0 && Math.floor(this.msgT * 4) % 2 === 0;
    for (const s of this.screens) s.draw(this.teams, score, clock, this.msgT > 0 ? this.msg : '', flash);
  }

  /** hide the glass and fade the boards of long side `side` (+1 / -1), 0 = show everything */
  setCutaway(side: number) {
    if (side === this.cutSide) return;
    this.cutSide = side;
    for (const c of this.cutaway) {
      const on = c.side === side;
      if (c.kind === 'hide') c.o.visible = !on;
      else {
        const m = (c.o as THREE.Mesh).material as THREE.MeshStandardMaterial[];
        for (const x of m) {
          x.transparent = on;
          x.opacity = on ? 0.28 : 1;
          x.depthWrite = !on;
          x.needsUpdate = true;
        }
        c.o.castShadow = !on;
      }
    }
  }

  update(dt: number, time: number, sweeper: { on: boolean; angle: number }) {
    this.sweeper.visible = sweeper.on;
    if (sweeper.on) {
      this.sweeper.rotation.y = -sweeper.angle;
      const lamp = this.sweeper.getObjectByName('lamp') as THREE.Mesh;
      (lamp.material as THREE.MeshStandardMaterial).emissiveIntensity = 1 + Math.abs(Math.sin(time * 8)) * 2;
    }
    // LED boards scroll
    for (const t of this.scrolling) t.offset.x = (t.offset.x + dt * 0.04) % 1;
    for (const t of this.ribbons) t.offset.x = (t.offset.x - dt * 0.025) % 1;
    this.msgT = Math.max(0, this.msgT - dt);
    // goal flash: light panels pulse with the hype
    this.hype = Math.max(0, this.hype - dt * 0.4);
    const k = 2.2 + this.hype * 2 * Math.abs(Math.sin(time * 10));
    for (const l of this.lights) (l.material as THREE.MeshStandardMaterial).emissiveIntensity = k;
  }
}
