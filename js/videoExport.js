// Keyframe-timeline camera fly-through + MP4 export.
// Reuses the viewer globals defined in main.js: camera, controls, composer,
// renderer, mixer, outlinePass, fxaaPass. Loaded as an ES module after main.js.

const RES_PRESETS = {
    '720p':  [1280, 720],
    '1080p': [1920, 1080],
    '1440p': [2560, 1440],
    '4k':    [3840, 2160],
};

// Quality presets -> { ss: supersample factor, bpp: bits per pixel per frame }.
// ss>1 renders larger then downscales for crisp edges; bpp drives the bitrate.
// 'lossless' is visually near-lossless: huge bitrate + 2x supersample.
const QUALITY_PRESETS = {
    'draft':    { ss: 1, bpp: 0.05 },
    'standard': { ss: 1, bpp: 0.12 },
    'high':     { ss: 2, bpp: 0.18 },
    'lossless': { ss: 2, bpp: 0.90 },
};

// Hard ceiling for the encoder bitrate (1 Gbps) — keeps absurd values from
// being rejected outright while still allowing near-lossless 4K.
const MAX_BITRATE = 1_000_000_000;

// Each keyframe stores a camera pose plus its own time on the timeline.
const keyframes = []; // { pos: THREE.Vector3, target: THREE.Vector3, time: number }

let posCurve = null, targetCurve = null;
let previewRAF = null;
let playheadTime = 0;   // current scrub position (seconds)
let dragKf = null;      // keyframe object being dragged
let scrubbing = false;

// --- UI refs (populated on DOMContentLoaded) -------------------------------
let el = {};

function $(id) { return document.getElementById(id); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

function getDuration() {
    const v = parseFloat($('kf_dur').value);
    return (isFinite(v) && v > 0) ? v : 5;
}

function getFps() {
    return parseInt($('kf_fps').value, 10) || 30;
}

function getResolution() {
    const sel = $('kf_res').value;
    if (sel === 'custom') {
        const w = Math.max(2, parseInt($('kf_w').value, 10) || 1920);
        const h = Math.max(2, parseInt($('kf_h').value, 10) || 1080);
        // H.264 requires even dimensions.
        return [w - (w % 2), h - (h % 2)];
    }
    return RES_PRESETS[sel] || RES_PRESETS['1080p'];
}

function resLabel() {
    const sel = $('kf_res').value;
    if (sel === 'custom') { const [w, h] = getResolution(); return `${w}x${h}`; }
    return sel;
}

function getQuality() {
    return QUALITY_PRESETS[el.quality ? el.quality.value : 'high'] || QUALITY_PRESETS['high'];
}

// Manual "Bitrate (Mbps)" field overrides the preset when set (> 0).
function getBitrate(W, H, fps) {
    const manual = el.bitrate ? parseFloat(el.bitrate.value) : NaN;
    if (isFinite(manual) && manual > 0) {
        return clamp(Math.round(manual * 1e6), 1_000_000, MAX_BITRATE);
    }
    const { bpp } = getQuality();
    return clamp(Math.round(W * H * fps * bpp), 1_000_000, MAX_BITRATE);
}

function getEasing() {
    return (el.easing && el.easing.value === 'linear') ? 'linear' : 'smooth';
}

// Format seconds as M:SS.d
function fmtTime(t) {
    t = Math.max(0, t);
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    const whole = Math.floor(s);
    const tenth = Math.floor((s - whole) * 10);
    return `${m}:${String(whole).padStart(2, '0')}.${tenth}`;
}

// --- Keyframe management ---------------------------------------------------
function sortKeyframes() {
    keyframes.sort((a, b) => a.time - b.time);
}

function rebuildCurves() {
    posCurve = targetCurve = null;
    if (keyframes.length >= 2) {
        posCurve = new THREE.CatmullRomCurve3(keyframes.map(k => k.pos.clone()));
        targetCurve = new THREE.CatmullRomCurve3(keyframes.map(k => k.target.clone()));
    }
}

function addKeyframe() {
    const dur = getDuration();
    const lastTime = keyframes.length ? keyframes[keyframes.length - 1].time : 0;
    const step = Math.max(0.5, dur / 4);
    const time = keyframes.length === 0 ? 0 : Math.min(dur, lastTime + step);
    keyframes.push({
        pos: window.camera.position.clone(),
        target: window.controls.target.clone(),
        time,
    });
    sortKeyframes();
    rebuildCurves();
    renderTimeline();
}

function deleteKeyframe(i) {
    keyframes.splice(i, 1);
    rebuildCurves();
    renderTimeline();
}

function clearKeyframes() {
    keyframes.length = 0;
    rebuildCurves();
    renderTimeline();
}

function jumpTo(i) {
    const k = keyframes[i];
    if (!k) return;
    window.camera.position.copy(k.pos);
    window.controls.target.copy(k.target);
    window.controls.update();
    playheadTime = k.time;
    updatePlayheadUI();
}

// Fills outPos/outTarget for the given timeline time. Honors per-keyframe
// times and the selected easing. Requires >= 1 keyframe.
function sampleAt(time, outPos, outTarget) {
    const n = keyframes.length;
    if (n === 0) return false;
    if (n === 1) {
        outPos.copy(keyframes[0].pos);
        outTarget.copy(keyframes[0].target);
        return true;
    }
    const t = clamp(time, 0, getDuration());
    if (t <= keyframes[0].time) {
        outPos.copy(keyframes[0].pos);
        outTarget.copy(keyframes[0].target);
        return true;
    }
    if (t >= keyframes[n - 1].time) {
        outPos.copy(keyframes[n - 1].pos);
        outTarget.copy(keyframes[n - 1].target);
        return true;
    }
    let i = 0;
    while (i < n - 1 && keyframes[i + 1].time <= t) i++;
    const t0 = keyframes[i].time, t1 = keyframes[i + 1].time;
    const seg = t1 - t0;
    const localFrac = seg > 0 ? (t - t0) / seg : 0;

    if (getEasing() === 'linear') {
        outPos.lerpVectors(keyframes[i].pos, keyframes[i + 1].pos, localFrac);
        outTarget.lerpVectors(keyframes[i].target, keyframes[i + 1].target, localFrac);
    } else {
        // CatmullRom segments are uniform per index, so map the time-segment
        // onto the matching spline segment.
        const u = (i + localFrac) / (n - 1);
        posCurve.getPoint(u, outPos);
        targetCurve.getPoint(u, outTarget);
    }
    return true;
}

function applyPose(pos, target) {
    window.camera.position.copy(pos);
    window.controls.target.copy(target);
    window.camera.lookAt(target);
    window.camera.updateMatrixWorld();
}

// r90 AnimationMixer has no setTime(); drive it with incremental positive deltas
// so any model clip plays in sync with the timeline.
let _lastMixerT = 0;
function resetMixerClock() { _lastMixerT = 0; }
function advanceMixer(t) {
    if (window.mixer) { window.mixer.update(t - _lastMixerT); _lastMixerT = t; }
}

// --- Timeline UI -----------------------------------------------------------
function timeFromClientX(clientX) {
    const r = el.track.getBoundingClientRect();
    const frac = r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) : 0;
    return frac * getDuration();
}

