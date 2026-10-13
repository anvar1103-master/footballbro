import * as CANNON from 'cannon-es';

/**
 * Thin physics layer over cannon-es (pure JavaScript — no WebAssembly, so it runs under strict
 * CSPs like claude.ai artifact pages). Exposes the small rigid-body API the party code uses.
 */

export type V3 = { x: number; y: number; z: number };
export type Tag = 'ground' | 'wall' | 'post' | 'net' | 'ball' | 'bro';

const G_WORLD = 1; // ground, walls, posts, nets
const G_BALL = 2;
const G_BRO = 4;

export class PBody {
  constructor(public b: CANNON.Body) {}
  translation(): V3 {
    const p = this.b.position;
    return { x: p.x, y: p.y, z: p.z };
  }
  rotation() {
    const q = this.b.quaternion;
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  }
  linvel(): V3 {
    const v = this.b.velocity;
    return { x: v.x, y: v.y, z: v.z };
  }
  angvel(): V3 {
    const v = this.b.angularVelocity;
    return { x: v.x, y: v.y, z: v.z };
  }
  mass() {
    return this.b.mass;
  }
  setTranslation(v: V3, _wake?: boolean) {
    this.b.position.set(v.x, v.y, v.z);
    this.b.previousPosition.set(v.x, v.y, v.z);
  }
  setRotation(q: { x: number; y: number; z: number; w: number }, _wake?: boolean) {
    this.b.quaternion.set(q.x, q.y, q.z, q.w);
  }
  setLinvel(v: V3, _wake?: boolean) {
    this.b.velocity.set(v.x, v.y, v.z);
  }
  setAngvel(v: V3, _wake?: boolean) {
    this.b.angularVelocity.set(v.x, v.y, v.z);
  }
  applyImpulse(v: V3, _wake?: boolean) {
    this.b.applyImpulse(new CANNON.Vec3(v.x, v.y, v.z));
  }
  applyImpulseAtPoint(v: V3, p: V3, _wake?: boolean) {
    const c = this.b.position;
    this.b.applyImpulse(new CANNON.Vec3(v.x, v.y, v.z), new CANNON.Vec3(p.x - c.x, p.y - c.y, p.z - c.z));
  }
  applyTorqueImpulse(t: V3, _wake?: boolean) {
    const dw = this.b.invInertiaWorld.vmult(new CANNON.Vec3(t.x, t.y, t.z));
    this.b.angularVelocity.vadd(dw, this.b.angularVelocity);
  }
}

export class PWorld {
  w: CANNON.World;
  mats: Record<Tag, CANNON.Material>;
  /** called when the ball touches a tagged body: (tag, impact speed, the other body) */
  onBallHit: ((tag: Tag, speed: number, other: CANNON.Body) => void) | null = null;

  constructor(gravity: number) {
    const w = new CANNON.World({ gravity: new CANNON.Vec3(0, gravity, 0) });
    w.broadphase = new CANNON.SAPBroadphase(w);
    (w.solver as CANNON.GSSolver).iterations = 12;
    w.allowSleep = false;
    this.w = w;
    const m = (n: Tag) => new CANNON.Material(n);
    this.mats = { ground: m('ground'), wall: m('wall'), post: m('post'), net: m('net'), ball: m('ball'), bro: m('bro') };
    const cm = (a: Tag, b: Tag, friction: number, restitution: number) =>
      w.addContactMaterial(new CANNON.ContactMaterial(this.mats[a], this.mats[b], { friction, restitution }));
    cm('ball', 'ground', 0.4, 0.62);
    cm('ball', 'wall', 0.2, 0.75); // inflatable walls: boing
    cm('ball', 'post', 0.1, 0.8);
    cm('ball', 'net', 0.9, 0.0);
    cm('ball', 'bro', 0.3, 0.45); // bouncy beans
    cm('bro', 'ground', 0, 0.05); // feet don't grip: locomotion is impulse-driven (grip would trip them)
    cm('bro', 'wall', 0.1, 0.6);
    cm('bro', 'bro', 0.2, 0.25);
    cm('bro', 'post', 0.1, 0.2);
    cm('bro', 'net', 0.5, 0.0);
  }

