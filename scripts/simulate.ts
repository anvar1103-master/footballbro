/**
 * Headless match runner: plays AI-vs-AI matches without rendering and prints stats.
 * Usage: npm run sim -- [matches=3] [teamSize=11] [halfLength=150] [seed=1]
 * Use it after touching src/sim/* to check that matches flow (goals, set pieces, no stalls/NaN).
 */
import { Match } from '../src/sim/match';
import { SIM_DT, TeamSize } from '../src/sim/config';
import { TEAM_PRESETS } from '../src/sim/team';

const [nArg, sizeArg, halfArg, seedArg] = process.argv.slice(2);
const N = Number(nArg ?? 3);
const size = Number(sizeArg ?? 11) as TeamSize;
const half = Number(halfArg ?? 150);
const seed0 = Number(seedArg ?? 1);

const totals = { goals: 0, shots: 0, onTarget: 0, saves: 0, stalls: 0, nan: 0, setpieces: {} as Record<string, number>, kicks: {} as Record<string, number>, posts: 0, fouls: 0, tackles: 0, passes: 0, passOk: 0, xHist: new Array(10).fill(0) };
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const m = new Match({ teamSize: size, halfLength: half, difficulty: 'normal', humanTeam: -1, teams: [TEAM_PRESETS[0], TEAM_PRESETS[1]], seed: seed0 + i });
  let still = 0;
  let steps = 0;
  let lastPos = m.ball.pos.clone();
  let pendingPass = -1;
  let lastPassT = -1;
  while (m.phase !== 'fulltime' && steps < 200000) {
    m.step(SIM_DT);
    steps++;
    for (const e of m.events) {
      if (e.type === 'save') totals.saves++;
      if (e.type === 'post') totals.posts++;
      if (e.type === 'foul') totals.fouls++;
      if (e.type === 'tackle') totals.tackles++;
      if (e.type === 'setpiece') totals.setpieces[e.text!] = (totals.setpieces[e.text!] ?? 0) + 1;
      if (e.type === 'kick' && e.kind) totals.kicks[e.kind] = (totals.kicks[e.kind] ?? 0) + 1;
    }
    m.events.length = 0;
    // pass completion: a pass is complete when the next owner is a teammate
    if (m.owner && pendingPass >= 0) {
      totals.passes++;
      if (m.owner.team === pendingPass) totals.passOk++;
      pendingPass = -1;
    }
    if (m.pass && m.pass.t !== lastPassT) {
      lastPassT = m.pass.t;
      pendingPass = m.pass.from.team;
    }
    if (m.phase === 'play' && steps % 30 === 0) totals.xHist[Math.max(0, Math.min(9, Math.floor((m.ball.pos.x / m.field.length + 0.5) * 10)))]++;
    if (!Number.isFinite(m.ball.pos.x) || m.players.some((p) => !Number.isFinite(p.pos.x))) {
      totals.nan++;
      console.log('NaN detected at step', steps);
      break;
    }
    if (m.phase === 'play' || m.phase === 'setpiece' || m.phase === 'kickoff') {
      if (m.ball.pos.distanceTo(lastPos) < 0.05) still += SIM_DT;
      else still = 0;
      lastPos.copy(m.ball.pos);
      if (still > 8) {
        totals.stalls++;
        console.log(`  stall: phase=${m.phase} owner=${m.owner?.name ?? '-'} setPiece=${m.setPiece?.kind ?? '-'} ball=${m.ball.pos.toArray().map((v) => v.toFixed(1))}`);
        still = -1e9;
      }
    }
  }
  const [a, b] = m.teams;
  const poss = (a.possessionT / (a.possessionT + b.possessionT + 1e-6)) * 100;
  console.log(`#${i + 1} ${a.info.short} ${a.score}-${b.score} ${b.info.short} | shots ${a.shots}(${a.shotsOnTarget})-${b.shots}(${b.shotsOnTarget}) | poss ${poss.toFixed(0)}% | goals: ${m.goals.map((g) => `${g.minute}' ${g.scorer}`).join(', ')}`);
  totals.goals += a.score + b.score;
  totals.shots += a.shots + b.shots;
  totals.onTarget += a.shotsOnTarget + b.shotsOnTarget;
}
console.log(`\n${N} matches (${size}v${size}, ${half}s halves) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`avg goals ${(totals.goals / N).toFixed(2)} | shots ${(totals.shots / N).toFixed(1)} (on target ${(totals.onTarget / N).toFixed(1)}) | saves ${(totals.saves / N).toFixed(1)} | posts ${totals.posts} | tackles ${(totals.tackles / N).toFixed(1)} | fouls ${(totals.fouls / N).toFixed(1)}`);
console.log('set pieces', totals.setpieces);
console.log('kicks', totals.kicks);
console.log(`pass completion ${((totals.passOk / Math.max(1, totals.passes)) * 100).toFixed(0)}% of ${totals.passes}`);
const hs = totals.xHist.reduce((a: number, b: number) => a + b, 0);
console.log('ball x distribution (goal -x .. goal +x):', totals.xHist.map((v: number) => ((v / hs) * 100).toFixed(0) + '%').join(' '));
console.log(`stalls ${totals.stalls} | NaN ${totals.nan}`);
