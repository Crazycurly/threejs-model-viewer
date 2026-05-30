'use strict';
// Camera-path sampling ported verbatim from js/videoExport.js (sortKeyframes /
// rebuildCurves / sampleAt / applyPose). KEEP IN SYNC with that file — same
// algorithm, so a server render matches the browser preview frame-for-frame.

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

// keyframes: [{ time, pos: THREE.Vector3, target: THREE.Vector3 }]
function createSampler(THREE, keyframes, easing, duration) {
    keyframes = keyframes.slice().sort((a, b) => a.time - b.time);

    let posCurve = null, targetCurve = null;
    if (keyframes.length >= 2) {
        posCurve = new THREE.CatmullRomCurve3(keyframes.map(k => k.pos.clone()));
        targetCurve = new THREE.CatmullRomCurve3(keyframes.map(k => k.target.clone()));
    }

    function sampleAt(time, outPos, outTarget) {
        const n = keyframes.length;
        if (n === 0) return false;
        if (n === 1) {
            outPos.copy(keyframes[0].pos);
            outTarget.copy(keyframes[0].target);
            return true;
        }
        const t = clamp(time, 0, duration);
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

        if (easing === 'linear') {
            outPos.lerpVectors(keyframes[i].pos, keyframes[i + 1].pos, localFrac);
            outTarget.lerpVectors(keyframes[i].target, keyframes[i + 1].target, localFrac);
        } else {
            const u = (i + localFrac) / (n - 1);
            posCurve.getPoint(u, outPos);
            targetCurve.getPoint(u, outTarget);
        }
        return true;
    }

    return { sampleAt };
}

// Mirror of videoExport.js applyPose.
function applyPose(camera, pos, target) {
    camera.position.copy(pos);
    camera.lookAt(target);
    camera.updateMatrixWorld();
}

module.exports = { createSampler, applyPose };