  private add(body: CANNON.Body, tag: Tag) {
    (body as CANNON.Body & { tag?: Tag }).tag = tag;
    this.w.addBody(body);
    return body;
  }

  ground() {
    const b = new CANNON.Body({ mass: 0, material: this.mats.ground, collisionFilterGroup: G_WORLD });
    b.addShape(new CANNON.Plane());
    b.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    return this.add(b, 'ground');
  }

  box(tag: Tag, hx: number, hy: number, hz: number, x: number, y: number, z: number, yaw = 0) {
    const b = new CANNON.Body({ mass: 0, material: this.mats[tag], position: new CANNON.Vec3(x, y, z), collisionFilterGroup: G_WORLD });
    b.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
    if (yaw) b.quaternion.setFromEuler(0, yaw, 0);
    return this.add(b, tag);
  }

  setGravity(g: number) {
    this.w.gravity.set(0, g, 0);
  }

  /** resize a sphere body (the ball) in place */
  setSphereRadius(body: PBody, r: number, mass: number) {
    const s = body.b.shapes[0] as CANNON.Sphere;
    s.radius = r;
    s.updateBoundingSphereRadius();
    body.b.mass = mass;
    body.b.updateBoundingRadius();
    body.b.updateMassProperties();
    body.b.aabbNeedsUpdate = true;
  }

  /** cylinder along Y, optionally turned to lie along Z */
  cylinder(tag: Tag, r: number, halfLen: number, x: number, y: number, z: number, alongZ = false) {
    const b = new CANNON.Body({ mass: 0, material: this.mats[tag], position: new CANNON.Vec3(x, y, z), collisionFilterGroup: G_WORLD });
    b.addShape(new CANNON.Cylinder(r, r, halfLen * 2, 10));
    if (alongZ) b.quaternion.setFromEuler(Math.PI / 2, 0, 0);
    return this.add(b, tag);
  }

  ball(r: number, mass: number, linDamp: number, angDamp: number) {
    const b = new CANNON.Body({
      mass,
      material: this.mats.ball,
      linearDamping: linDamp,
      angularDamping: angDamp,
      collisionFilterGroup: G_BALL,
      collisionFilterMask: G_WORLD | G_BRO,
    });
    b.addShape(new CANNON.Sphere(r));
    b.addEventListener('collide', (e: { body: CANNON.Body & { tag?: Tag }; contact: CANNON.ContactEquation }) => {
      const tag = e.body.tag;
      if (!tag || !this.onBallHit) return;
      const speed = Math.abs(e.contact.getImpactVelocityAlongNormal());
      this.onBallHit(tag, speed, e.body);
    });
    this.add(b, 'ball');
    return new PBody(b);
  }

  /** capsule approximated by three overlapping spheres */
  capsule(r: number, halfHeight: number, mass: number, x: number, y: number, z: number, linDamp: number, angDamp: number) {
    const b = new CANNON.Body({
      mass,
      material: this.mats.bro,
      position: new CANNON.Vec3(x, y, z),
      linearDamping: linDamp,
      angularDamping: angDamp,
      collisionFilterGroup: G_BRO,
      collisionFilterMask: G_WORLD | G_BALL | G_BRO,
    });
    b.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, -halfHeight, 0));
    b.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, 0, 0));
    b.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, halfHeight, 0));
    // capsule-like inertia (the 3-sphere AABB estimate is fine but make it a touch rounder)
    b.updateMassProperties();
    this.add(b, 'bro');
    return new PBody(b);
  }

  private ray = new CANNON.RaycastResult();
  /** is there world geometry (not bros/ball) within `len` straight below `p`? */
  groundBelow(p: V3, len: number) {
    this.ray.reset();
    return this.w.raycastClosest(new CANNON.Vec3(p.x, p.y, p.z), new CANNON.Vec3(p.x, p.y - len, p.z), { collisionFilterMask: G_WORLD, skipBackfaces: true }, this.ray);
  }

  step(dt: number) {
    // two sub-steps: fast balls vs thin posts
    this.w.step(dt / 2);
    this.w.step(dt / 2);
  }
}
