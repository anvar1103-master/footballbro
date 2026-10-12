import * as THREE from 'three';

/** Pooled particles: grass/dust puffs on kicks & tackles and goal confetti. */

interface Particle {
  alive: boolean;
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  spin: number;
  rot: number;
  color: THREE.Color;
  gravity: number;
  drag: number;
}

export class Particles {
  mesh: THREE.InstancedMesh;
  private ps: Particle[] = [];
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();

  constructor(max = 900) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < max; i++) {
      this.ps.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, size: 0.1, spin: 0, rot: 0, color: new THREE.Color(), gravity: 9.8, drag: 1, });
      this.mesh.setColorAt(i, new THREE.Color(1, 1, 1));
    }
    this.mesh.count = 0;
  }

  private spawn(): Particle | null {
    for (const p of this.ps) if (!p.alive) return p;
    return null;
  }

  grass(pos: THREE.Vector3, strength: number) {
    const n = Math.min(26, 6 + Math.floor(strength));
    for (let i = 0; i < n; i++) {
      const p = this.spawn();
      if (!p) return;
      p.alive = true;
      p.p.set(pos.x, 0.05, pos.z);
      const a = Math.random() * Math.PI * 2;
      const s = 1 + Math.random() * (1.5 + strength * 0.08);
      p.v.set(Math.cos(a) * s, 1.5 + Math.random() * 2.5, Math.sin(a) * s);
      p.life = 0;
      p.max = 0.5 + Math.random() * 0.4;
      p.size = 0.06 + Math.random() * 0.08;
      p.spin = (Math.random() - 0.5) * 20;
      p.rot = 0;
      p.gravity = 9.8;
      p.drag = 2;
      p.color.setHSL(0.27 + Math.random() * 0.05, 0.6, 0.3 + Math.random() * 0.2);
    }
  }

  confetti(center: THREE.Vector3, colors: string[]) {
    for (let i = 0; i < 380; i++) {
      const p = this.spawn();
      if (!p) return;
      p.alive = true;
      p.p.set(center.x + (Math.random() - 0.5) * 30, 14 + Math.random() * 10, center.z + (Math.random() - 0.5) * 30);
      p.v.set((Math.random() - 0.5) * 3, -Math.random() * 2, (Math.random() - 0.5) * 3);
      p.life = 0;
      p.max = 4 + Math.random() * 3;
      p.size = 0.25 + Math.random() * 0.2;
      p.spin = (Math.random() - 0.5) * 12;
      p.rot = Math.random() * 6;
      p.gravity = 1.2;
      p.drag = 1.5;
      p.color.set(colors[i % colors.length]);
    }
  }

  update(dt: number) {
    let n = 0;
    for (const p of this.ps) {
      if (!p.alive) continue;
      p.life += dt;
      if (p.life > p.max) {
        p.alive = false;
        continue;
      }
      p.v.y -= p.gravity * dt;
      p.v.multiplyScalar(Math.exp(-p.drag * dt));
      p.p.addScaledVector(p.v, dt);
      if (p.p.y < 0.02) {
        p.p.y = 0.02;
        p.v.set(0, 0, 0);
      }
      p.rot += p.spin * dt;
      const fade = 1 - Math.max(0, (p.life - p.max * 0.7) / (p.max * 0.3));
      this.e.set(p.rot, p.rot * 0.7, p.rot * 0.3);
      this.q.setFromEuler(this.e);
      const s = p.size * fade;
      this.m4.compose(p.p, this.q, new THREE.Vector3(s, s, s));
      this.mesh.setMatrixAt(n, this.m4);
      this.mesh.setColorAt(n, p.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
