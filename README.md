# Nebula Harrier

A zero-external-asset browser rail shooter: early-90s super-scaler perspective, vapor-crystalline vector visuals, and a roguelite run loop. TypeScript + Three.js r160 + Web Audio, built with Vite.

## Run

```sh
npm install
npm run dev       # bakes sprites, starts the dev server
npm run build     # bake + typecheck + production build into dist/
npm run preview   # serve dist/
```

Debug query flags: `?fps` (FPS / pixel-ratio / draw-call meter), `?quick` (10s sectors), `?god`, `?sector=N`, `?debug` (exposes `window.__nh`).

## Controls

| Action | Keyboard / Mouse | Touch | Gamepad |
| --- | --- | --- | --- |
| Move | WASD / Arrows | Left-half floating stick | Left stick / D-pad |
| Fire | Space / LMB | FIRE button | RT (7) / A (0) |
| Evade | Shift + direction | Double-tap stick, then push | LB (4) |
| Pause | Esc / P | II icon | Start (9) |

## Assets

There are no hand-made assets. `tools/bake-sprites.mjs` generates the 4×4 billboard atlas (bolts, enemy shots, sparks, an 8-frame explosion flipbook, mines, the distant-enemy LOD and glows) as SVG and rasterises it with `sharp` into `public/sprites/atlas.png`. The bake runs on every `dev` and `build`, and the output is git-ignored. If the atlas is missing, the game draws a fallback atlas at runtime. Meshes, shaders, SFX and music are all generated in code.

## Layout

```
src/audio      SoundSynth (SFX graphs, engine hum), MusicTrackGen (138 BPM FM arpeggiator)
src/core       Engine (renderer, camera, CRT pass, dynamic resolution), InputManager, EventBus
src/entities   Player, EnemyBase, EnemyVariants (Wyrm, Sentinel, Titan, Boss, spires), ProjectileSystem
src/procgen    ModelFactory, Shaders, SectorBuilder (D(t,S), elite modifiers, node map, wave director)
src/roguelite  BoonRegistry (boons, synergies, archetypes), MetaStore (obfuscated localStorage)
src/main.ts    Bootstrap + run state machine, HUD and menus
```
