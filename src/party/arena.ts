import * as THREE from 'three';
import type { TeamInfo } from '../sim/team';
import { ARENA } from './world';

/**
 * The sky arena: a candy-coloured pitch on a floating rock island, inflatable striped walls,
 * chunky goals, balloons, clouds, mini islands and a stand of cheering spectators.
 */

/** bands across v (along a tube / cylinder) */
function candyTexture(a: string, b: string, stripes = 8) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < stripes; i++) {
    g.fillStyle = i % 2 ? b : a;
    g.fillRect(0, (i * 256) / stripes, 32, 256 / stripes + 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function pitchTexture(home: string, away: string) {
  const L = ARENA.length, W = ARENA.width;
  const S = 24; // px per metre
  const c = document.createElement('canvas');
  c.width = L * S;
  c.height = W * S;
  const g = c.getContext('2d')!;
  // bright turf with wide mowing stripes
  for (let i = 0; i < 12; i++) {
    g.fillStyle = i % 2 ? '#5fd35a' : '#4cc04e';
    g.fillRect((i * c.width) / 12, 0, c.width / 12 + 1, c.height);
  }
  // soft tint of each team's half
  const tint = (x: number, col: string) => {
    const gr = g.createLinearGradient(x, 0, c.width / 2, 0);
    gr.addColorStop(0, col + '40');
    gr.addColorStop(1, col + '00');
    g.fillStyle = gr;
    g.fillRect(Math.min(x, c.width / 2), 0, c.width / 2, c.height);
  };
  tint(0, home);
  tint(c.width, away);
  // speckle
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,60,0,0.06)';
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 3, 3);
  }
  // chunky white lines
  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.lineWidth = 0.22 * S;
  const X = (x: number) => (x + L / 2) * S, Y = (z: number) => (z + W / 2) * S;
  g.beginPath();
  g.moveTo(X(0), Y(-W / 2));
  g.lineTo(X(0), Y(W / 2));
  g.stroke();
  g.beginPath();
  g.arc(X(0), Y(0), ARENA.centerRadius * S, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'white';
  g.beginPath();
  g.arc(X(0), Y(0), 0.5 * S, 0, Math.PI * 2);
  g.fill();
  for (const s of [-1, 1]) {
    const gx = (s * L) / 2;
    g.beginPath();
    g.arc(X(gx), Y(0), 7 * S, s > 0 ? Math.PI / 2 : -Math.PI / 2, s > 0 ? (Math.PI * 3) / 2 : Math.PI / 2);
    g.stroke();
    // goal mouth
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillRect(X(gx) - (s > 0 ? 0.3 * S : 0), Y(-ARENA.goalHalfW), 0.3 * S, ARENA.goalHalfW * 2 * S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** jagged floating rock under the pitch */
function islandRock() {
  const geo = new THREE.ConeGeometry(34, 26, 28, 6, true);
  geo.rotateX(Math.PI); // point down
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col: number[] = [];
  const a = new THREE.Color('#8a6a4c'), b = new THREE.Color('#5e4a3a'), grass = new THREE.Color('#58b947');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = 1 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.12;
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
    const t = (y + 13) / 26; // 0 bottom .. 1 top
    const c = t > 0.93 ? grass : a.clone().lerp(b, 1 - t + (k - 1) * 3);
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  m.scale.set(1.1, 1, 0.8);
  m.position.y = -14.5;
  return m;
}

function cloud(scale: number) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, emissive: 0xdde8ff, emissiveIntensity: 0.35 });
  const n = 5 + Math.floor(Math.random() * 4);
  for (let i = 0; i < n; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat);
    const r = 1.4 + Math.random() * 1.6;
    s.scale.setScalar(r);
    s.position.set((i - n / 2) * 1.8 + Math.random(), Math.random() * 1.2, Math.random() * 2);
    g.add(s);
  }
  g.scale.setScalar(scale);
  return g;
}

function balloon(color: string) {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), new THREE.MeshPhysicalMaterial({ color, roughness: 0.25, clearcoat: 1 }));
  b.scale.set(1, 1.2, 1);
  b.position.y = 6;
  const s = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  s.position.y = 3;
  g.add(b, s);
  return g;
}

export class Arena {
  group = new THREE.Group();
  sweeper: THREE.Group;
  private crowd: THREE.InstancedMesh;
  private crowdBase: { p: THREE.Vector3; ph: number }[] = [];
  private balloons: THREE.Object3D[] = [];
  private clouds: THREE.Object3D[] = [];
  hype = 0;

