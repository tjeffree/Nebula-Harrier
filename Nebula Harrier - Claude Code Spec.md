# **Nebula Harrier: Technical Game Specification**

# **System Engineering Directive for Claude Code**

This specification details architectural, mathematical, and algorithmic requirements for implementing *Nebula Harrier*, a production-grade, zero-external-asset browser rail shooter combining 1980s/1990s pseudo-3D arcade dynamics with modern roguelite loops. Implement all modules purely in standard web technologies (TypeScript, Three.js via CDN or bundling, Web Audio API, Canvas 2D / WebGL).

# **1\. Project Overview & Architecture**

## **Target Platform & Runtime Specs**

* Environment: HTML5, modern evergreen mobile & desktop browsers (Chrome, Safari iOS, Firefox, Edge).  
* Frameworks: Clean modular TypeScript using standard Three.js (r160+) core modules. No external model loaders (`GLTFLoader`, `OBJLoader`) or audio decoders are permitted.  
* Target Performance: Locked 60 FPS on standard mobile (A13 / Snapdragon 7xx equivalents) and 120+ FPS on modern desktop configurations.  
* Packaging: Single-entry web build, self-contained single-page application footprint under 1.5MB total gzipped code.

## **Rendering Architecture**

* Render Engine: Three.js `WebGLRenderer` configured with `powerPreference: "high-performance"`, `antialias: false` (to emulate sharp retro styling and maintain overhead headroom), and fixed internal render resolutions scaling dynamically via `pixelRatio` clamping (1.0x to 1.5x max).  
* Responsive Viewport: Canvas auto-resizes to dynamic parent bounds (`window.innerWidth`, `window.innerHeight`). Landscape orientation enforced on mobile via CSS orientation lock overlays.

# **2\. Core Gameplay & Arcade Physics Engine**

## **Perspective & Camera Configuration**

Emulate early 90s sprite-scaling and super-scaler arcade perspective using a specialized Three.js perspective camera setup:

* Camera Setup: Fixed at position `(0, 3.5, 9.0)`, looking down negative Z toward `(0, 1.5, -60.0)`. Field of View (FOV) set strictly to 58°.  
* Playfield Boundary: X clamped between `[-9.5, 9.5]`, Y clamped between `[0.2, 7.5]`.  
* Vanishing Point: Horizon centered vertically at 45% screen height. The camera must implement a slight non-linear horizontal lag (`camera.position.x = lerp(camera.position.x, player.position.x * 0.18, 0.08)`).

## **Character Physics & Momentum**

The character does not fly as a spaceship; it follows a running/hovering kinematic paradigm:

* Ground State: If `position.y <= 0.25`, the character runs along the ground (trigger dynamic footing animations via procedural bone rotation or mesh oscillation).  
* Airborne State: Upward flight induces immediate banking and vertical ascent up to `y = 7.5`.  
* Inertia Model: Kinematic position calculation with responsive drag:

\$\$\\mathbf{v}\_{t+1} \= (\\mathbf{v}*t \+ \\mathbf{a}*{\\text{input}} \\cdot \\Delta t) \\cdot (1 \- \\gamma \\cdot \\Delta t)\$\$

\$\$\\mathbf{p}\_{t+1} \= \\mathbf{p}*t \+ \\mathbf{v}*{t+1} \\cdot \\Delta t\$\$

Where linear acceleration \$\\mathbf{a}\_{\\text{input}} \= 48.0\\ \\text{units/s}^2\$ and damping coefficient \$\\gamma \= 6.5\$.

* Roll/Banking: Mesh rotation on Z-axis mapped directly to X velocity: `mesh.rotation.z = -velocity.x * 0.045`. Pitch mapped to Y velocity: `mesh.rotation.x = velocity.y * 0.02`.

## **Control Mapping Matrix**

| Input Action | Desktop (Keyboard / Mouse) | Mobile (Touch / On-Screen) | Gamepad (Standard API) |
| :---- | :---- | :---- | :---- |
| Move X / Y | Keys `W, A, S, D` / `Arrow Keys` | Left Virtual Analog Stick | Left Stick (`Axes 0, 1`) / D-Pad |
| Primary Fire | `Space` or `Left Mouse Button` | Dedicated Floating Action Button | Right Trigger (`Button 7`) / `Button 0` |
| Evade / Dash | `Shift` \+ Direction | Double Tap Directional Thumb | Left Bumper (`Button 4`) |
| Pause / Menu | `Escape` / `P` | Top-Right UI Icon | `Start` (`Button 9`) |

