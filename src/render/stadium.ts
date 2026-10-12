import * as THREE from 'three';
import { FieldDims } from '../sim/config';
import type { TeamInfo } from '../sim/team';

/** Procedural cartoon stadium: striped pitch, lines, goals, boards, stands, crowd, floodlights, sky. */

const PX_PER_M = 26;

function pitchTexture(f: FieldDims, margin: number) {
  const W = f.length + margin * 2;
  const H = f.width + margin * 2;
  const cw = Math.min(4096, Math.round(W * PX_PER_M));
  const scale = cw / W;
  const ch = Math.round(H * scale);
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const g = cv.getContext('2d')!;
  // mowing stripes
  const stripes = 14;
  const sw = (f.length / stripes) * scale;
  g.fillStyle = '#3f9a3a';
  g.fillRect(0, 0, cw, ch);
  for (let i = -2; i < stripes + 2; i++) {
    g.fillStyle = i % 2 === 0 ? '#4caf45' : '#41a03c';
    g.fillRect(margin * scale + i * sw, 0, sw, ch);
  }
  // subtle checker for the cartoon "mown" look
  g.globalAlpha = 0.06;
  const cs = (f.width / 8) * scale;
  for (let y = 0; y < ch / cs; y++) {
    g.fillStyle = y % 2 ? '#ffffff' : '#000000';
    g.fillRect(0, margin * scale + y * cs, cw, cs);
  }
  g.globalAlpha = 1;
  // grain noise
  const img = g.getImageData(0, 0, cw, ch);
  const d = img.data;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    d[i] += n * 0.6;
    d[i + 1] += n;
    d[i + 2] += n * 0.4;
  }
  g.putImageData(img, 0, 0);

  // lines
  const X = (x: number) => (x + W / 2) * scale;
  const Y = (z: number) => (z + H / 2) * scale;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 0.13 * scale;
  g.lineJoin = 'round';
  const L = f.length / 2, Wd = f.width / 2;
  g.strokeRect(X(-L), Y(-Wd), f.length * scale, f.width * scale);
  g.beginPath();
  g.moveTo(X(0), Y(-Wd));
  g.lineTo(X(0), Y(Wd));
  g.stroke();
  g.beginPath();
  g.arc(X(0), Y(0), f.centerRadius * scale, 0, Math.PI * 2);
  g.stroke();
  const dot = (x: number, z: number, r = 0.22) => {
    g.beginPath();
    g.arc(X(x), Y(z), r * scale, 0, Math.PI * 2);
    g.fillStyle = 'white';
    g.fill();
  };
  dot(0, 0);
  for (const s of [-1, 1]) {
    const gx = s * L;
    g.strokeRect(Math.min(X(gx), X(gx - s * f.boxDepth)), Y(-f.boxHalfW), f.boxDepth * scale, f.boxHalfW * 2 * scale);
    g.strokeRect(Math.min(X(gx), X(gx - s * f.smallBoxDepth)), Y(-f.smallBoxHalfW), f.smallBoxDepth * scale, f.smallBoxHalfW * 2 * scale);
    const spot = gx - s * f.penaltySpot;
    dot(spot, 0);
    // penalty arc (outside the box only)
    const r = f.centerRadius;
    const dx = f.boxDepth - f.penaltySpot;
    if (dx < r) {
      const a = Math.acos(dx / r);
      g.beginPath();
      if (s > 0) g.arc(X(spot), Y(0), r * scale, Math.PI - a, Math.PI + a);
      else g.arc(X(spot), Y(0), r * scale, -a, a);
      g.stroke();
    }
    // corner arcs
    for (const cz of [-1, 1]) {
      g.beginPath();
      const start = s > 0 ? (cz > 0 ? Math.PI : Math.PI / 2) : cz > 0 ? -Math.PI / 2 : 0;
      g.arc(X(gx), Y(cz * Wd), 1 * scale, start, start + Math.PI / 2);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, W, H };
}

