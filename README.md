# Nebula Harrier

A zero-external-asset browser rail shooter: super-scaler rail perspective, a cinematic "Golden Hour" art style (physically based lighting, a low sun with long shadows, lit clouds over canyon ridgelines, film grade and bloom), and a roguelite run loop. TypeScript + Three.js r160 + Web Audio, built with Vite.

## Run

```sh
npm install
npm run dev       # bakes sprites, starts the dev server
npm run build     # bake + typecheck + production build into dist/
npm run preview   # serve dist/
```

Debug query flags: `?fps` (FPS / pixel-ratio / quality / draw-call meter), `?quick` (10s sectors), `?god`, `?sector=N`, `?autostart` (skips the menus straight into a sector; add `&warmup=N` to simulate N seconds before the first frame), `?debug` (exposes `window.__nh`).

## Deploy

Pushing to `master` runs `.github/workflows/deploy.yml`, which builds the game and publishes `dist/` to GitHub Pages at <https://tjeffree.github.io/Nebula-Harrier/>. To turn it on, open the repository's **Settings → Pages** and set **Source** to **GitHub Actions**. The Vite `base` is `./`, so the build works under any sub-path.

## Controls

| Action | Keyboard / Mouse | Touch | Gamepad |
| --- | --- | --- | --- |
| Move | WASD / Arrows | Left-half floating stick | Left stick / D-pad |
| Fire | Space / LMB | FIRE button | RT (7) / A (0) |
| Evade | Shift + direction | Double-tap stick, then push | LB (4) |
| Pause | Esc / P | II icon | Start (9) |

## Assets

There are no hand-made assets. `tools/bake-sprites.mjs` computes the 4×4 billboard atlas pixel by pixel (tracer bolts, plasma orbs, glints, an 8-frame fireball-to-smoke flipbook, mines, the distant-enemy silhouette, shockwave rings and smoke billows) and writes it with `sharp` into `public/sprites/atlas.png`. The bake runs on every `dev` and `build`, and the output is git-ignored. If the atlas is missing, the game draws a fallback atlas at runtime. Meshes, shaders, SFX and music are all generated in code.

## Layout

```
src/audio      SoundSynth (SFX graphs, engine hum), MusicTrackGen (138 BPM FM arpeggiator)
src/core       Engine (renderer, camera, sun + sky lighting, HDR post: bloom, ACES, film grade; adaptive resolution/MSAA/bloom), InputManager, EventBus
src/entities   Player, EnemyBase, EnemyVariants (Wyrm, Sentinel, Titan, Boss, rock spires), ProjectileSystem
src/procgen    ModelFactory (hard-surface models), Shaders, SectorBuilder (time-of-day palettes, D(t,S), elite modifiers, node map, wave director)
src/roguelite  BoonRegistry (boons, synergies, archetypes), MetaStore (obfuscated localStorage)
src/main.ts    Bootstrap + run state machine, HUD and menus
```
