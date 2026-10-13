import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Ball } from '../src/sim/ball';
import { fieldFor, SIM_DT, BALL } from '../src/sim/config';
import { solveShot, solveGroundPass, solveLob, rollDistance } from '../src/sim/kick';

const field = fieldFor(11);

function fly(from: Vector3, vel: Vector3, spin: Vector3, seconds: number, simple = false) {
  const b = new Ball(field, simple);
  b.place(from.x, from.z, from.y);
  b.vel.copy(vel);
  b.spin.copy(spin);
  const path: Vector3[] = [];
  for (let t = 0; t < seconds; t += SIM_DT) {
    b.step(SIM_DT);
    path.push(b.pos.clone());
  }
  return { b, path };
}

describe('ball physics', () => {
  it('rolls to a stop on grass', () => {
    const { b } = fly(new Vector3(0, BALL.radius, 0), new Vector3(10, 0, 0), new Vector3(), 20);
    expect(b.vel.length()).toBeLessThan(0.05);
    expect(b.pos.x).toBeGreaterThan(15);
    expect(b.pos.x).toBeLessThan(45);
  });

  it('bounces lower each time', () => {
    const { path } = fly(new Vector3(0, 5, 0), new Vector3(0, 0, 0), new Vector3(), 4);
    const peaks: number[] = [];
    for (let i = 1; i < path.length - 1; i++) if (path[i].y > path[i - 1].y && path[i].y >= path[i + 1].y) peaks.push(path[i].y);
    expect(peaks.length).toBeGreaterThan(1);
    expect(peaks[1]).toBeLessThan(peaks[0]);
  });

  it('sidespin curls the ball (Magnus)', () => {
    const { b } = fly(new Vector3(0, 0.2, 0), new Vector3(25, 3, 0), new Vector3(0, 60, 0), 1.0, true);
    // spin +y with v +x -> accel -z
    expect(b.pos.z).toBeLessThan(-1.5);
  });

  it('finesse solver hits the far corner with a curling path', () => {
    const from = new Vector3(30, BALL.radius, 12);
    const target = new Vector3(50, 1.4, -3.0);
    const sol = solveShot(field, from, target, 24, 55, 5);
    const { path } = fly(from, sol.vel, sol.spin, 2, true);
    let hit: Vector3 | null = null;
    for (let i = 1; i < path.length; i++) if (path[i - 1].x < 50 && path[i].x >= 50) hit = path[i];
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.z - target.z)).toBeLessThan(0.25);
    expect(Math.abs(hit!.y - target.y)).toBeLessThan(0.25);
    // initial direction aimed away from target (curl brings it back)
    const straightZ = from.z + ((target.z - from.z) * (path[30].x - from.x)) / (target.x - from.x);
    expect(Math.abs(path[30].z - straightZ)).toBeGreaterThan(0.2);
  });

  it('ground pass arrives near target', () => {
    const from = new Vector3(0, BALL.radius, 0);
    const target = new Vector3(20, BALL.radius, 5);
    const sol = solveGroundPass(from, target, 6);
    const d = Math.hypot(20, 5);
    expect(rollDistance(sol.vel.length(), 6)).toBeGreaterThan(d - 0.5);
  });

  it('lob lands near target', () => {
    const from = new Vector3(0, BALL.radius, 0);
    const target = new Vector3(30, BALL.radius, -8);
    const sol = solveLob(field, from, target, 0.6);
    const { path } = fly(from, sol.vel, sol.spin, 4, true);
    let land: Vector3 | null = null;
    for (let i = 10; i < path.length; i++) if (path[i].y <= BALL.radius + 0.01) { land = path[i]; break; }
    expect(land).not.toBeNull();
    expect(land!.distanceTo(target)).toBeLessThan(1.5);
  });

  it('goal net stops a shot inside the goal', () => {
    const gl = field.length / 2;
    const { b } = fly(new Vector3(gl - 10, 1, 0), new Vector3(30, 0, 0), new Vector3(), 3);
    expect(b.inGoal).toBe(1);
    expect(b.pos.x).toBeGreaterThan(gl);
    expect(b.pos.x).toBeLessThan(gl + field.goalDepthBottom + 0.8);
    expect(b.vel.length()).toBeLessThan(3);
  });

  it('post deflects the ball', () => {
    const { b } = fly(new Vector3(field.length / 2 - 10, 1, field.goalHalfW), new Vector3(25, 0, 0), new Vector3(), 1.0);
    expect(b.vel.x).toBeLessThan(0);
  });
});