function updatePlayheadUI() {
    const dur = getDuration();
    el.playhead.style.left = (dur > 0 ? clamp(playheadTime / dur, 0, 1) * 100 : 0) + '%';
    el.timeCur.textContent = fmtTime(playheadTime);
    el.timeEnd.textContent = fmtTime(dur);
}

function renderTimeline() {
    const dur = getDuration();
    el.markers.innerHTML = '';

    keyframes.forEach((kf) => {
        const m = document.createElement('div');
        m.className = 'kf_marker';
        m.style.left = (dur > 0 ? clamp(kf.time / dur, 0, 1) * 100 : 0) + '%';

        const dia = document.createElement('span');
        dia.className = 'kf_diamond';
        dia.textContent = '◆'; // ◆

        const del = document.createElement('span');
        del.className = 'kf_marker_del';
        del.textContent = '×'; // ×
        del.title = 'Delete keyframe';

        m.appendChild(dia);
        m.appendChild(del);

        m.title = `${fmtTime(kf.time)} — drag to retime, click to jump`;

        // Drag to retime / click to jump. Track the keyframe by reference so a
        // mid-drag re-sort can't lose it.
        m.addEventListener('mousedown', (e) => {
            e.stopPropagation(); // don't let the track start a scrub
            if (e.target === del) return; // delete handled on click
            e.preventDefault();
            dragKf = kf;
            let moved = false;
            const move = (ev) => {
                moved = true;
                kf.time = timeFromClientX(ev.clientX);
                renderTimeline();
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                dragKf = null;
                if (moved) { sortKeyframes(); rebuildCurves(); }
                else { jumpTo(keyframes.indexOf(kf)); }
                renderTimeline();
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });

        del.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteKeyframe(keyframes.indexOf(kf));
        });

        el.markers.appendChild(m);
    });

    el.empty.style.display = keyframes.length ? 'none' : 'block';
    updatePlayheadUI();

    const ready = keyframes.length >= 2;
    el.preview.disabled = !ready;
    el.exportBtn.disabled = !ready;
}

