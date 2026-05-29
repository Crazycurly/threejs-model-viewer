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
const QUALITY_PRESETS = {
    'draft':    { ss: 1, bpp: 0.05 },
    'standard': { ss: 1, bpp: 0.12 },
    'high':     { ss: 2, bpp: 0.18 },
};

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
    const { ss, bpp } = getQuality();
    const bitrate = Math.min(80_000_000, Math.max(1_000_000, Math.round(W * H * fps * bpp)));

    // Supersample factor, capped so the render buffer stays within GL/encoder
    // limits (~4096 px on the long edge). 4K therefore renders ~1x (crisp natively).
    const maxDim = Math.max(W, H);
    const ssEff = Math.max(1, Math.min(ss, 4096 / maxDim));
    const RW = Math.round(W * ssEff), RH = Math.round(H * ssEff);

    const picked = await chooseCodec(W, H, fps, bitrate);
    if (!picked) {
        alert(`No supported H.264 encoder config for ${W}x${H} @ ${fps}fps. Try a smaller resolution.`);
        return;
    }
    const { codec, hardwareAcceleration } = picked;

    btnsDisabledForExport(true);
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

    try {
        applyExportSize(RW, RH);
        resetMixerClock();
        for (let i = 0; i < totalFrames; i++) {
            const t = i / fps;
            sampleAt(t, pos, target);
            applyPose(pos, target);
            advanceMixer(t);
            window.composer.render();

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
        btnsDisabledForExport(false);
    }
}

function btnsDisabledForExport(busy) {
    el.add.disabled = busy;
    el.clear.disabled = busy;
    el.preview.disabled = busy || keyframes.length < 2;
    el.exportBtn.disabled = busy || keyframes.length < 2;
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
        easing: $('kf_easing'),
        track: $('kf_track'),
        markers: $('kf_markers'),
        playhead: $('kf_playhead'),
        timeCur: $('kf_time_cur'),
        timeEnd: $('kf_time_end'),
        empty: $('kf_empty'),
    };

    el.add.onclick = addKeyframe;
    el.clear.onclick = clearKeyframes;
    el.preview.onclick = () => { previewRAF ? stopPreview() : previewPlayback(); };
    el.exportBtn.onclick = exportMP4;
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