function boardTexture(teams: TeamInfo[]) {
  const cv = document.createElement('canvas');
  cv.width = 2048;
  cv.height = 64;
  const g = cv.getContext('2d')!;
  const ads = [
    { t: 'FOOTBALLBRO', bg: '#111827', fg: '#ffd60a' },
    { t: 'BRO COLA', bg: '#e63946', fg: '#ffffff' },
    { t: 'CURL+ BOOTS', bg: '#3a86ff', fg: '#ffffff' },
    { t: teams[0].name.toUpperCase(), bg: teams[0].primary, fg: teams[0].secondary },
    { t: 'KICKZ', bg: '#70e000', fg: '#102a12' },
    { t: teams[1].name.toUpperCase(), bg: teams[1].primary, fg: teams[1].secondary },
    { t: 'TOPSPIN TV', bg: '#8338ec', fg: '#ffffff' },
    { t: 'NUTMEG BANK', bg: '#fb5607', fg: '#ffffff' },
  ];
  const w = cv.width / ads.length;
  ads.forEach((a, i) => {
    g.fillStyle = a.bg;
    g.fillRect(i * w, 0, w, 64);
    g.fillStyle = a.fg;
    g.font = '900 34px "Arial Black", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(a.t, i * w + w / 2, 34, w - 20);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** Blocky fan: body + head merged, animated in the vertex shader. */
function crowdGeometry() {
  const body = new THREE.BoxGeometry(0.5, 0.62, 0.32);
  body.translate(0, 0.31, 0);
  const head = new THREE.BoxGeometry(0.36, 0.36, 0.36);
  head.translate(0, 0.82, 0);
  const merged = new THREE.BufferGeometry();
  const pos: number[] = [];
  const nor: number[] = [];
  const shade: number[] = [];
  for (const [geo, s] of [[body, 1], [head, 0]] as const) {
    const g = geo.toNonIndexed();
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nor.push(...(g.getAttribute('normal').array as Float32Array));
    for (let i = 0; i < g.getAttribute('position').count; i++) shade.push(s);
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  merged.setAttribute('isBody', new THREE.Float32BufferAttribute(shade, 1));
  return merged;
}

export class Stadium {
  group = new THREE.Group();
  crowdUniforms = { uTime: { value: 0 }, uHype: { value: 0 } };
  flagGroups: THREE.Object3D[] = [];

  constructor(public f: FieldDims, teams: TeamInfo[], public homeTeamForCrowd: number) {
    const margin = f.boardMargin + 3;
    const { tex, W, H } = pitchTexture(f, margin);
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    pitch.rotation.x = -Math.PI / 2;
    pitch.receiveShadow = true;
    this.group.add(pitch);

    // surround (track) beyond the boards
    const surround = new THREE.Mesh(new THREE.PlaneGeometry(W + 80, H + 80), new THREE.MeshStandardMaterial({ color: 0x2f6f3a, roughness: 1 }));
    surround.rotation.x = -Math.PI / 2;
    surround.position.y = -0.02;
    surround.receiveShadow = true;
    this.group.add(surround);

    this.buildGoals();
    this.buildBoards(teams);
    this.buildFlags();
    this.buildStands(teams);
    this.buildFloodlights();
  }

  private buildGoals() {
    const f = this.f;
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.1 });
    const grey = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.5 });
    const r = 0.06;
    for (const dir of [-1, 1]) {
      const x0 = (dir * f.length) / 2;
      const post = new THREE.CylinderGeometry(r, r, f.goalH + r, 16);
      for (const s of [-1, 1]) {
        const m = new THREE.Mesh(post, white);
        m.position.set(x0, (f.goalH + r) / 2, s * f.goalHalfW);
        m.castShadow = true;
        this.group.add(m);
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, f.goalHalfW * 2 + 2 * r, 16), white);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(x0, f.goalH, 0);
      bar.castShadow = true;
      this.group.add(bar);
      // rear frame: roof bar, ground bar, side supports
      const thin = 0.025;
      const addBar = (a: THREE.Vector3, b: THREE.Vector3) => {
        const len = a.distanceTo(b);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(thin, thin, len, 8), grey);
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        m.castShadow = true;
        this.group.add(m);
      };
      const u = (d: number) => x0 + dir * d;
      const hw = f.goalHalfW;
      addBar(new THREE.Vector3(u(f.goalDepthTop), f.goalH, -hw), new THREE.Vector3(u(f.goalDepthTop), f.goalH, hw));
      addBar(new THREE.Vector3(u(f.goalDepthBottom), 0.02, -hw), new THREE.Vector3(u(f.goalDepthBottom), 0.02, hw));
      for (const s of [-1, 1]) {
        addBar(new THREE.Vector3(u(0), f.goalH, s * hw), new THREE.Vector3(u(f.goalDepthTop), f.goalH, s * hw));
        addBar(new THREE.Vector3(u(f.goalDepthTop), f.goalH, s * hw), new THREE.Vector3(u(f.goalDepthBottom), 0.02, s * hw));
        addBar(new THREE.Vector3(u(0), 0.02, s * hw), new THREE.Vector3(u(f.goalDepthBottom), 0.02, s * hw));
      }
    }
  }

  private buildBoards(teams: TeamInfo[]) {
    const f = this.f;
    const tex = boardTexture(teams);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 });
    const back = new THREE.MeshStandardMaterial({ color: 0x1c2333 });
    const h = 0.9;
    const bx = f.length / 2 + f.boardMargin + 1.5;
    const bz = f.width / 2 + f.boardMargin;
    const mk = (len: number, x: number, z: number, rotY: number) => {
      const t = tex.clone();
      t.repeat.set(len / 40, 1);
      t.needsUpdate = true;
      const m2 = mat.clone();
      m2.map = t;
      m2.emissiveMap = t;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, h, 0.15), [back, back, back, back, m2, back]);
      mesh.position.set(x, h / 2, z);
      mesh.rotation.y = rotY;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    };
    mk(bx * 2, 0, -bz, 0);
    mk(bx * 2, 0, bz, Math.PI);
    mk(bz * 2, -bx, 0, Math.PI / 2);
    mk(bz * 2, bx, 0, -Math.PI / 2);
  }

  private buildFlags() {
    const f = this.f;
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const flagMat = new THREE.MeshStandardMaterial({ color: 0xffd60a, side: THREE.DoubleSide });
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), poleMat);
        pole.position.y = 0.8;
        pole.castShadow = true;
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.32, 6, 1), flagMat);
        flag.position.set(0.24, 1.42, 0);
        g.add(pole, flag);
        g.position.set((sx * f.length) / 2, 0, (sz * f.width) / 2);
        this.group.add(g);
        this.flagGroups.push(flag);
      }
  }

  private buildStands(teams: TeamInfo[]) {
    const f = this.f;
    const TIERS = 14;
    const tiers = TIERS;
    const stepH = 0.62;
    const stepD = 0.95;
    const gapX = f.length / 2 + f.boardMargin + 5;
    const gapZ = f.width / 2 + f.boardMargin + 4;
    const concrete = new THREE.MeshStandardMaterial({ color: 0x9aa3b5, roughness: 0.9 });
    const seatColors = [new THREE.Color(teams[0].primary), new THREE.Color(teams[1].primary), new THREE.Color('#e9ecef')];
    const fans: { x: number; y: number; z: number; rot: number; c: THREE.Color }[] = [];
    const sides = [
      { len: gapX * 2 + 10, cx: 0, cz: -gapZ, rot: 0 },
      { len: gapX * 2 + 10, cx: 0, cz: gapZ, rot: Math.PI },
      { len: gapZ * 2 + 6, cx: -gapX, cz: 0, rot: Math.PI / 2 },
      { len: gapZ * 2 + 6, cx: gapX, cz: 0, rot: -Math.PI / 2 },
    ];
    const rng = (() => {
      let s = 99;
      return () => ((s = (s * 16807) % 2147483647) / 2147483647);
    })();
    sides.forEach((sd, si) => {
      const g = new THREE.Group();
      // the camera side (+z) gets a low open stand so it never blocks the broadcast view
      const near = si === 1;
      const tiers = near ? 5 : TIERS;
      // stepped concrete
      for (let t = 0; t < tiers; t++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(sd.len, stepH * (t + 1), stepD), concrete);
        step.position.set(0, (stepH * (t + 1)) / 2, -(t * stepD + stepD / 2));
        step.receiveShadow = true;
        g.add(step);
      }
      g.position.set(sd.cx, 0, sd.cz);
      g.rotation.y = sd.rot;
      this.group.add(g);
      if (!near) {
      // back wall + roof
      const wall = new THREE.Mesh(new THREE.BoxGeometry(sd.len, stepH * tiers + 6, 0.6), new THREE.MeshStandardMaterial({ color: 0x5a6378 }));
      wall.position.set(0, (stepH * tiers + 6) / 2, -tiers * stepD - 0.3);
      g.add(wall);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(sd.len + 2, 0.5, tiers * stepD + 4), new THREE.MeshStandardMaterial({ color: 0xe8ecf2, roughness: 0.5 }));
      roof.position.set(0, stepH * tiers + 5.5, -tiers * stepD / 2 + 1.5);
      roof.rotation.x = -0.08;
      roof.castShadow = true;
      g.add(roof);
      // stripe on the roof edge
      const trim = new THREE.Mesh(new THREE.BoxGeometry(sd.len + 2, 0.6, 0.3), new THREE.MeshStandardMaterial({ color: new THREE.Color(teams[si % 2].primary), emissive: new THREE.Color(teams[si % 2].primary), emissiveIntensity: 0.3 }));
      trim.position.set(0, stepH * tiers + 5.3, 3.4);
      g.add(trim);
      }
      // fans on each step
      const half = sd.len / 2 - 1;
      for (let t = 0; t < tiers; t++) {
        for (let x = -half; x < half; x += 0.62) {
          if (rng() < 0.12) continue;
          // home end is busier with home colours
          const r = rng();
          const team = si === 3 ? 1 : si === 2 ? 0 : r < 0.5 ? 0 : 1;
          const c = rng() < 0.6 ? seatColors[team].clone() : new THREE.Color().setHSL(rng(), 0.55, 0.55);
          c.offsetHSL(0, 0, (rng() - 0.5) * 0.15);
          const local = new THREE.Vector3(x + (rng() - 0.5) * 0.15, stepH * (t + 1), -(t * stepD + stepD / 2));
          local.applyAxisAngle(new THREE.Vector3(0, 1, 0), sd.rot);
          fans.push({ x: local.x + sd.cx, y: local.y, z: local.z + sd.cz, rot: sd.rot, c });
        }
      }
    });
    // corner fill blocks
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const block = new THREE.Mesh(new THREE.BoxGeometry(tiers * stepD + 5, stepH * tiers + 6, tiers * stepD + 5), new THREE.MeshStandardMaterial({ color: 0x5a6378 }));
        block.position.set(sx * (gapX + (tiers * stepD) / 2 + 2), (stepH * tiers + 6) / 2, sz * (gapZ + (tiers * stepD) / 2 + 2));
        this.group.add(block);
      }

    const geo = crowdGeometry();
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const uniforms = this.crowdUniforms;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uniforms.uTime;
      sh.uniforms.uHype = uniforms.uHype;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uHype;\nattribute float isBody;\nvarying float vBody;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vBody = isBody;
          float seed = float(gl_InstanceID) * 12.9898;
          float ph = fract(sin(seed) * 43758.5453) * 6.2831;
          float jump = max(0.0, sin(uTime * (7.0 + fract(seed) * 3.0) + ph));
          transformed.y += jump * (0.05 + 0.55 * uHype) ;
          transformed.x += sin(uTime * 1.5 + ph) * 0.03;`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vBody;')
        .replace('#include <color_fragment>', '#include <color_fragment>\nif (vBody < 0.5) diffuseColor.rgb = vec3(0.96, 0.78, 0.62);');
    };
    const mesh = new THREE.InstancedMesh(geo, mat, fans.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    fans.forEach((fan, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), fan.rot);
      m4.compose(new THREE.Vector3(fan.x, fan.y, fan.z), q, new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, fan.c);
    });
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  private buildFloodlights() {
    const f = this.f;
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a5266, metalness: 0.4, roughness: 0.6 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6d8, emissiveIntensity: 2.2 });
    const glowTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,250,230,1)');
      gr.addColorStop(0.25, 'rgba(255,240,200,0.45)');
      gr.addColorStop(1, 'rgba(255,240,200,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    })();
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const x = sx * (f.length / 2 + f.boardMargin + 18);
        const z = sz * (f.width / 2 + f.boardMargin + 16);
        const h = 34;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, h, 8), mat);
        pole.position.set(x, h / 2, z);
        this.group.add(pole);
        const panel = new THREE.Mesh(new THREE.BoxGeometry(6, 3.5, 0.6), lampMat);
        panel.position.set(x, h + 1.5, z);
        panel.lookAt(0, 0, 0);
        this.group.add(panel);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 }));
        glow.scale.set(16, 16, 1);
        glow.position.copy(panel.position);
        this.group.add(glow);
      }
  }

  update(dt: number, time: number) {
    this.crowdUniforms.uTime.value = time;
    this.crowdUniforms.uHype.value = Math.max(0, this.crowdUniforms.uHype.value - dt * 0.12);
    for (const fl of this.flagGroups) fl.rotation.y = Math.sin(time * 2.2 + fl.id) * 0.35;
  }

  hype(v: number) {
    this.crowdUniforms.uHype.value = Math.max(this.crowdUniforms.uHype.value, v);
  }
}

/** Gradient sky dome with a few soft cartoon clouds. */
export function makeSky() {
  const geo = new THREE.SphereGeometry(600, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { top: { value: new THREE.Color('#3d7fd6') }, bottom: { value: new THREE.Color('#cfe8ff') } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader:
      'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(vP.y*1.6+0.05,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, pow(h,0.8)),1.0); }',
  });
  const sky = new THREE.Mesh(geo, mat);
  const group = new THREE.Group();
  group.add(sky);
  const cloudTex = (() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = 'white';
    for (const [x, y, r] of [[70, 80, 40], [120, 60, 52], [175, 78, 40], [100, 90, 34], [150, 92, 36]]) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    return new THREE.CanvasTexture(c);
  })();
  for (let i = 0; i < 14; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
    const a = (i / 14) * Math.PI * 2 + Math.random() * 0.3;
    const r = 380 + Math.random() * 120;
    s.position.set(Math.cos(a) * r, 90 + Math.random() * 110, Math.sin(a) * r);
    const sc = 90 + Math.random() * 80;
    s.scale.set(sc, sc / 2, 1);
    group.add(s);
  }
  return group;
}
