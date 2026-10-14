# Footballbro — project map for Claude

## TWO GAMES IN THIS REPO — read first
- **Footballbro = the CURRENT game: funny arcade football with crash-test-dummy footballers.** `index.html` → `src/party/`.
  Procedural dummies (yellow plastic, ball joints, bolts, target stickers, faces, detailed kits — no assets) on wobbly
  physics bodies, you control one player in a 3/4/5-a-side team incl. keeper vs AI, normal-size ball at the feet, skill
  moves, aimed + curled shots, volleys, bicycle kicks, headers, slide tackles, shirt grabs, chaos events, ОГОНЬ fire
  shots, instant goal replays, a 6-step tutorial. Indoor football hall (grass, LED boards/ribbons, LED screens above the
  goals, glass walls up to a 12 m roof — no outs, no fouls, no offside), ball dropped at kick-offs, golden goal.
  Default view: TV broadcast camera on the long side following the BALL (your attack goes right).
  Playable link: https://claude.ai/artifact/BCqgxNdt5aL2t2m8hSNK5v · GitHub Pages: https://anvar1103-master.github.io/footballbro/
- History / user decisions: (1) realistic sim with real rules + Mixamo athletes → REJECTED ("FIFA clone, unplayable");
  (2) Fall Guys jelly beans with a giant ball → liked the fun, but "still a Fall Guys clone": wants normal little people
  with arms/legs that move funnily, more ball control, skill moves and beautiful goals. Keep it silly + good-looking.
  (3) then: play with the mouse (aim, LMB pass, RMB shot), crash-test-dummy look, indoor hall without stands/fans (don't
  spend effort on crowds), keep the sweeper ("вертушка") event. Mobile port = later, not now.
  (4) mouse-look camera was too hard ("ball and camera get lost") → fixed camera + cursor aim, FIFA-style marker, auto-switch.
  (5) "still loses the ball, a newbie won't understand anything, be creative, keep it football, better graphics and more
  detailed models" → TV camera following the ball + x-ray ball / landing ring / trail, two main buttons with on-screen
  context prompts + pass-target ring, keyboard auto-aim, receive assist, tutorial, ОГОНЬ meter + fire shot, goal replays,
  detailed dummies, LED screens/boards, colour grading.
  (6) keyboard still felt hard → user's idea: play (almost) only with the MOUSE, like Dota: the player runs to the cursor,
  LMB = pass to the clicked point, RMB = shot to the clicked point, team-mates run and get open by themselves →
  layout 'mouseonly' is the default (keyboard layouts kept as options).
- **Soccerbro = the OLD FIFA-style game**, kept only as a library of ready code (ball physics, cloth net — the user likes
  the goal net —, ball texture, sounds, particles). `classic.html` → `src/main.ts`, `src/sim/`, `src/render/`, `src/ui/`.
  Old link: https://claude.ai/artifact/1pQLJehMiRup8dydP6x37b. Don't develop it further unless asked.
- Mouse + keyboard (no gamepads), vs AI only, no local co-op for now.