// --- Scrubbing (drag playhead / click track) -------------------------------
function scrubTo(t) {
    playheadTime = clamp(t, 0, getDuration());
    if (keyframes.length >= 1) {
        const pos = scrubTo._pos || (scrubTo._pos = new THREE.Vector3());
        const target = scrubTo._target || (scrubTo._target = new THREE.Vector3());
        sampleAt(playheadTime, pos, target);
        applyPose(pos, target);
        window.composer.render();
    }
    updatePlayheadUI();
}

function beginScrub(clientX) {
    if (previewRAF) stopPreview();
    scrubbing = true;
    window.videoExporting = true; // pause main loop while we drive the camera
    const move = (ev) => scrubTo(timeFromClientX(ev.clientX));
    const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        scrubbing = false;
        window.videoExporting = false; // resume main loop
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    scrubTo(timeFromClientX(clientX));
}

function setStatus(msg) { $('kf_status').textContent = msg || ''; }

// --- Preview (real-time playback) ------------------------------------------
function previewPlayback() {
    if (keyframes.length < 2) return;
    if (previewRAF) return; // already previewing
    const dur = getDuration();
    const pos = new THREE.Vector3(), target = new THREE.Vector3();
    const start = performance.now();
    window.videoExporting = true; // pause main loop
    resetMixerClock();
    el.preview.textContent = 'Stop';
    setStatus('Previewing...');

    const step = () => {
        const t = (performance.now() - start) / 1000;
        if (t >= dur) {
            playheadTime = dur;
            updatePlayheadUI();
            stopPreview();
            return;
        }
        sampleAt(t, pos, target);
        applyPose(pos, target);
        advanceMixer(t);
        window.composer.render();
        playheadTime = t;
        updatePlayheadUI();
        previewRAF = requestAnimationFrame(step);
    };
    previewRAF = requestAnimationFrame(step);
}

function stopPreview() {
    if (previewRAF) cancelAnimationFrame(previewRAF);
    previewRAF = null;
    window.videoExporting = false; // resume main loop
    el.preview.textContent = 'Preview';
    setStatus('');
}

// --- Export size handling --------------------------------------------------
// useComposer=false skips the post-processing render targets (FXAA + outline +
// extra buffers), which are the VRAM hogs that cause CONTEXT_LOST at huge sizes.
function applyExportSize(W, H, useComposer) {
    window.renderer.setPixelRatio(1);
    window.renderer.setSize(W, H, false);
    window.camera.aspect = W / H;
    window.camera.updateProjectionMatrix();
    if (useComposer) {
        window.composer.setSize(W, H);
        if (window.fxaaPass) {
            window.fxaaPass.material.uniforms['resolution'].value.set(1 / W, 1 / H);
        }
        if (window.outlinePass) window.outlinePass.setSize(W, H);
    }
}

function restoreViewerSize() {
    const W = window.innerWidth, H = window.innerHeight;
    const pr = window.devicePixelRatio;
    window.renderer.setPixelRatio(pr);
    window.renderer.setSize(W, H);
    window.composer.setSize(W, H);
    window.camera.aspect = W / H;
    window.camera.updateProjectionMatrix();
    if (window.fxaaPass) {
        window.fxaaPass.material.uniforms['resolution'].value.set(1 / (W * pr), 1 / (H * pr));
    }
    if (window.outlinePass) window.outlinePass.setSize(W, H);
}

// --- Codec selection -------------------------------------------------------
// Minimum H.264 level (×10) for the frame size + rate. Last codec hex byte = level.
function avcLevel(W, H, fps) {
    const mbs = Math.ceil(W / 16) * Math.ceil(H / 16);
    const mbps = mbs * fps;
    // [level*10, maxFrameMBs, maxMBps]
    const table = [
        [30, 1620, 40500], [31, 3600, 108000], [32, 5120, 216000],
        [40, 8192, 245760], [42, 8704, 522240], [50, 22080, 589824],
        [51, 36864, 983040], [52, 36864, 2073600], [60, 139264, 4177920],
        [62, 139264, 16711680],
    ];
    for (const [lvl, maxMb, maxRate] of table) {
        if (mbs <= maxMb && mbps <= maxRate) return lvl;
    }
    return 62;
}