  constructor(teams: TeamInfo[]) {
    const L = ARENA.length / 2, W = ARENA.width / 2, c = ARENA.corner;
    // pitch
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.length + 1.2, ARENA.width + 1.2), new THREE.MeshStandardMaterial({ map: pitchTexture(teams[0].primary, teams[1].primary), roughness: 0.85 }));
    pitch.rotation.x = -Math.PI / 2;
    pitch.receiveShadow = true;
    this.group.add(pitch);
    // island slab + rock
    const shape = new THREE.Shape();
    const e = 2.5; // rim beyond the walls
    const pts: [number, number][] = [
      [-L - e + c, -W - e], [L + e - c, -W - e], [L + e, -W - e + c], [L + e, W + e - c],
      [L + e - c, W + e], [-L - e + c, W + e], [-L - e, W + e - c], [-L - e, -W - e + c],
    ];
    shape.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) shape.lineTo(p[0], p[1]);
    const slab = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, { depth: 2.2, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 0.6, bevelSegments: 3 }),
      [new THREE.MeshStandardMaterial({ color: '#7ce36b', roughness: 0.8 }), new THREE.MeshStandardMaterial({ color: '#f5e2c4', roughness: 0.7 })],
    );
    slab.rotation.x = Math.PI / 2; // extrudes downwards; the bevel pokes 0.4 m above the shape
    slab.position.y = -0.45;
    slab.receiveShadow = true;
    this.group.add(slab);
    this.group.add(islandRock());

    // inflatable walls: fat candy-striped tubes along every wall segment
    const tube = (x1: number, z1: number, x2: number, z2: number, col: string) => {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const tex = candyTexture(col, '#ffffff', 2);
      tex.repeat.set(1, Math.max(1, Math.round(len / 2.5)));
      const mat = new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.35, clearcoat: 0.9, clearcoatRoughness: 0.2 });
      for (const [r, y] of [[0.55, 0.55], [0.32, 1.32]] as const) {
        const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 16), mat);
        m.geometry.rotateZ(Math.PI / 2);
        m.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
        m.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
      }
    };
    const off = 0.55;
    const ca = teams[0].primary, cb = teams[1].primary;
    tube(-L + c, -W - off, 0, -W - off, ca);
    tube(0, -W - off, L - c, -W - off, cb);
    tube(-L + c, W + off, 0, W + off, ca);
    tube(0, W + off, L - c, W + off, cb);
    for (const sx of [-1, 1]) {
      const col = sx < 0 ? ca : cb;
      for (const sz of [-1, 1]) {
        tube(sx * (L + off), sz * (ARENA.goalHalfW + 0.5), sx * (L + off), sz * (W - c), col);
        tube(sx * (L - c), sz * (W + off), sx * (L + off), sz * (W - c), col);
      }
    }
    // faint force-field glass above the tubes (the real physics walls are taller)
    const glass = new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
    for (const sz of [-1, 1]) {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.length - 2 * c, 3.2), glass);
      g.position.set(0, 3.2, sz * (W + 0.3));
      this.group.add(g);
    }

    // goals: chunky striped posts
    for (const dir of [-1, 1]) {
      const col = dir < 0 ? ca : cb;
      const tex = candyTexture('#ffffff', col, 10);
      const mat = new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.3, clearcoat: 1 });
      const r = 0.1, x0 = dir * L;
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(r, r, ARENA.goalH + r, 16), mat);
        post.position.set(x0, (ARENA.goalH + r) / 2, sz * (ARENA.goalHalfW + r));
        post.castShadow = true;
        this.group.add(post);
        const knob = new THREE.Mesh(new THREE.SphereGeometry(r * 1.6, 16, 12), new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.3, clearcoat: 1 }));
        knob.position.set(x0, ARENA.goalH + r, sz * (ARENA.goalHalfW + r));
        this.group.add(knob);
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, ARENA.goalHalfW * 2 + r * 2, 16), mat);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(x0, ARENA.goalH + r, 0);
      bar.castShadow = true;
      this.group.add(bar);
      // big inflatable arch behind the goal with the team colour
      const arch = new THREE.Mesh(new THREE.TorusGeometry(ARENA.goalHalfW + 1.4, 0.45, 12, 32, Math.PI), new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.35, clearcoat: 0.9 }));
      arch.rotation.y = Math.PI / 2;
      arch.position.set(x0 + dir * (ARENA.goalDepthBottom + 0.8), 0, 0);
      arch.castShadow = true;
      this.group.add(arch);
    }

    // sweeper bar (shown during the "ВЕРТУШКА" event)
    this.sweeper = new THREE.Group();
    const barTex = candyTexture('#ff3b6b', '#ffe14d', 20);
    const sbar = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 20, 16), new THREE.MeshPhysicalMaterial({ map: barTex, roughness: 0.3, clearcoat: 1 }));
    sbar.rotation.z = Math.PI / 2;
    sbar.position.y = 0.55;
    sbar.castShadow = true;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 1.2, 24), new THREE.MeshPhysicalMaterial({ color: '#7b5cff', roughness: 0.3, clearcoat: 1 }));
    hub.position.y = 0.6;
    hub.castShadow = true;
    this.sweeper.add(sbar, hub);
    this.sweeper.visible = false;
    this.group.add(this.sweeper);

    // spectators on two floating stands
    const N = 160;
    this.crowd = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.4, 0.6, 4, 10), new THREE.MeshStandardMaterial({ roughness: 0.5 }), N);
    this.crowd.castShadow = false;
    const palette = [teams[0].primary, teams[1].primary, '#ffd23f', '#ff7ab8', '#7bdff2', '#b2f7ef', '#f7a072'];
    for (const sz of [-1, 1]) {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(ARENA.length * 0.9, 1, 7), new THREE.MeshStandardMaterial({ color: '#f5e2c4', roughness: 0.8 }));
      stand.position.set(0, -0.5 + 1.5, sz * (W + 9));
      const under = new THREE.Mesh(new THREE.ConeGeometry(5, 7, 6, 1, true), new THREE.MeshStandardMaterial({ color: '#7a5c42', flatShading: true }));
      under.rotation.x = Math.PI;
      under.scale.set(4.4, 1, 0.7);
      under.position.set(0, -2.5, sz * (W + 9));
      this.group.add(stand, under);
      for (let row = 0; row < 3; row++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(ARENA.length * 0.88, 0.8, 2), new THREE.MeshStandardMaterial({ color: ['#ff9ec7', '#9ed8ff', '#ffe59e'][row], roughness: 0.7 }));
        step.position.set(0, 1.4 + row * 0.8, sz * (W + 7 + row * 2));
        this.group.add(step);
      }
    }
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      const sz = i % 2 ? 1 : -1;
      const row = Math.floor(i / 2) % 3;
      const x = -ARENA.length * 0.42 + ((Math.floor(i / 6) * 1.55 + row * 0.5) % (ARENA.length * 0.84));
      const p = new THREE.Vector3(x, 2.45 + row * 0.8, sz * (W + 7 + row * 2));
      this.crowdBase.push({ p, ph: Math.random() * 10 });
      m4.makeTranslation(p.x, p.y, p.z);
      this.crowd.setMatrixAt(i, m4);
      this.crowd.setColorAt(i, new THREE.Color(palette[i % palette.length]));
    }
    this.group.add(this.crowd);

    // balloons around the arena
    const bcols = ['#ff4d6d', '#ffd23f', '#4dd2ff', '#9b5de5', '#00f5d4', '#ff8fab'];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const bl = balloon(bcols[i % bcols.length]);
      bl.position.set(Math.cos(a) * (L + 10 + (i % 3) * 3), -1 + (i % 4), Math.sin(a) * (W + 13 + (i % 2) * 3));
      bl.userData.ph = Math.random() * 6;
      this.balloons.push(bl);
      this.group.add(bl);
    }
    // clouds and mini islands
    for (let i = 0; i < 16; i++) {
      const cl = cloud(1 + Math.random() * 1.6);
      const a = Math.random() * Math.PI * 2;
      const r = 70 + Math.random() * 90;
      cl.position.set(Math.cos(a) * r, -25 + Math.random() * 45, Math.sin(a) * r);
      cl.userData.v = 0.3 + Math.random() * 0.6;
      this.clouds.push(cl);
      this.group.add(cl);
    }
    for (let i = 0; i < 6; i++) {
      const isle = islandRock();
      const s = 0.12 + Math.random() * 0.12;
      isle.scale.multiplyScalar(s);
      const a = (i / 6) * Math.PI * 2 + 0.4;
      isle.position.set(Math.cos(a) * (80 + i * 9), -6 + Math.random() * 14, Math.sin(a) * (70 + i * 7));
      const top = new THREE.Mesh(new THREE.CylinderGeometry(34 * s * 1.05, 34 * s, 1.2, 20), new THREE.MeshStandardMaterial({ color: '#6fd35c' }));
      top.position.set(isle.position.x, isle.position.y + 13 * s + 0.6, isle.position.z);
      this.group.add(isle, top);
    }
  }

  update(dt: number, time: number, sweeper: { on: boolean; angle: number }) {
    this.sweeper.visible = sweeper.on;
    if (sweeper.on) this.sweeper.rotation.y = -sweeper.angle;
    this.hype = Math.max(0, this.hype - dt * 0.25);
    const m4 = new THREE.Matrix4();
    const amp = 0.08 + this.hype * 0.6;
    this.crowdBase.forEach((c, i) => {
      const y = c.p.y + Math.abs(Math.sin(time * (4 + this.hype * 6) + c.ph)) * amp;
      m4.makeTranslation(c.p.x, y, c.p.z);
      this.crowd.setMatrixAt(i, m4);
    });
    this.crowd.instanceMatrix.needsUpdate = true;
    for (const b of this.balloons) b.position.y += Math.sin(time * 0.8 + b.userData.ph) * dt * 0.4;
    for (const c of this.clouds) {
      c.position.x += c.userData.v * dt;
      if (c.position.x > 180) c.position.x = -180;
    }
  }
}