### Footballbro map (src/party/)
```
phys.ts   — thin layer over cannon-es (pure JS! WASM is blocked by the artifact CSP). Boxes (with yaw), capsules, ball
            (setSphereRadius for the mega-ball event), setGravity, groundBelow ray, ballGhost (fire shots pass through bros).
bro.ts    — Bro = player body: capsule (r .36, 1.52 m) kept upright by under-damped PD torque (= wobble), run impulse above
            COM (leans), states up/down/getup/dive, jump, stamina; speedMul/accelMul (events, grabs), grabbing, celebrate,
            kickKind/kickSide (animation), skill {rainbow|cut|turn}, fooled (wrong-footed), catchCd (GK), landT (bicycle).
world.ts  — PartyWorld: ARENA 50×32 (also a FieldDims for GoalNet), walls up to HALL_H 12 m + roof + chamfered corners,
            goals 6×2.4 m, ball r .17, DROP_H 6 (kick-off hover/drop). PartyInput.aimX/aimZ/aimDist = mouse cursor point.
            Teams have fire (ОГОНЬ meter 0..1) and combo. addFire(): completed passes (gotBall → 'combo' event, one-touch
            passes count in strike()), skills, tackles, saves, +0.25 to the conceding team, slow passive fill; AI fills
            slower on easy. Full meter → shootAt makes a fire shot (fast, low, 'fire' event, slowmo) → fireBall: ghost ball,
            updateFire() knocks down everyone it passes ('burn'); keeperCatch vs fire: blown into the net or heroic block
            (chance by difficulty, human keeper saves more on easy). endFire() on goal / kick-off / placeBall.
            Human: passChoice() = the receiver (cursor mate / cone mate) → passTarget (HUD ring); assistAim() = keyboard
            shots go at a corner (away from the keeper when aimed at the middle, curlers when wide); headAt() for high balls;
            receive assist (no stick input + a team-mate's pass coming = run to meet it, brain.receivePoint).
            Context buttons when not onBall(): pass = switch player, kick near the opponent carrier = slide tackle.
            dribbleAssist: ball at the feet, never captures a ball moving >15 m/s relative (shots deflect off bodies).
            autoSwitch, keepInside() clamps, keeperCatch, chaos (mega/lowgrav/ice/turbo/sweeper), golden goal.
            Tutorial hooks: scripted Map<Bro, fn> (called instead of the AI), skipCountdown(), placeBall().
            Input is WORLD-space (main.ts maps keys camera-relative).
brain.ts  — AI: supporters of the team on the ball get open (pick the spot farthest from opponents with a clear line); chaser (gets behind the ball, dribbles, shoots at the corner away from the keeper — from further out with a
            full ОГОНЬ meter, volleys, skill moves, passes, lobs, tackles/grabs), keeper(), receivePoint (exported), supporters.
tutorial.ts — Tutorial: 6 drills (run to ball, pass, shoot, tackle, skill, fire shot) on a size-3 world; places players
            (others idle via w.scripted), checks world events, resets on failure; UI callbacks show/praise/finish.
dude.ts   — DudeActor: procedural crash-test dummy (lathe torso/limbs, ball joints with bolts, jaw, target stickers, V-neck
            collar, cuffs, shorts stripes, socks with bands + shin guards, studded boots, name+number on the back; small
            details merged per material). Rig root → flip → rig → pelvis → spine → head/arms; pelvis → legs. Pose targets per
            state smoothed into joint rotations. capture()/applyPose() (POSE_N numbers) for replays.
arena.ts  — indoor hall: grass, emissive scrolling LED ad boards, LED ribbons above the long-side boards, LedScreen above
            each goal (setScoreboard: score/clock/flashing ГОЛ!/ОГОНЬ!/СЕЙВ!), glass + mullions, trusses + light panels,
            sweeper bar. setCutaway(side): hides the glass/ribbon and fades the boards of the long side the TV camera is on.
view.ts   — ChaseCamera: mode 0 TV (default; side = attack dir, follows the ball with lead + pull to your player, pans to
            the goal near the ends, fov 35, shake/punch), 1 high behind, 2 close chase; shot() for replays.
            PartyRenderer: ball drawn BALL_VIS_EXTRA bigger, ballXray (GreaterDepth: seen through players), landing ring +
            drop line, Trail ribbon (fire = flames), team rings, passRing, marker (orange when ОГОНЬ ready), arrow over your
            player, fire fx (shockwave rings, sparks, camera punch), GRADE pass (contrast/saturation/vignette), rim light.
            Replays: record() every frame (ball + all poses, 7 s), startReplay()/drawReplay()/stopReplay(): low tracking shot,
            then beside the post; main.ts runs it ~1.3 s after a goal, any key skips.
main.ts   — menu (ИГРАТЬ / ОБУЧЕНИЕ, 4 control tiles, ОГОНЬ help, teams, length, difficulty, layout, hints, auto-switch),
            HUD (bean.css: score + ОГОНЬ bars, prompts chips under the player tag, flash, ПОВТОР + cinema bars, coach card),
            Session(mode match|watch|tutorial), sounds (fire boom, chimes), events → toasts/banners.
            Layouts: 'mouseonly' (DEFAULT: the controlled player runs to the cursor — walk near it, sprint when > 7 m away;
            LMB pass / RMB shot to the cursor point, wheel scroll or Space = skill, wheel click = lob, E jump; without the
            ball LMB = dash (Bro.boost) and RMB near the carrier = slide; PartyInput.mouseOnly also makes incoming
            passes met automatically even while the cursor points elsewhere), 'mouse' ( WASD/arrows, LMB/J pass, RMB/K shot, MMB/C/L lob, F skill, E tackle, R grab, Q switch,
            Space jump, Shift sprint) and 'keys' (arrows, S pass, D shot, A lob, W/F skill). Cursor aim only while the mouse
            is in use (moved < 2.5 s ago or a mouse button was used last); J/K/L switch prompts to key labels.
            pickTeams(): two kits far apart in sRGB, never the yellow SUN kit (dummies are yellow).
```
Tests: `tests/party.test.ts` (balance, ball drop, get-up, kick, pass arrives, lob lands, dribble hold, tackle, grab,
switching, curled shot goes in, skills, bicycle kick, keeper catch, goal → kick-off, chaos on/off, keyboard assist on
target, pass preview + combo fills ОГОНЬ, fire shot burns through, fast ball not captured, tutorial playthrough, full AI match). Headless: step `PartyWorld` directly (4v4 ≈ 25× realtime).
Debug: `?autostart`, `?watch`, `?tutorial`, `&size=3|4|5`, `&len=<s>`, `&speed=<x>`, `&q=low|medium|high`; `window.__fb` = session.
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