// Ordered codec candidates, best-compatibility first. H.264 hardware encoders
// usually cap around 4096px, so for larger frames we fall back to HEVC / VP9 /
// AV1 which support much bigger resolutions. Each maps to its mp4-muxer codec.
function codecCandidates(W, H, fps) {
    const out = [];
    const avcHex = avcLevel(W, H, fps).toString(16).padStart(2, '0');
    // H.264 profiles: High (6400), Main (4d00), Constrained Baseline (4200).
    ['6400', '4d00', '4200'].forEach(p => out.push({ muxerCodec: 'avc', codec: 'avc1.' + p + avcHex }));
    // HEVC Main (general_level_idc = level*30), high -> low.
    [186, 180, 153, 150, 123, 120].forEach(l => {
        out.push({ muxerCodec: 'hevc', codec: 'hev1.1.6.L' + l + '.B0' });
        out.push({ muxerCodec: 'hevc', codec: 'hvc1.1.6.L' + l + '.B0' });
    });
    // VP9 profile 0, 8-bit, level high -> low (handles very large frames).
    ['62', '61', '60', '52', '51', '50', '41', '40', '31', '21', '10'].forEach(l =>
        out.push({ muxerCodec: 'vp9', codec: 'vp09.00.' + l + '.08' }));
    // AV1 main profile, tier Main, 8-bit, seq_level_idx high -> low.
    ['19', '18', '17', '16', '15', '14', '13', '12', '08', '05', '00'].forEach(l =>
        out.push({ muxerCodec: 'av1', codec: 'av01.0.' + l + 'M.08' }));
    return out;
}

// Returns { muxerCodec, codec, hardwareAcceleration } or null.
async function chooseEncoder(W, H, fps, bitrate) {
    const accels = ['prefer-hardware', 'no-preference', 'prefer-software'];
    for (const cand of codecCandidates(W, H, fps)) {
        for (const hardwareAcceleration of accels) {
            const cfg = { codec: cand.codec, width: W, height: H, framerate: fps, bitrate, hardwareAcceleration, latencyMode: 'quality' };
            try {
                const sup = await VideoEncoder.isConfigSupported(cfg);
                if (sup && sup.supported) {
                    return { muxerCodec: cand.muxerCodec, codec: cand.codec, hardwareAcceleration };
                }
            } catch (e) { /* try next */ }
        }
    }
    return null;
}

const yieldFrame = () => new Promise(r => setTimeout(r, 0));

