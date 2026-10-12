import * as THREE from 'three';
import { BALL } from '../sim/config';

/** Visual ball is a little bigger than the physical one so it reads well next to chibi players. */
export const BALL_VIS_SCALE = 1.3;

/** Classic black & white ball: Voronoi of icosahedron (pentagons) + dodecahedron (hexagons) centres. */
function ballTexture() {
  const W = 512, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(W, H);
  const phi = (1 + Math.sqrt(5)) / 2;
  const ico: THREE.Vector3[] = [];
  for (const a of [-1, 1]) for (const b of [-phi, phi]) {
    ico.push(new THREE.Vector3(0, a, b).normalize(), new THREE.Vector3(a, b, 0).normalize(), new THREE.Vector3(b, 0, a).normalize());
  }
  const dod: THREE.Vector3[] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) dod.push(new THREE.Vector3(a, b, c).normalize());
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    dod.push(new THREE.Vector3(0, a / phi, b * phi).normalize(), new THREE.Vector3(a / phi, b * phi, 0).normalize(), new THREE.Vector3(b * phi, 0, a / phi).normalize());
  }
  const p = new THREE.Vector3();
  for (let y = 0; y < H; y++) {
    const lat = (y / H) * Math.PI;
    for (let x = 0; x < W; x++) {
      const lon = (x / W) * Math.PI * 2;
      p.set(Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon));
      let b1 = -2, b2 = -2, pent = false;
      for (const c of ico) {
        const d = p.dot(c) + 0.045; // pentagons slightly bigger
        if (d > b1) { b2 = b1; b1 = d; pent = true; } else if (d > b2) b2 = d;
      }
      for (const c of dod) {
        const d = p.dot(c);
        if (d > b1) { b2 = b1; b1 = d; pent = false; } else if (d > b2) b2 = d;
      }
      const seam = b1 - b2 < 0.012;
      const i = (y * W + x) * 4;
      let v = pent ? 30 : 248;
      if (seam) v = pent ? 20 : 150;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = pent ? v + 10 : v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const TRAIL_N = 48;

export class BallView {
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
  trail: THREE.Mesh;
  private trailPts: THREE.Vector3[] = [];
  private trailGeo: THREE.BufferGeometry;
  private trailAlpha = 0;
  private q = new THREE.Quaternion();
  private lastPos = new THREE.Vector3();
  r = BALL.radius * BALL_VIS_SCALE;

  constructor() {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.r, 32, 16),
      new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.35, metalness: 0.0 }),
    );
    this.mesh.castShadow = true;
    // soft contact shadow (helps read the ball height)
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;

    // trail ribbon (camera-facing-ish horizontal+vertical strip)
    this.trailGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(TRAIL_N * 2 * 3);
    const alpha = new Float32Array(TRAIL_N * 2);
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_N - 1; i++) {
      const a = i * 2, b = a + 1, c2 = a + 2, d = a + 3;
      idx.push(a, b, c2, b, d, c2);
    }
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.trailGeo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    this.trailGeo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { color: { value: new THREE.Color('#fff3b0') } },
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 color; varying float vA; void main(){ gl_FragColor = vec4(color, vA); }',
    });
    this.trail = new THREE.Mesh(this.trailGeo, mat);
    this.trail.frustumCulled = false;
  }

  /** Show the trail for a while (after a hard or curled kick). */
  boostTrail(v = 1) {
    if (this.trailAlpha < 0.05) this.trailPts.length = 0; // start the ribbon at the strike
    this.trailAlpha = Math.max(this.trailAlpha, v);
  }

  resetTrail() {
    this.trailPts.length = 0;
  }

  update(pos: THREE.Vector3, vel: THREE.Vector3, spin: THREE.Vector3, dt: number, camera: THREE.Camera) {
    const lift = this.r - BALL.radius;
    this.mesh.position.set(pos.x, pos.y + lift, pos.z);
    // rotation from spin (falls back to rolling from displacement when spin is tiny)
    let w = spin.clone();
    if (w.lengthSq() < 1) {
      const d = pos.clone().sub(this.lastPos);
      if (d.length() < 2) w.set(d.z, 0, -d.x).divideScalar(Math.max(dt, 1e-3) * BALL.radius);
    }
    const ang = w.length() * dt;
    if (ang > 1e-5 && ang < 3) {
      this.q.setFromAxisAngle(w.normalize(), ang);
      this.mesh.quaternion.premultiply(this.q);
    }
    this.lastPos.copy(pos);
    // shadow
    const h = Math.max(0, pos.y - BALL.radius);
    const s = this.r * 2.6 * (1 + h * 0.25);
    this.shadow.scale.set(s, s, 1);
    this.shadow.position.set(pos.x, 0.02, pos.z);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.15, 1 - h * 0.12);

    // trail
    const speed = vel.length();
    if (speed < 9) this.trailAlpha = Math.max(0, this.trailAlpha - dt * 1.8);
    this.trailPts.unshift(this.mesh.position.clone());
    if (this.trailPts.length > TRAIL_N) this.trailPts.pop();
    const pa = this.trailGeo.getAttribute('position') as THREE.BufferAttribute;
    const aa = this.trailGeo.getAttribute('alpha') as THREE.BufferAttribute;
    const camPos = (camera as THREE.PerspectiveCamera).position;
    for (let i = 0; i < TRAIL_N; i++) {
      const p = this.trailPts[Math.min(i, this.trailPts.length - 1)] ?? this.mesh.position;
      const next = this.trailPts[Math.min(i + 1, this.trailPts.length - 1)] ?? p;
      const dir = p.clone().sub(next);
      const toCam = camPos.clone().sub(p);
      const side = dir.cross(toCam).normalize();
      const k = 1 - i / TRAIL_N;
      const wdt = this.r * 0.7 * k;
      pa.setXYZ(i * 2, p.x + side.x * wdt, p.y + side.y * wdt, p.z + side.z * wdt);
      pa.setXYZ(i * 2 + 1, p.x - side.x * wdt, p.y - side.y * wdt, p.z - side.z * wdt);
      const a = this.trailAlpha * k * k * 0.6 * (i < this.trailPts.length - 1 ? 1 : 0);
      aa.setX(i * 2, a);
      aa.setX(i * 2 + 1, a);
    }
    pa.needsUpdate = true;
    aa.needsUpdate = true;
  }
}
