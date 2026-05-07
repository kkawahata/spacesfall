# Fall Survive

A 3D hex-platform survival sim. Five little guys with eyes run around on stacked hexagonal platforms while tiles drop out from under them. Last one standing wins. You're not playing — you're watching, with a tune panel full of knobs to mess with everything in real time.

**Play it:** [https://kkawahata.github.io/spacesfall/](https://kkawahata.github.io/spacesfall/)

## Controls

- **Right-click drag** — orbit the camera around the platform
- **Mouse wheel** — zoom in / out
- **Left-click on the platform** — drop a sphere on the bots from above
- **Backtick `` ` ``** — toggle the tune panel

## The tune panel

Press backtick. The right-side drawer auto-discovers every config knob across:

- **Skybox** — gradient colors, sun direction, cloud cover, star intensity
- **Lighting** — beat-synced floor wave (BPM, palette, peak intensity, layer fall-off)
- **VFX** — tile-fall dust, sphere-impact sparks, win confetti, lose punctuation
- **Weather** — rain / snow / fog / dust / clear, with intensity
- **Camera shake** — magnitudes for sphere impacts, tile falls, eliminations
- **Trail** — player ribbon settings (lifetime, width, color)
- **Bots** — count, behavior tunings, spawn separation
- **Characters** — eye sizes, accessory visibility
- **Clouds** — count, drift speed, palette
- **Rendering** — ACES tone mapping exposure
- **Shadow** — quality, softness
- **Sim** — observer mode, click-to-throw, auto-orbit speed

At the top of the panel: a **preset switcher** with `default` / `sunset` / `night` / `void` / `rave` / `storm` / `candy`. Pick one, watch the whole atmosphere flip.

## The five characters

| | | |
|---|---|---|
| **Sprinter** | fast, frail, slim | overcommits to the edge |
| **Hopper** | bouncy sphere, big eyes, springy antennae | always jumping |
| **Boulder** | chunky cylinder, brow ridge, mossy lumps | parks in the middle |
| **Dasher** | athletic, forward-leaning, intense | charges spheres on purpose |
| **Glider** | tall, dreamy, scarf ribbons | floats near the edge somehow surviving |

Each has distinct stats (move speed, jump velocity, gravity, size) and an AI behavior tag that drives how their bot plays. Right now the default is observer mode — all 5 spawn as bots, no human player. Toggle `simConfig.observer_mode` off in the tune panel to play as one yourself.

## Notes

- Built with Babylon.js, vanilla JS, no build step.
- Loads Babylon from CDN — needs internet for the first hit.
- Designed for desktop browser; mobile not supported.
- Round auto-restarts in observer mode after ~2.5s.

## License

MIT.