// --- Export ----------------------------------------------------------------
async function exportMP4() {
    if (keyframes.length < 2) return;
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
        alert('MP4 export needs the WebCodecs API.\nUse a Chromium browser (Chrome/Edge) and open the page over http://localhost (not file://).');
        return;
    }

    let Muxer, ArrayBufferTarget;
    try {
        ({ Muxer, ArrayBufferTarget } = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm'));
    } catch (e) {
        alert('Could not load the mp4-muxer library from CDN. Check your network connection.');
        return;
    }

    stopPreview();
    const [W, H] = getResolution();
    const fps = getFps();
    const dur = getDuration();
    const totalFrames = Math.max(1, Math.round(dur * fps));
    const { ss } = getQuality();
    const bitrate = getBitrate(W, H, fps);

    // Supersample factor, capped so the render buffer stays within GL/encoder
    // limits (~4096 px on the long edge). 4K therefore renders ~1x (crisp natively).
    const maxDim = Math.max(W, H);
    const ssEff = Math.max(1, Math.min(ss, 4096 / maxDim));
    const RW = Math.round(W * ssEff), RH = Math.round(H * ssEff);

    // GPU sanity: refuse sizes past the max texture size.
    const maxTex = (window.renderer.capabilities && window.renderer.capabilities.maxTextureSize) || 8192;
    if (Math.max(RW, RH) > maxTex) {
        alert(`${W}x${H} exceeds this GPU's max texture size (${maxTex}px). Try a smaller resolution.`);
        return;
    }
    // Above ~4K the post-processing render targets blow the VRAM budget and the
    // WebGL context is lost, so render the scene directly (no FXAA/outline) there.
    const COMPOSER_MAX_PIXELS = 8_500_000; // ~4K (3840x2160)
    const useComposer = (RW * RH) <= COMPOSER_MAX_PIXELS;

    const picked = await chooseEncoder(W, H, fps, bitrate);
    if (!picked) {
        alert(`No supported video encoder for ${W}x${H} @ ${fps}fps (tried H.264, HEVC, VP9, AV1).\nTry a smaller resolution.`);
        return;
    }
    const { muxerCodec, codec, hardwareAcceleration } = picked;

    btnsDisabledForExport(true);
    $('kf_progress').style.display = 'block';
    $('kf_progress').value = 0;
    window.videoExporting = true;

    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: muxerCodec, width: W, height: H, frameRate: fps },
        fastStart: 'in-memory',
    });

    const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { console.error('VideoEncoder error:', e); setStatus('Encoder error: ' + e.message); },
    });
    encoder.configure({ codec, width: W, height: H, framerate: fps, bitrate, hardwareAcceleration, latencyMode: 'quality' });

    // Offscreen canvas for the high-quality downscale when supersampling.
    let dsCanvas = null, dsCtx = null;
    if (ssEff > 1) {
        dsCanvas = document.createElement('canvas');
        dsCanvas.width = W; dsCanvas.height = H;
        dsCtx = dsCanvas.getContext('2d');
        dsCtx.imageSmoothingEnabled = true;
        dsCtx.imageSmoothingQuality = 'high';
    }

    const pos = new THREE.Vector3(), target = new THREE.Vector3();

    // Detect GPU context loss (out-of-memory at extreme sizes) and abort cleanly.
    let contextLost = false;
    const glCanvas = window.renderer.domElement;
    const onContextLost = (e) => { e.preventDefault(); contextLost = true; };
    glCanvas.addEventListener('webglcontextlost', onContextLost);

    try {
        applyExportSize(RW, RH, useComposer);
        resetMixerClock();
        for (let i = 0; i < totalFrames; i++) {
            if (contextLost) throw new Error('WebGL context lost — the GPU ran out of memory at this resolution. Try a smaller one.');
            const t = i / fps;
            sampleAt(t, pos, target);
            applyPose(pos, target);
            advanceMixer(t);
            if (useComposer) window.composer.render();
            else window.renderer.render(window.scene, window.camera);

            // Capture synchronously while the drawing buffer is still intact.
            let frameSrc = window.renderer.domElement;
            if (ssEff > 1) {
                dsCtx.drawImage(window.renderer.domElement, 0, 0, W, H);
                frameSrc = dsCanvas;
            }
            const frame = new VideoFrame(frameSrc, {
                timestamp: Math.round(i * 1e6 / fps),
                duration: Math.round(1e6 / fps),
            });
            encoder.encode(frame, { keyFrame: i % (2 * fps) === 0 });
            frame.close();

            playheadTime = t;
            updatePlayheadUI();
            $('kf_progress').value = ((i + 1) / totalFrames) * 100;
            setStatus(`Rendering ${i + 1}/${totalFrames} @ ${resLabel()} ${fps}fps · ${(bitrate / 1e6).toFixed(0)} Mbps · ${muxerCodec.toUpperCase()}`);

            // Yield + relieve encoder backpressure.
            if (encoder.encodeQueueSize > 8 || i % 5 === 0) await yieldFrame();
        }

        setStatus('Finalizing...');
        await encoder.flush();
        muxer.finalize();

        const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `flythrough_${resLabel()}_${fps}fps.mp4`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setStatus(`Done — ${totalFrames} frames, ${(blob.size / 1048576).toFixed(1)} MB`);
    } catch (e) {
        console.error(e);
        setStatus('Export failed: ' + e.message);
        alert('Export failed: ' + e.message);
    } finally {
        glCanvas.removeEventListener('webglcontextlost', onContextLost);
        try { encoder.close(); } catch (e) {}
        try { restoreViewerSize(); } catch (e) {}
        window.videoExporting = false;
        $('kf_progress').style.display = 'none';
        btnsDisabledForExport(false);
    }
}

function btnsDisabledForExport(busy) {
    el.add.disabled = busy;
    el.clear.disabled = busy;
    el.preview.disabled = busy || keyframes.length < 2;
    el.exportBtn.disabled = busy || keyframes.length < 2;
}

// --- Render-script (JSON) export / import ----------------------------------
// Serializes the whole shot — timeline, camera intrinsics, full scene state
// and the embedded model bytes — into one self-contained JSON ("render
// script"). A headless box can then render it with server/render.js, no
// browser needed. Loading a script back restores everything for re-editing.
//
// Schema is documented in server/README.md; keep this and the server in sync.
const SCRIPT_SCHEMA = 'tmv-render-script';
const SCRIPT_VERSION = 1;

// base64 <-> ArrayBuffer (chunked so big models don't blow the call stack).
function abToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}
function base64ToAb(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}
function fileToBase64(file) { return file.arrayBuffer().then(abToBase64); }

