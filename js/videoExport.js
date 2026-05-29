// Keyframe-timeline camera fly-through + MP4 export.
// Reuses the viewer globals defined in main.js: camera, controls, composer,
// renderer, mixer, outlinePass, fxaaPass. Loaded as an ES module after main.js.

const RES_PRESETS = {
    '720p':  [1280, 720],
    '1080p': [1920, 1080],
    '1440p': [2560, 1440],
    '4k':    [3840, 2160],
};

// Each keyframe stores a camera pose. Timeline time is derived from index +
// the current duration, so keyframes stay evenly spaced when duration changes.
const keyframes = []; // { pos: THREE.Vector3, target: THREE.Vector3 }

let posCurve = null, targetCurve = null;
let previewRAF = null;

// --- UI refs (populated on DOMContentLoaded) -------------------------------
let el = {};

function $(id) { return document.getElementById(id); }

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

// --- Keyframe management ---------------------------------------------------
function rebuildCurves() {
    posCurve = targetCurve = null;
    if (keyframes.length >= 2) {
        posCurve = new THREE.CatmullRomCurve3(keyframes.map(k => k.pos.clone()));
        targetCurve = new THREE.CatmullRomCurve3(keyframes.map(k => k.target.clone()));
    }
}

function addKeyframe() {
    keyframes.push({
        pos: window.camera.position.clone(),
        target: window.controls.target.clone(),
    });
    rebuildCurves();
    renderList();
}

function deleteKeyframe(i) {
    keyframes.splice(i, 1);
    rebuildCurves();
    renderList();
}

function clearKeyframes() {
    keyframes.length = 0;
    rebuildCurves();
    renderList();
}

function jumpTo(i) {
    const k = keyframes[i];
    if (!k) return;
    window.camera.position.copy(k.pos);
    window.controls.target.copy(k.target);
    window.controls.update();
}