# **3\. Roguelite Loops & Run Architecture**

## **Run Loop Flowchart**

* Title State \$\\rightarrow\$ Load Meta-Profile \$\\rightarrow\$ Sector Node Map Selection.  
* Sector Loop: 90-second dynamic survival/encounter rail sequence \$\\rightarrow\$ Boss Phase \$\\rightarrow\$ Sector Clear \$\\rightarrow\$ 3-Card Boon Draft \$\\rightarrow\$ Warp Transition.  
* Failure State: Run death \$\\rightarrow\$ Convert score/kills to "Chronocores" \$\\rightarrow\$ Meta-Shop \$\\rightarrow\$ Run Reset.

## **Sector Wave Generator & Escalation**

Implement a mathematical difficulty scalar \$D(t)\$ that scales along run time and sector index:

\$\$D(t, S) \= S^{1.4} \\cdot \\left(1.0 \+ \\frac{t}{60.0}\\right) \+ \\sum\_{k=1}^{n} \\Omega\_k\$\$

Where \$S\$ is the sector index (1 to 5), \$t\$ is the elapsed sector time in seconds, and \$\\Omega\$ represents active elite modifiers.

Enemy spawn budgets consume difficulty points every cycle:

* Grunts (Drone Wyrms): 1 Point. Straight fly-in, single shot, spiral retreat.  
* Mid-Tiers (Pylon Sentinels): 3 Points. Ground-anchored, sweeping predictive lasers.  
* Elites (Nebula Titans): 8 Points. Geometric multi-stage armor, tracking projectile spreads.

## **Boons & Synergies (Run-Level)**

Upon sector completion, generate 3 pseudorandom cards from a modular boon tree:

* Overcharge Coil: Projectile velocity increases by 25%; basic laser acquires chain-lightning arc to nearest 2 targets within 5 units.  
* Temporal Dash: Evade maneuver gains 0.4s invulnerability window and drops a cluster of 3 stationary antimatter mines.  
* Prism Splitter: Primary cannon splits from single beam to wide 3-way spread pattern at 70% individual projectile damage.  
* Superluminal Engine: Forward rail translation speed increases by 15%; increases point multiplier by 1.5x.

## **Persistent Progression (Meta-Tree)**

Store player progression locally via an obfuscated `localStorage` schema:{

  "chronocores": 1420,

  "upgrades": {

    "hull\_plating": { "tier": 3, "max": 5, "base\_cost": 100, "scalar": 1.7 },

    "thermal\_heatsink": { "tier": 2, "max": 5, "base\_cost": 150, "scalar": 2.0 },

    "core\_flux": { "tier": 1, "max": 3, "base\_cost": 500, "scalar": 2.5 }

  },

  "unlocked\_archetypes": \["STRIKER", "TEMPEST"\]

}

# **4\. Hybrid Procedural & Baked Asset Generation**

Do not import manually created human-made external assets (such as third-party `.gltf`, `.obj`, or audio files). However, a hybrid generation workflow is permitted: the agent may load agent-generated `.png` sprite sheets produced during an offline pre-compile build step. Specifically, write Node.js (utilizing `sharp` or `canvas`) or Python (utilizing `Pillow`) build scripts that programmatically render and bake 2D billboarding sprite sheets and atlases for high-volume entities, including projectiles, distant enemy LODs, and complex particle effects. This hybrid strategy significantly minimizes runtime draw calls and shader overhead on mobile platforms while maintaining the strict prohibition against manual external assets.

## **Visual Aesthetic & Geometry Synthesis**

* Style Archetype: Precision "Vapor-Crystalline" Vector Aesthetic. Low-poly, razor-sharp geometric profiles combined with neon wireframes, emissive facet edges, and dark iridescent materials.  
* Mesh Generation Code Specifications:  
  * Player Harrier: Construct via compound primitives using `THREE.ExtrudeGeometry` for an angular, aerodynamic exo-suit torso. Attach procedural jet engine nacelles with animated vector particles.  
  * Drone Wyrm: Procedurally chained segment instances (`THREE.InstancedMesh`). Dynamic sinusoidal movement across joints:

\$\$\\Delta X\_i \= A \\cdot \\sin(\\omega t \+ i \\cdot \\phi)\$\$

* Horizon Grid: Construct an infinite running checkered/stepped terrain using custom vertex shaders on a large planar mesh (`60 \times 200` units), displacing vertices downward at high Z distances to emulate planetary curvature.

