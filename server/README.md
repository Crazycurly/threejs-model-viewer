# Headless render server

Renders a **render script** (`.tmv.json`) exported from the viewer's **Video
Export → Save Script** button into an MP4 — no browser, no GPU tab limits.

It loads the viewer's **own** r90 `three.js` + loaders + post-FX (`../js/*`)
under [`headless-gl`](https://github.com/stackgl/headless-gl) so the render uses
the same code paths as the browser, then encodes with bundled `ffmpeg`.

```
node render.js <script.tmv.json> [-o out.mp4]
```

## Install

```bash
cd server
npm install
```

`headless-gl` builds a native addon and needs system GL libraries.

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get install -y build-essential libgl1-mesa-dev libxi-dev \
    libglu1-mesa-dev libglew-dev pkg-config
```
On a headless box (no display) run under a virtual framebuffer:
```bash
xvfb-run -s "-screen 0 1280x1024x24" node render.js shot.tmv.json -o out.mp4
```

**macOS:** works out of the box (Xcode command line tools).

`ffmpeg` ships via `ffmpeg-static` — no separate install. Override with
`FFMPEG_PATH=/path/to/ffmpeg` if you want your own build (e.g. for NVENC).

## How a script is produced

In the viewer: load a model, add keyframes in the Video Export panel, set
resolution / fps / duration / quality, then **Save Script**. The `.tmv.json` is
self-contained — the model is base64-embedded, so it renders anywhere.

## What gets reproduced

The script captures the full scene so the server output matches the viewer:

| Group    | Fields |
|----------|--------|
| `output` | width, height, fps, duration, quality (`draft`/`standard`/`high`/`lossless`), `bitrateMbps` (null = derive from quality), easing (`smooth`/`linear`) |
| `camera` | fov, near, far |
| `timeline` | keyframes: `{ time, pos:[x,y,z], target:[x,y,z] }` |
| `scene.lights` | ambient on/off + colour, directional colour, point-light intensity |
| `scene.material` | active mode (`wireframe`/`modelWire`/`phong`/`xray`/`glow`/`default`), smooth, phong shininess, glow strength/colour |
| `scene.modelTransform` | position, quaternion, scale (final values — no re-fitting needed) |
| `model` | filename, format, base64 data, optional `assets[]` (e.g. `.mtl`) |
| `animation` | clip name to play (or null) |

Supersample, bitrate and codec sizing mirror `js/videoExport.js`
(`QUALITY_PRESETS`, `getBitrate`, the 4096-px supersample cap). Frames are read
from the GL buffer and `vflip`-ed (GL origin is bottom-left); supersampled
renders are lanczos-downscaled to the target size by ffmpeg.

## Limitations (v1)

- **WebGL1 only** (headless-gl). r90's composer / FXAA / OutlinePass work, but
  driver and AA differences can produce tiny pixel deltas vs. a browser.
- **Textures are best-effort.** Geometry, wireframe, phong, x-ray and vertex
  colours render reliably. Image textures (textured glTF/FBX) depend on image
  decoding in the headless DOM and may not appear; the low-risk path is
  untextured geometry.
- **Smooth** re-runs `computeVertexNormals` (approximates the viewer's
  merge-vertices smoothing).
- Encoding uses `libx264`. The browser export may pick HEVC/VP9/AV1 for very
  large frames; the file differs but the imagery is the same.