// Normalize window.currentModelSource (set by the model loaders) into
// { filename, format, encoding:'base64', data, assets:[{name,data}] }.
async function serializeModel() {
    const src = window.currentModelSource;
    if (!src) return null;
    if (src.kind === 'url') {
        const resp = await fetch(src.url);
        const buf = await resp.arrayBuffer();
        return { filename: src.filename, format: src.format, encoding: 'base64', data: abToBase64(buf), assets: [] };
    }
    // kind 'files': the file matching the recorded name is primary; rest = assets.
    const files = src.files || [];
    const primary = files.find(f => f.name === src.filename) || files[0];
    const assets = [];
    for (const f of files) {
        if (f === primary) continue;
        assets.push({ name: f.name, data: await fileToBase64(f) });
    }
    return {
        filename: src.filename, format: src.format, encoding: 'base64',
        data: primary ? await fileToBase64(primary) : '', assets,
    };
}

function colorTo255(c) { return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]; }

// The material toggles are mutually exclusive (shared "check" class). Report
// whichever is active so the server / re-import can reproduce it.
const MODE_TO_ID = { wireframe: 'wire_check', modelWire: 'model_wire', phong: 'phong_check', xray: 'xray_check', glow: 'glow_check' };
function activeMaterialMode() {
    if ($('glow_check') && $('glow_check').checked) return 'glow';
    if ($('xray_check') && $('xray_check').checked) return 'xray';
    if ($('phong_check') && $('phong_check').checked) return 'phong';
    if ($('model_wire') && $('model_wire').checked) return 'modelWire';
    if ($('wire_check') && $('wire_check').checked) return 'wireframe';
    return 'default';
}

async function buildRenderScript() {
    const [W, H] = getResolution();
    const cam = window.camera;
    const model = window.model;
    const clear = window.renderer.getClearColor();
    const ol = window.outlinePass;
    return {
        schema: SCRIPT_SCHEMA,
        version: SCRIPT_VERSION,
        createdAt: new Date().toISOString(),
        output: {
            width: W, height: H, fps: getFps(), duration: getDuration(),
            quality: el.quality ? el.quality.value : 'high',
            bitrateMbps: (el.bitrate && parseFloat(el.bitrate.value) > 0) ? parseFloat(el.bitrate.value) : null,
            easing: getEasing(),
        },
        camera: { fov: cam.fov, near: cam.near, far: cam.far },
        timeline: {
            keyframes: keyframes.map(k => ({
                time: k.time,
                pos: [k.pos.x, k.pos.y, k.pos.z],
                target: [k.target.x, k.target.y, k.target.z],
            })),
        },
        scene: {
            background: '#' + clear.getHexString(),
            lights: {
                ambientEnabled: !!(window.amb && window.amb.checked),
                ambientColor255: colorTo255(window.ambient.color),
                directionalColor255: colorTo255(window.directionalLight.color),
                pointIntensity: window.pointLight ? window.pointLight.intensity : 0.5,
            },
            material: {
                mode: activeMaterialMode(),
                smooth: !!($('smooth') && $('smooth').checked),
                phongShininess: window.materials.phongMaterial.shininess,
                glowEnabled: !!(ol && ol.enabled),
                glowEdgeStrength: ol ? ol.edgeStrength : 1,
                glowColor: (ol && ol.visibleEdgeColor) ? '#' + ol.visibleEdgeColor.getHexString() : '#ffffff',
            },
            modelTransform: model ? {
                position: [model.position.x, model.position.y, model.position.z],
                quaternion: [model.quaternion.x, model.quaternion.y, model.quaternion.z, model.quaternion.w],
                scale: [model.scale.x, model.scale.y, model.scale.z],
            } : null,
        },
        animation: { clip: window.currentAnimation || null },
        model: await serializeModel(),
    };
}

