# Footballbro — project map for Claude

## TWO GAMES IN THIS REPO — read first
- **Footballbro = the CURRENT game: "Bean Ball", a Fall Guys-style football party game.** `index.html` → `src/party/`.
  Jelly beans built in code (no character assets), you are ONE bean (crown) in a 3/4/5-a-side team vs AI beans,
  third-person chase camera, giant bouncy ball dropped from the sky at every kick-off, walled sky-island arena
  (no outs, no fouls, no offside), tackles, grabs, headers, chaos events every ~35 s, golden goal on a draw.
  Playable link: https://claude.ai/artifact/BCqgxNdt5aL2t2m8hSNK5v · GitHub Pages: https://anvar1103-master.github.io/footballbro/
- History / user decisions: realistic football sim (real rules, real pitch, Mixamo athletes) was REJECTED by the user
  ("this is just a FIFA clone, impossible to play"). Keep it a funny arcade party game with nice graphics and silly controls.
- **Soccerbro = the OLD FIFA-style game**, kept only as a library of ready code (ball physics, cloth net — the user likes
  the goal net —, sounds, particles). `classic.html` → `src/main.ts`, `src/sim/`, `src/render/`, `src/ui/`.
  Old link: https://claude.ai/artifact/1pQLJehMiRup8dydP6x37b. Don't develop it further unless asked.
- Keyboard only (no gamepads), vs AI only, no local co-op for now.

### Footballbro map (src/party/)
```
phys.ts   — thin layer over cannon-es (pure JS! WASM is blocked by the artifact CSP). Boxes (with yaw), capsules, ball
            (setSphereRadius for the mega-ball event), setGravity, groundBelow ray. Bouncy inflatable walls.
bro.ts    — Bro = bean body: capsule (r .36, 1.52 m) kept upright by under-damped PD torque (= wobble), run impulse above
            COM (leans), states up/down/getup/dive, jump, stamina; speedMul/accelMul (events, grabs), grabbing/grabT, celebrate.
world.ts  — PartyWorld: ARENA 46×30 (also a FieldDims for GoalNet), walls + chamfered corners, goals 7.2×3 m, ball r .5.
            Phases countdown(2.4 s, ball hovers) → play → goal(3.6 s, slow-mo, losers flop) → over; golden goal.
            Actions: shoot (aim assist to goal), passTo (ground, leads the run), lob (lands on target), tackle = dive,
            tryGrab/release, headers on contact while airborne; human() buffers kick/pass/lob ~0.6 s until the ball is
            in reach. dribbleAssist sticky holder. Chaos: mega / lowgrav / ice / turbo / sweeper (rotating bar).
            Input is WORLD-space (main.ts maps keys camera-relative).
brain.ts  — AI per bean: chaser (gets behind the ball, dribbles, shoots, passes when blocked, lobs from wide, tackles/
            grabs the opponent carrier), back bean (guards goal, dives at shots), supporters spread ahead. Uses w.rng.
bean.ts   — BeanActor: glossy capsule with canvas pattern + number (own linear-in-height UVs!), outline hull, googly eyes
            that follow the ball + blinking, smile/“O” mouth, floppy arms (springs), stubby legs, hats (crown = human).
arena.ts  — sky island: pitch texture, extruded slab + rock cone, candy-striped inflatable tubes, goals + arches,
            sweeper bar, spectator beans (instanced), balloons, clouds, mini islands.
view.ts   — PartyRenderer + ChaseCamera (behind the bean looking at the attacked goal, biased to the ball, backs off
            when the ball is behind; V: close / high / TV). Reuses GoalNet (render/net.ts) and Particles.
main.ts   — menu (teams 3/4/5, length, difficulty, layout), HUD (bean.css), sounds, countdown, events, pause, end.
            Keys (arrows layout): arrows run, Shift sprint, Space/W jump, D kick (hold), S pass, A lob, E tackle, Q grab.
            WASD layout: J kick, K pass, L lob, I tackle, U grab, Space jump.
```
Tests: `tests/party.test.ts` (balance, ball drop, get-up, kick power/direction, pass arrives, lob lands, dribble hold,
tackle, grab, goal → kick-off, chaos on/off, full AI match). Headless: step `PartyWorld` directly (4v4 ≈ 25× realtime).
Debug: `?autostart`, `?watch`, `&size=3|4|5`, `&len=<s>`, `&speed=<x>`, `&q=low|medium|high`; `window.__fb` = session.
Build the link: `VITE_ENTRY=index npx vite build --outDir .scratch/single-party --emptyOutDir && python3 -I scripts/build-single.py .scratch/single-party <scratchpad>/party/index.html Footballbro`, then Artifact publish with url above.
Soccerbro link build: same with `VITE_ENTRY=classic` and title `Soccerbro` (embeds the Kenney GLBs).

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