// Fills outPos/outTarget for the given timeline time. Requires >= 1 keyframe.
function sampleAt(time, outPos, outTarget) {
    const n = keyframes.length;
    if (n === 0) return false;
    if (n === 1) {
        outPos.copy(keyframes[0].pos);
        outTarget.copy(keyframes[0].target);
        return true;
    }
    const dur = getDuration();
    const u = dur > 0 ? Math.min(1, Math.max(0, time / dur)) : 0;
    posCurve.getPoint(u, outPos);
    targetCurve.getPoint(u, outTarget);
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

// --- UI rendering ----------------------------------------------------------
function renderList() {
    const list = $('kf_list');
    list.innerHTML = '';
    const dur = getDuration();
    keyframes.forEach((k, i) => {
        const t = keyframes.length > 1 ? (i / (keyframes.length - 1)) * dur : 0;
        const row = document.createElement('div');
        row.className = 'kf_row';
        const label = document.createElement('span');
        label.className = 'kf_label';
        label.textContent = `#${i + 1}  ${t.toFixed(2)}s`;
        label.title = 'Jump camera to this keyframe';
        label.onclick = () => jumpTo(i);
        const del = document.createElement('button');
        del.className = 'kf_del';
        del.textContent = '×';
        del.title = 'Delete keyframe';
        del.onclick = () => deleteKeyframe(i);
        row.appendChild(label);
        row.appendChild(del);
        list.appendChild(row);
    });
    if (keyframes.length === 0) {
        list.innerHTML = '<div class="kf_empty">No keyframes. Orbit the model and click "Add Keyframe".</div>';
    }
    const ready = keyframes.length >= 2;
    $('kf_preview').disabled = !ready;
    $('kf_export').disabled = !ready;
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
    $('kf_preview').textContent = 'Stop';
    setStatus('Previewing...');

    const step = () => {
        const t = (performance.now() - start) / 1000;
        if (t >= dur) { stopPreview(); return; }
        sampleAt(t, pos, target);
        applyPose(pos, target);
        advanceMixer(t);
        window.composer.render();
        previewRAF = requestAnimationFrame(step);
    };
    previewRAF = requestAnimationFrame(step);
}

function stopPreview() {
    if (previewRAF) cancelAnimationFrame(previewRAF);
    previewRAF = null;
    window.videoExporting = false; // resume main loop
    $('kf_preview').textContent = 'Preview';
    setStatus('');
}

// --- Export size handling --------------------------------------------------
function applyExportSize(W, H) {
    window.renderer.setPixelRatio(1);
    window.renderer.setSize(W, H, false);
    window.composer.setSize(W, H);
    window.camera.aspect = W / H;
    window.camera.updateProjectionMatrix();
    if (window.fxaaPass) {
        window.fxaaPass.material.uniforms['resolution'].value.set(1 / W, 1 / H);
    }
    if (window.outlinePass) window.outlinePass.setSize(W, H);
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

// Returns { codec, hardwareAcceleration } or null.
async function chooseCodec(W, H, fps, bitrate) {
    const lvlHex = avcLevel(W, H, fps).toString(16).padStart(2, '0');
    // Profiles: High (6400), Main (4d00), Constrained Baseline (4200).
    const codecs = ['6400', '4d00', '4200'].map(p => 'avc1.' + p + lvlHex);
    const accels = ['no-preference', 'prefer-hardware', 'prefer-software'];
    for (const hardwareAcceleration of accels) {
        for (const codec of codecs) {
            const cfg = { codec, width: W, height: H, framerate: fps, bitrate, hardwareAcceleration };
            try {
                const sup = await VideoEncoder.isConfigSupported(cfg);
                if (sup && sup.supported) return { codec, hardwareAcceleration };
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
    const bitrate = Math.min(60_000_000, Math.max(1_000_000, Math.round(W * H * fps * 0.07)));

    const picked = await chooseCodec(W, H, fps, bitrate);
    if (!picked) {
        alert(`No supported H.264 encoder config for ${W}x${H} @ ${fps}fps. Try a smaller resolution.`);
        return;
    }
    const { codec, hardwareAcceleration } = picked;

    const btn = $('kf_export');
    btn.disabled = true;
    $('kf_preview').disabled = true;
    $('kf_progress').style.display = 'block';
    $('kf_progress').value = 0;
    window.videoExporting = true;

    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: W, height: H, frameRate: fps },
        fastStart: 'in-memory',
    });

    const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { console.error('VideoEncoder error:', e); setStatus('Encoder error: ' + e.message); },
    });
    encoder.configure({ codec, width: W, height: H, framerate: fps, bitrate, hardwareAcceleration });

    const pos = new THREE.Vector3(), target = new THREE.Vector3();

    try {
        applyExportSize(W, H);
        resetMixerClock();
        for (let i = 0; i < totalFrames; i++) {
            const t = i / fps;
            sampleAt(t, pos, target);
            applyPose(pos, target);
            advanceMixer(t);
            window.composer.render();

            // Capture synchronously while the drawing buffer is still intact.
            const frame = new VideoFrame(window.renderer.domElement, {
                timestamp: Math.round(i * 1e6 / fps),
                duration: Math.round(1e6 / fps),
            });
            encoder.encode(frame, { keyFrame: i % (2 * fps) === 0 });
            frame.close();

            $('kf_progress').value = ((i + 1) / totalFrames) * 100;
            setStatus(`Rendering ${i + 1}/${totalFrames} @ ${resLabel()} ${fps}fps`);

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
        try { encoder.close(); } catch (e) {}
        restoreViewerSize();
        window.videoExporting = false;
        $('kf_progress').style.display = 'none';
        btn.disabled = false;
        $('kf_preview').disabled = false;
    }
}

// --- Wiring ----------------------------------------------------------------
function wire() {
    $('kf_add').onclick = addKeyframe;
    $('kf_clear').onclick = clearKeyframes;
    $('kf_preview').onclick = () => { previewRAF ? stopPreview() : previewPlayback(); };
    $('kf_export').onclick = exportMP4;
    $('kf_res').onchange = () => {
        $('kf_custom').style.display = $('kf_res').value === 'custom' ? 'block' : 'none';
    };
    $('kf_dur').onchange = renderList; // re-spacing labels
    renderList();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
} else {
    wire();
}