async function saveRenderScript() {
    if (keyframes.length < 1) { alert('Add at least one keyframe before saving a render script.'); return; }
    setStatus('Building render script...');
    try {
        const script = await buildRenderScript();
        if (!script.model && !confirm('No model is currently loaded — the script will have no geometry to render. Save anyway?')) {
            setStatus('');
            return;
        }
        const blob = new Blob([JSON.stringify(script, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `flythrough_${resLabel()}_${getFps()}fps.tmv.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setStatus(`Saved render script — ${keyframes.length} keyframes.`);
    } catch (e) {
        console.error(e);
        setStatus('Save failed: ' + e.message);
        alert('Could not build render script: ' + e.message);
    }
}

// --- Import ----------------------------------------------------------------
function applyRenderScript(script) {
    if (!script || script.schema !== SCRIPT_SCHEMA) { alert('Not a render script (.tmv.json).'); return; }
    if (script.version > SCRIPT_VERSION) {
        alert(`This render script is v${script.version}, newer than this viewer supports (v${SCRIPT_VERSION}). Update the viewer.`);
        return;
    }

    const o = script.output || {};
    const presetKey = Object.keys(RES_PRESETS).find(k => RES_PRESETS[k][0] === o.width && RES_PRESETS[k][1] === o.height);
    if (presetKey) {
        el.res.value = presetKey;
        el.custom.style.display = 'none';
    } else if (o.width && o.height) {
        el.res.value = 'custom';
        el.custom.style.display = 'inline-flex';
        $('kf_w').value = o.width; $('kf_h').value = o.height;
    }
    if (o.fps) $('kf_fps').value = String(o.fps);
    if (o.duration) $('kf_dur').value = String(o.duration);
    if (o.quality && el.quality) el.quality.value = o.quality;
    if (el.bitrate) el.bitrate.value = (o.bitrateMbps != null ? o.bitrateMbps : '');
    if (el.easing && o.easing) el.easing.value = o.easing;

    if (script.camera && window.camera) {
        const c = script.camera;
        if (c.fov) window.camera.fov = c.fov;
        if (c.near) window.camera.near = c.near;
        if (c.far) window.camera.far = c.far;
        window.camera.updateProjectionMatrix();
    }

    applySceneState(script.scene);

    keyframes.length = 0;
    ((script.timeline && script.timeline.keyframes) || []).forEach(k => {
        keyframes.push({
            pos: new THREE.Vector3(k.pos[0], k.pos[1], k.pos[2]),
            target: new THREE.Vector3(k.target[0], k.target[1], k.target[2]),
            time: k.time,
        });
    });
    sortKeyframes();
    rebuildCurves();
    onDurationChange();

    loadEmbeddedModel(script);
    setStatus('Render script loaded.');
}

// Restore lights / background. Light colours are driven by the jQuery-UI
// sliders (main.js setColours() re-applies them every frame), so set the
// slider values rather than the THREE color objects directly.
function applySceneState(scene) {
    if (!scene) return;
    const jq = window.jQuery;
    const L = scene.lights || {};
    const M = scene.material || {};
    const setSlider = (sel, v) => { if (jq) { try { jq(sel).slider('value', v); } catch (e) {} } };

    if (L.directionalColor255) {
        setSlider('#red', L.directionalColor255[0]);
        setSlider('#green', L.directionalColor255[1]);
        setSlider('#blue', L.directionalColor255[2]);
    }
    if (L.ambientColor255) {
        setSlider('#ambient_red', L.ambientColor255[0]);
        setSlider('#ambient_green', L.ambientColor255[1]);
        setSlider('#ambient_blue', L.ambientColor255[2]);
    }
    if (L.pointIntensity != null) {
        setSlider('#point_light', L.pointIntensity);
        if (window.pointLight) window.pointLight.intensity = L.pointIntensity;
    }
    if (window.amb && typeof L.ambientEnabled === 'boolean') {
        window.amb.checked = L.ambientEnabled;
        if (L.ambientEnabled) window.scene.add(window.ambient);
        else window.scene.remove(window.ambient);
    }
    if (scene.background && window.renderer) {
        window.renderer.setClearColor(scene.background);
        document.body.style.background = scene.background;
        if (window.ssaaRenderPass) window.ssaaRenderPass.clearColor = scene.background;
    }
    if (M.phongShininess != null) {
        setSlider('#shine', M.phongShininess);
        if (window.materials) window.materials.phongMaterial.shininess = M.phongShininess;
    }
    if (M.glowEdgeStrength != null) {
        setSlider('#edgeStrength', M.glowEdgeStrength);
        if (window.outlinePass) window.outlinePass.edgeStrength = M.glowEdgeStrength;
    }
}

function dataToFile(name, b64) {
    return new File([base64ToAb(b64)], name, { type: 'application/octet-stream' });
}

function loadEmbeddedModel(script) {
    const m = script.model;
    if (!m || !m.data) return;
    const primary = dataToFile(m.filename, m.data);
    const prevModel = window.model;
    const mat = script.scene && script.scene.material;

    // Pre-set the material checkboxes so the loaders' synchronous "wireframe on
    // by default" path applies the right mode while building the model.
    presetMaterialCheckboxes(mat);

    if (m.assets && m.assets.length) {
        window.loadFiles([primary].concat(m.assets.map(a => dataToFile(a.name, a.data))));
    } else {
        window.loadFile(primary);
    }

    // Model load is async (FileReader + loader callbacks). Once window.model is
    // the freshly-loaded object, re-apply the captured transform + material mode.
    waitForModel(prevModel, (model) => {
        applyModelTransform(model, script.scene && script.scene.modelTransform);
        applyMaterialMode(mat);
        renderTimeline();
    });
}

function presetMaterialCheckboxes(mat) {
    const mode = (mat && mat.mode) || 'default';
    ['wire_check', 'model_wire', 'phong_check', 'xray_check', 'glow_check'].forEach(id => {
        const node = $(id);
        if (node) node.checked = (MODE_TO_ID[mode] === id);
    });
    const sm = $('smooth');
    if (sm) sm.checked = !!(mat && mat.smooth);
}

function applyMaterialMode(mat) {
    if (!mat) return;
    const mode = mat.mode || 'default';
    const id = MODE_TO_ID[mode];
    // Wireframe is already applied by the load path; other modes need their
    // change-handler (bound during load) to fire to swap the material.
    if (id && mode !== 'wireframe') {
        const node = $(id);
        if (node) { node.checked = true; node.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    if (mat.smooth) {
        const sm = $('smooth');
        if (sm && !sm.disabled) { sm.checked = true; sm.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    if (mat.glowEnabled && window.outlinePass) window.outlinePass.enabled = true;
}

function applyModelTransform(model, t) {
    if (!model || !t) return;
    if (t.position) model.position.set(t.position[0], t.position[1], t.position[2]);
    if (t.quaternion) model.quaternion.set(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
    if (t.scale) model.scale.set(t.scale[0], t.scale[1], t.scale[2]);
    model.updateMatrixWorld(true);
}

function waitForModel(prev, cb) {
    let tries = 0;
    const iv = setInterval(() => {
        if (window.model && window.model !== prev) {
            clearInterval(iv);
            setTimeout(() => cb(window.model), 60); // let traverse/material bind finish
        } else if (++tries > 120) {                  // ~6s timeout
            clearInterval(iv);
        }
    }, 50);
}

function loadRenderScriptFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try { applyRenderScript(JSON.parse(e.target.result)); }
        catch (err) { alert('Could not parse render script: ' + err.message); }
    };
    reader.readAsText(file);
}

// --- Wiring ----------------------------------------------------------------
function onDurationChange() {
    const dur = getDuration();
    keyframes.forEach(k => { if (k.time > dur) k.time = dur; });
    if (playheadTime > dur) playheadTime = dur;
    sortKeyframes();
    rebuildCurves();
    renderTimeline();
}

function wire() {
    el = {
        add: $('kf_add'),
        clear: $('kf_clear'),
        preview: $('kf_preview'),
        exportBtn: $('kf_export'),
        res: $('kf_res'),
        custom: $('kf_custom'),
        quality: $('kf_quality'),
        bitrate: $('kf_bitrate'),
        easing: $('kf_easing'),
        track: $('kf_track'),
        markers: $('kf_markers'),
        playhead: $('kf_playhead'),
        timeCur: $('kf_time_cur'),
        timeEnd: $('kf_time_end'),
        empty: $('kf_empty'),
        saveScript: $('kf_save_script'),
        loadScript: $('kf_load_script'),
        scriptFile: $('kf_script_file'),
    };

    el.add.onclick = addKeyframe;
    el.clear.onclick = clearKeyframes;
    el.preview.onclick = () => { previewRAF ? stopPreview() : previewPlayback(); };
    el.exportBtn.onclick = exportMP4;
    if (el.saveScript) el.saveScript.onclick = saveRenderScript;
    if (el.loadScript) el.loadScript.onclick = () => el.scriptFile && el.scriptFile.click();
    if (el.scriptFile) el.scriptFile.onchange = (e) => {
        const f = e.target.files[0];
        if (f) loadRenderScriptFile(f);
        e.target.value = ''; // allow re-loading the same file
    };
    el.res.onchange = () => {
        el.custom.style.display = el.res.value === 'custom' ? 'inline-flex' : 'none';
    };
    $('kf_dur').oninput = onDurationChange;

    // Scrub by dragging the playhead or clicking the track background.
    el.track.addEventListener('mousedown', (e) => {
        if (e.target.closest && e.target.closest('.kf_marker')) return; // markers handle themselves
        e.preventDefault();
        beginScrub(e.clientX);
    });

    renderTimeline();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
} else {
    wire();
}