## **Custom Shaders & Post-Processing Emulation**

Use raw `THREE.ShaderMaterial` instances to implement retro hardware styling without external post-processing pipelines:

* CRT Raster & Scanline Shader: A lightweight full-screen quad shader applying horizontal raster lines via `sin(uv.y * screenHeight * 3.14159)`, chromatic aberration offsets on red/blue UV channels (`offset = 0.002 * (pos - 0.5)`), and gentle radial vignette.  
* Edge-Gaze Glow: Calculate custom Fresnel falloff inside fragment shaders to create self-illuminating crystal surfaces without post-processing bloom passes:

\$\$\\text{Intensity} \= \\text{clamp}\\left(1.0 \- \\mathbf{N} \\cdot \\mathbf{V}, 0.0, 1.0\\right)^{2.5}\$\$

## **Procedural Audio Architecture (Web Audio API)**

Instantiate a single global `AudioContext`. Synthesize all sound effects via direct component graphs (Oscillators, Noise Buffers, Bi-quad Filters, Gain Envelopes).// Reference Audio Synthesis: Core Laser SFX

function playProceduralLaser(audioCtx) {

  const osc \= audioCtx.createOscillator();

  const gain \= audioCtx.createGain();

  

  osc.type \= 'sawtooth';

  osc.frequency.setValueAtTime(880, audioCtx.currentTime);

  osc.frequency.exponentialRampToValueAtTime(110, audioCtx.currentTime \+ 0.18);

  

  gain.gain.setValueAtTime(0.3, audioCtx.currentTime);

  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime \+ 0.18);

  

  osc.connect(gain);

  gain.connect(audioCtx.destination);

  

  osc.start();

  osc.stop(audioCtx.currentTime \+ 0.18);

}

Implement procedural sound routines for:

* Engine Hum: Pink noise generation through an automated resonant bandpass filter tracking player speed.  
* Explosion/Impact: White noise buffer injected through a rapid low-pass sweep down to 40 Hz with non-linear gain release.  
* Synth FM Soundtrack: An algorithmic arpeggiator engine cycling 16-step bassline buffers and resonant lead hooks synced to an internal 138 BPM clock.

# **5\. Implementation Roadmap for Claude Code**

Execute the project structure following this exact module directory layout:/src

  ├── /audio

  │     ├── SoundSynth.ts          \# Synthesized SFX generators

  │     └── MusicTrackGen.ts       \# Algorithmic arpeggiator & music generator

  ├── /core

  │     ├── Engine.ts              \# RequestAnimationFrame, resize loop, renderer setup

  │     ├── InputManager.ts        \# Keyboard, touch gestures, virtual stick, gamepad

  │     └── EventBus.ts            \# Decoupled state event system

  ├── /entities

  │     ├── Player.ts              \# Harrier physics, bounding volume, weapons

  │     ├── EnemyBase.ts           \# Shared behavior, pathing logic, instancing

  │     ├── EnemyVariants.ts       \# Drone Wyrms, Sentinels, Bosses

  │     └── ProjectileSystem.ts    \# Instanced particle and bullet manager

  ├── /procgen

  │     ├── ModelFactory.ts        \# Programmatic Three.js geometries & materials

  │     ├── Shaders.ts             \# CRT, Scanline, Grid, and Neon Shaders

  │     └── SectorBuilder.ts       \# Wave difficulty progression formulas

  ├── /roguelite

  │     ├── BoonRegistry.ts        \# Run boons, synergy logic, upgrade cards

  │     └── MetaStore.ts           \# Obfuscated localStorage wrapper for upgrades

  └── main.ts                      \# Entrypoint bootstrap

## **Critical Execution Steps**

1. Bootstrap `Engine.ts` and verify fixed-perspective Three.js scene, camera projection, and zero-error render loop.  
2. Implement `ModelFactory.ts` to construct the procedural player character and checkered horizon plane.  
3. Bind `InputManager.ts` to `Player.ts`, tuning movement damping and banking variables to replicate accurate Space Harrier arcade kinematics.  
4. Establish `ProjectileSystem.ts` using `THREE.InstancedMesh` to guarantee high-performance allocation across thousands of concurrent bullets.  
5. Build the procedural synthesis graphs in `SoundSynth.ts` to confirm audio fires cleanly without thread blocking.  
6. Assemble the run loop, wave spawner, and meta-progression menus. Compile and test under low-power CPU throttling conditions to confirm sustained 60 FPS delivery.

