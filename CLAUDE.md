# Footballbro — project map for Claude

## TWO GAMES IN THIS REPO — read first
- **Footballbro = the CURRENT game.** `index.html` → `src/party/`. Clumsy wobbly bros (Fall Guys-like) playing real-rules
  football (5×5 / 7×7 / 11×11, real pitch sizes from `fieldFor`) vs AI, broadcast camera, you control one bro and switch (Q).
  This is what the user tests and what we develop.
  Playable link: https://claude.ai/artifact/BCqgxNdt5aL2t2m8hSNK5v
- **Soccerbro = the OLD FIFA-style game** (renamed from "classic"), kept only as a library of ready code (ball physics, kick solvers, stadium,
  cloth net, kit recolouring, sounds, HUD styles). `classic.html` → `src/main.ts`, `src/sim/`, `src/render/`, `src/ui/`.
  Old link: https://claude.ai/artifact/1pQLJehMiRup8dydP6x37b. Don't develop it further unless asked; reuse from it.
- Roadmap the user agreed: (1) wobbly bros prototype ✔ → (2) full rules + real scale ✔ (kick-offs, halves w/ side swap,
  throw-ins, corners, goal kicks, fouls → free kicks / penalties) → next: polish AI/keepers/assists → (3) dirty tricks:
  shirt grab, shove, flopping for fouls, referee bro with cards → (4) celebrations, pile-ons, replays → (5) later: 3rd-person
  camera mode + playing a single bro. No gamepads (user & friends use keyboard); no local co-op for now; vs AI only.

### Party edition map (src/party/)
```
phys.ts   — thin layer over cannon-es (pure JS! Rapier/WASM is blocked by the artifact CSP). PBody/PWorld, tags, ball-hit callback.
            Bro-ground friction is 0 on purpose (grip tripped them); "down" bros get scrape damping in bro.ts.
bro.ts    — Bro: capsule (3 spheres) kept upright by under-damped PD torque (= wobble); run impulse applied LEAN m above COM;
            states up/down/getup/dive; jump, dive, stamina, kick/shove timers for animation.
world.ts  — PartyWorld: field = fieldFor(size) (real metres), boards as low walls, ball r=0.15 with drag+Magnus+classic rolling
            resistance (so classic groundPassSpeed works), goals+soft net boxes, phases kickoff/play/setpiece/goal/halftime/over,
            SetPiece {kind,taker,pos}, layout() spots, checkBall() → goal/throw-in/corner/goal kick, foul() → free kick/penalty
            (shove in the back / off the ball, dive into a player), kick() (auto line-up for dead balls), throwBall(), shove(),
            human(): called ONCE per step before AI (calling it inside the bro loop caused the old Q-switch bug), passTo follow.
brain.ts  — AI: formationSpot (classic FORMATIONS shifted with ball), chaser/cover/support, laneClear passes, shots in range,
            keeper shuffle/dive/clear, deadBall(): walk to spot; AI takers per set-piece kind.
view.ts   — PartyRenderer: reuses classic Stadium/GoalNet(ball radius param)/ballTexture/buildCharacterModel; procedural limb
            animation on Kenney bones (leg-left/right, arm-left/right, head); dizzy stars; PartyCamera (V = zoom).
main.ts   — menu (layout arrows/WASD), HUD, sounds, pause, full time. Keys: arrows+D kick/S pass/A dive/W jump/E shove/Q switch.
```
Tests: `tests/party.test.ts` (balance, get-up, kick, dive, switch, throw-in, full AI match). Headless: step `PartyWorld`
directly (11v11 ≈ 10× realtime). Bro is ~1.7 m (capsule 1.52 m, MODEL_SCALE 3.05 in view.ts).
Build the link: `VITE_ENTRY=index npx vite build --outDir .scratch/single-party --emptyOutDir && python3 -I scripts/build-single.py .scratch/single-party <scratchpad>/party/index.html Footballbro`, then Artifact publish with url above.
Soccerbro link build: same with `VITE_ENTRY=classic` and title `Soccerbro`.

---
## Soccerbro (old FIFA-style game) reference

Cartoon 3D football (soccer) game. Browser, **Three.js + TypeScript + Vite**. No backend.
Focus: realistic ball physics (drag, Magnus curl/"finesse", spin bounces), a cloth goal net that ripples,
fun arcade gameplay, cute visuals. Rules are intentionally basic (no offside, no cards).
The user writes in Russian — answer in Russian. UI strings are Russian.

