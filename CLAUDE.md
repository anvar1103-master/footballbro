# Footballbro — project map for Claude

Cartoon 3D football (soccer) game. Browser, **Three.js + TypeScript + Vite**. No backend.
Focus: realistic ball physics (drag, Magnus curl/"finesse", spin bounces), a cloth goal net that ripples,
fun arcade gameplay, cute visuals. Rules are intentionally basic (no offside, no cards).
The user writes in Russian — answer in Russian. UI strings are Russian.

## Commands
- `npm run dev` — dev server (http://localhost:5173). Debug query params:
  `?watch` AI vs AI · `?autostart` skip menu · `&size=5|7|11` · `&half=<sec>` · `&speed=<x>` sim speed · `&lq` low quality (no shadows; use in headless Chromium)
- `npm test` — vitest (ball physics + solvers in `tests/ball.test.ts`, human controls + full match in `tests/human.test.ts`)
- `npm run sim -- [matches] [size] [halfSec] [seed]` — **headless AI-vs-AI match runner** (`scripts/simulate.ts`): goals, shots, pass completion, ball-x histogram, stalls, NaN. Run it after any change in `src/sim/`. Healthy (11v11, 120 s halves): ~1–3 goals, ~10 shots, pass completion ≥55%, 0 stalls, 0 NaN.
- `npm run shots` — Playwright screenshots (`scripts/screenshot.ts`, needs dev server running; Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, swiftshader is slow ≈2 fps → use `&lq`, `&speed`).
- `npm run build` — typecheck + production build to `dist/` (relative base `./`).
- `npx vite build --outDir .scratch/single-build && python3 -I scripts/build-single.py .scratch/single-build <out.html>` — ONE self-contained HTML (models inlined via window.__FB_MODELS); this is what is published to the artifact.
- `scripts/build-artifact.sh <outDir>` — bundle for claude.ai artifact hosting (.glb not served there → models converted to `*.gltf.json` via `scripts/glb2gltf.py`, `VITE_MODEL_EXT` env). Published playable build: https://claude.ai/artifact/1pQLJehMiRup8dydP6x37b (republish with Artifact tool, url=that link, files map of outDir).
- `.github/workflows/pages.yml` deploys `dist/` to GitHub Pages on push to main (user must enable Pages → Source: GitHub Actions).
- `.scratch/` is gitignored — put throwaway debug scripts there (run with `npx tsx .scratch/x.ts`).

## Architecture (sim is pure logic, renderer only reads snapshots)
```
src/sim/            — deterministic simulation, no DOM/WebGL (runs in node)
  config.ts         — ALL tuning constants (BALL, PLAYER, field sizes per team size, DIFFICULTY). SIM_DT = 1/120
  ball.ts           — Ball rigid body: drag, Magnus, bounce w/ spin-slip friction, rolling, posts/crossbar, soft goal net (inGoal flag), boards
  kick.ts           — kick solvers that aim by running the real integrator: solveShot (Newton on yaw/pitch → curl lands exactly on target), solveGroundPass, solveLob, predictPath
  player.ts         — Player state, locomotion (accel/turn limits), actions: kick|tackle|slide|fallen|dive|throw|celebrate; `anim` hint for renderer
  team.ts           — TeamInfo presets (fictional clubs), FORMATIONS per size (x 0=own goal..1=opp goal, z -1..1), roster/stats, CHARACTER_MODELS
  match.ts          — Match: state machine (kickoff/play/goal/setpiece/halftime/fulltime), possession & dribble, loose-ball control/deflection,
                      orderKick→fireKick, tackles/slides/fouls, GK dive & catch, rules (goal, throw-in, corner, goal kick, free kick, penalty), events[]
  ai.ts             — formationTarget, pass evaluation (laneSafety, passOptions), shotAim (+finesse curl sign), team roles (chaser/cover), carrier decisions, set-piece takers, gkThink/gkDistribute
  human.ts          — human input → controlled player (stick: right=+x, up=-z because camera looks toward -z); shot charge; auto-switch
  rng.ts            — seeded PRNG
src/render/         — three.js
  game.ts           — GameRenderer: scene, lights, shadows, owns all views; draw(FrameView) used for live AND replay
  view.ts           — FrameView/PlayerView snapshots (captureFrame) + ReplayBuffer
  players.ts        — loads Kenney GLBs, runtime kit recolouring (finds shirt/shorts/socks palette swatches via skin joints), PlayerActor anim mapping
  net.ts            — GoalNet Verlet cloth (roof+back strip + 2 side panels), ball pushes particles; LineSegments
  ball.ts           — procedural truncated-icosahedron ball texture, spin rotation, blob shadow, additive trail ribbon
  stadium.ts        — canvas pitch texture (stripes+lines), goals frame, ad boards, corner flags, stands, instanced crowd (shader bounce, hype), floodlights, sky
  camera.ts         — CameraRig: broadcast presets (C to cycle), replay angles (behind goal / beside post)
  effects.ts        — pooled particles (grass puffs, confetti)
src/ui/             — menu.ts (team/format/length/difficulty, localStorage), hud.ts (scoreboard, banners, toasts, power bar, radar, pause/full-time panels), style.css
src/input/input.ts  — keyboard + gamepad → InputState
src/audio/sound.ts  — WebAudio synthesized sfx (kick, bounce, post, net, whistle, crowd bed/reactions); no audio files
src/main.ts         — boot (asset loading), Session (fixed-step loop, events→audio/HUD/fx, replay director, pause/full time)
public/assets/characters/ — Kenney Mini Characters GLBs (CC0) + Textures/colormap.png
```

## Key conventions / gotchas
- Field: goals at x = ±length/2; team.attackDir ±1 flips at half time. Screen right = +x.
- Kenney clip names used: idle, walk, sprint, jump, sit (slide), die (fallen), attack-kick-right (kick), attack-kick-left (tackle), holding-both(-shoot), emote-yes.
- Visual ball is 1.3× physical radius (BALL_VIS_SCALE) — keep net cloth collision radius in sync.
- Sim never imports render code. Render reads `Match` only via `captureFrame`.
- Events (`match.events`) are consumed & cleared by main.ts each step (and by the sim runner).
- Commit messages: no model ids. Develop on the branch given by the session.

## Possible next steps (ideas)
Headers/volleys, player stamina, cards, offside (user said not needed yet), better GK animations, commentary text, mobile touch controls, more stadium dressing.
