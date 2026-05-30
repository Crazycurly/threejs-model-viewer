#!/usr/bin/env node
'use strict';
// Headless renderer for .tmv.json render scripts exported by the Three.js Model
// Viewer's Video Export panel.
//
//   node render.js <script.tmv.json> [-o out.mp4]
//
// Reuses the viewer's own r90 three.js + loaders + post-FX under headless-gl,
// then pipes raw frames to ffmpeg. Output is meant to match the in-browser
// WebCodecs export. See README.md.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');

const { loadThree } = require('./loadThree');
const { makeGLCanvas, readPixels } = require('./domShim');
const { buildScene, loadModel, applyMaterial, applyTransform } = require('./buildScene');
const { createSampler, applyPose } = require('./sampleCamera');

// Mirrors QUALITY_PRESETS in js/videoExport.js.
const QUALITY_PRESETS = {
    draft:    { ss: 1, bpp: 0.05 },
    standard: { ss: 1, bpp: 0.12 },
    high:     { ss: 2, bpp: 0.18 },
    lossless: { ss: 2, bpp: 0.90 },
};
const MAX_BITRATE = 1_000_000_000;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function parseArgs(argv) {
    const args = { input: null, output: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-o' || a === '--output') args.output = argv[++i];
        else if (a === '-h' || a === '--help') args.help = true;
        else if (!args.input) args.input = a;
    }
    return args;
}

function usage() {
    console.log('Usage: node render.js <script.tmv.json> [-o out.mp4]');
}

// Mirrors getBitrate() in js/videoExport.js.
function computeBitrate(o, W, H) {
    if (o.bitrateMbps && o.bitrateMbps > 0) {
        return clamp(Math.round(o.bitrateMbps * 1e6), 1_000_000, MAX_BITRATE);
    }
    const q = QUALITY_PRESETS[o.quality] || QUALITY_PRESETS.high;
    return clamp(Math.round(W * H * o.fps * q.bpp), 1_000_000, MAX_BITRATE);
}

function ffmpegPath() {
    try {
        const p = require('ffmpeg-static');
        if (p) return p;
    } catch (e) { /* fall through */ }
    return process.env.FFMPEG_PATH || 'ffmpeg';
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help || !args.input) { usage(); process.exit(args.help ? 0 : 1); }

    const scriptPath = path.resolve(args.input);
    const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    if (script.schema !== 'tmv-render-script') throw new Error('Not a render script (schema mismatch).');
    if ((script.version || 0) > 1) throw new Error(`Render script v${script.version} is newer than this renderer (v1).`);

    const o = script.output || {};
    const W = o.width, H = o.height, fps = o.fps || 30;
    const duration = o.duration || 5;
    const totalFrames = Math.max(1, Math.round(duration * fps));
    const outPath = path.resolve(args.output || scriptPath.replace(/\.(tmv\.)?json$/i, '') + '.mp4');

    // Supersample exactly like exportMP4 (capped to 4096 on the long edge).
    const q = QUALITY_PRESETS[o.quality] || QUALITY_PRESETS.high;
    const maxDim = Math.max(W, H);
    const ssEff = Math.max(1, Math.min(q.ss, 4096 / maxDim));
    const RW = Math.round(W * ssEff), RH = Math.round(H * ssEff);
    const bitrate = computeBitrate(o, W, H);

    console.error(`Render script: ${path.basename(scriptPath)}`);
    console.error(`  output ${W}x${H} @ ${fps}fps, ${duration}s (${totalFrames} frames)`);
    console.error(`  quality=${o.quality || 'high'} supersample=${ssEff.toFixed(2)}x render=${RW}x${RH} bitrate=${(bitrate / 1e6).toFixed(1)}Mbps`);
    console.error(`  model: ${script.model ? script.model.filename + ' (' + script.model.format + ')' : 'NONE'}`);

    // --- Set up THREE + scene -------------------------------------------------
    const THREE = loadThree();

    const canvas = makeGLCanvas(RW, RH);
    const renderer = new THREE.WebGLRenderer({ canvas, context: canvas.__gl, preserveDrawingBuffer: true, antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(RW, RH, false);

    const { scene, camera, composer, outlinePass, materials } = buildScene(THREE, renderer, script, RW, RH);

    const { model, animations } = await loadModel(THREE, script);
    applyMaterial(THREE, model, materials, script.scene && script.scene.material);
    applyTransform(model, script.scene && script.scene.modelTransform);
    scene.add(model);
    if (outlinePass) outlinePass.selectedObjects = [model];

    // Animations: play the named clip, else everything (matches playAllAnimation).
    let mixer = null;
    if (animations && animations.length) {
        mixer = new THREE.AnimationMixer(model);
        const wanted = script.animation && script.animation.clip;
        const clips = wanted ? animations.filter(c => c.name === wanted) : animations;
        (clips.length ? clips : animations).forEach(c => mixer.clipAction(c).play());
    }

    // --- Camera sampler -------------------------------------------------------
    const keyframes = ((script.timeline && script.timeline.keyframes) || []).map(k => ({
        time: k.time,
        pos: new THREE.Vector3(k.pos[0], k.pos[1], k.pos[2]),
        target: new THREE.Vector3(k.target[0], k.target[1], k.target[2]),
    }));
    if (keyframes.length < 1) throw new Error('Render script has no keyframes.');
    const sampler = createSampler(THREE, keyframes, o.easing === 'linear' ? 'linear' : 'smooth', duration);

    // --- ffmpeg ---------------------------------------------------------------
    const vf = (RW !== W || RH !== H)
        ? `vflip,scale=${W}:${H}:flags=lanczos`   // downscale the supersample
        : 'vflip';                                 // GL origin is bottom-left
    const ffArgs = [
        '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${RW}x${RH}`, '-r', String(fps), '-i', '-',
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'slow', '-b:v', String(bitrate),
        '-maxrate', String(Math.min(MAX_BITRATE, Math.round(bitrate * 1.5))),
        '-bufsize', String(Math.min(MAX_BITRATE, bitrate * 2)),
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        outPath,
    ];
    const ff = spawn(ffmpegPath(), ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
    const ffDone = new Promise((res, rej) => {
        ff.on('error', rej);
        ff.on('close', (code) => code === 0 ? res() : rej(new Error('ffmpeg exited with code ' + code)));
    });

    // --- Render loop ----------------------------------------------------------
    const pos = new THREE.Vector3(), target = new THREE.Vector3();
    let lastMixerT = 0;
    for (let i = 0; i < totalFrames; i++) {
        const t = i / fps;
        sampler.sampleAt(t, pos, target);
        applyPose(camera, pos, target);
        if (mixer) { mixer.update(t - lastMixerT); lastMixerT = t; }

        composer.render();
        const frame = readPixels(canvas);
        if (!ff.stdin.write(frame)) await once(ff.stdin, 'drain');

        if (i % Math.max(1, Math.round(fps / 2)) === 0 || i === totalFrames - 1) {
            process.stderr.write(`\r  rendering ${i + 1}/${totalFrames}`);
        }
    }
    process.stderr.write('\n');

    ff.stdin.end();
    await ffDone;
    const size = fs.existsSync(outPath) ? (fs.statSync(outPath).size / 1048576).toFixed(1) : '?';
    console.error(`Done -> ${outPath} (${size} MB)`);
}

main().catch((e) => {
    console.error('\nRender failed:', e && e.stack ? e.stack : e);
    process.exit(1);
});