## Commands
- `npm run dev` — dev server (http://localhost:5173). Debug query params:
  `?watch` AI vs AI · `?autostart` skip menu · `&size=5|7|11` · `&half=<sec>` · `&speed=<x>` sim speed · `&q=high|medium|low` graphics (`&lq` = low; headless Chromium/swiftshader is ~2 fps, use low + speed)
- `npm test` — vitest (ball physics + solvers in `tests/ball.test.ts`, human controls + full match in `tests/human.test.ts`)
- `npm run sim -- [matches] [size] [halfSec] [seed]` — **headless AI-vs-AI match runner** (`scripts/simulate.ts`): goals, shots, pass completion, ball-x histogram, stalls, NaN. Run it after any change in `src/sim/`. Healthy (11v11, 120 s halves): ~1–3 goals, ~10 shots, pass completion ≥55%, 0 stalls, 0 NaN.
- `npm run shots` — Playwright screenshots (`scripts/screenshot.ts`, needs dev server running; Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, swiftshader is slow ≈2 fps → use `&lq`, `&speed`).
- `npm run build` — typecheck + production build to `dist/` (relative base `./`).
- Single-file builds: `VITE_ENTRY=index|classic npx vite build --outDir <dir> && python3 -I scripts/build-single.py <dir> <out.html> [title]` — ONE self-contained HTML (models inlined via window.__FB_MODELS). Artifact CSP forbids fetch and WASM.
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
  human.ts          — FIFA-style context controls (stick: right=+x, up=-z because camera looks toward -z): hold-to-charge pass/through/lob/shot/finesse/chip,
                      skill feint; defence: pass=jockey, shoot=tackle, lob=slide, through=teammate press; switch candidate; auto-switch
  rng.ts            — seeded PRNG
src/render/         — three.js
  game.ts           — GameRenderer: scene, RoomEnvironment IBL, sun+shadows, EffectComposer (MSAA, bloom on high), quality levels; draw(FrameView) for live AND replay
  view.ts           — FrameView/PlayerView snapshots (captureFrame) + ReplayBuffer
  players.ts        — loads Kenney GLBs, runtime kit recolouring (finds shirt/shorts/socks palette swatches via skin joints), PlayerActor anim mapping
  net.ts            — GoalNet Verlet cloth (roof+back strip + 2 side panels), slack 5%, breeze, ball pushes particles; textured diamond-mesh Mesh (alphaTest, casts shadow)
  ball.ts           — procedural truncated-icosahedron ball texture, spin rotation, blob shadow, additive trail ribbon
  stadium.ts        — canvas pitch texture (stripes+lines), goals frame, ad boards, corner flags, stands, instanced crowd (shader bounce, hype), floodlights, sky
  camera.ts         — CameraRig: TV gantry presets tv/tvclose/high/pro (V cycles, settings.camera), replay angles (behind goal / beside post)
  effects.ts        — pooled particles (grass puffs, confetti)
src/settings.ts     — persisted options: quality, camera preset, volume, key bindings (ACTIONS, PRESETS fifa/wasd, keyLabel)
src/ui/             — menu.ts (team/format/length/difficulty), settingsPanel.ts (rebinding, camera, quality, volume),
                      hud.ts (scoreboard, banners, toasts, player tag = name+stamina+power bar, radar, pause/full-time), style.css
src/input/input.ts  — keyboard (via settings.bindings) + gamepad → InputState; captureHook for rebinding
src/audio/sound.ts  — WebAudio synthesized sfx (kick, bounce, post, net, whistle, crowd bed/reactions); no audio files
src/main.ts         — boot (asset loading), Session (fixed-step loop, events→audio/HUD/fx, replay director, pause/full time)
public/assets/characters/ — Kenney Mini Characters GLBs (CC0) + Textures/colormap.png
```

## Key conventions / gotchas
- Field: goals at x = ±length/2; team.attackDir ±1 flips at half time. Screen right = +x.
- Kenney clip names used: idle, walk, sprint, jump, sit (slide), die (fallen), attack-kick-right (kick), attack-kick-left (tackle), holding-both(-shoot), emote-yes.
- Proportions: 11v11 pitch 105×68, players ~1.45 m (modelScale 2.65), visual ball 1.6× physical (BALL_VIS_SCALE; net cloth uses it).
- UI hotkeys outside bindings: V camera, M mute, Esc/P pause — keep them out of the presets.
- Sim never imports render code. Render reads `Match` only via `captureFrame`.
- Events (`match.events`) are consumed & cleared by main.ts each step (and by the sim runner).
- Commit messages: no model ids. Develop on the branch given by the session.

## Possible next steps (ideas)
User wants FIFA-like gameplay with cartoon characters. Ideas: cards, offside (user said not needed yet), more skill moves, better GK animations, commentary text, mobile touch controls, nicer crowd.
