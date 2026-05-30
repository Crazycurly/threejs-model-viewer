'use strict';
// Minimal browser environment so the viewer's own (r90) three.js, loaders and
// post-FX run unmodified under Node.
//
//   * jsdom supplies document / window / DOMParser (Collada & glTF need real
//     DOM + XML parsing).
//   * headless-gl ("gl") supplies a real WebGL1 context for an offscreen
//     canvas we hand to THREE.WebGLRenderer.
//
// Everything lives in Node's single realm (no vm sandbox) so jsdom DOM objects
// and THREE objects interoperate freely.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO_ROOT = path.resolve(__dirname, '..');

// Pull the X-ray shader source straight from the viewer's index.html so the
// server stays in sync with what materials.xrayMaterial reads in the browser.
function readShaderTags() {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    const grab = (id) => {
        const re = new RegExp('<script[^>]*id=["\']' + id + '["\'][^>]*>([\\s\\S]*?)</script>', 'i');
        const m = html.match(re);
        return m ? m[1] : '';
    };
    return { vertexShader: grab('vertexShader'), fragmentShader: grab('fragmentShader') };
}

let _installed = false;

// Install the global environment. Idempotent.
function installEnvironment() {
    if (_installed) return global.window;

    const { vertexShader, fragmentShader } = readShaderTags();
    const dom = new JSDOM(
        `<!DOCTYPE html><html><head>
            <script id="vertexShader" type="x-shader/x-vertex">${vertexShader}</script>
            <script id="fragmentShader" type="x-shader/x-vertex">${fragmentShader}</script>
         </head><body></body></html>`,
        { pretendToBeVisual: true }
    );

    const win = dom.window;
    const doc = win.document;

    // jsdom's <canvas> has no WebGL; route canvas creation to a gl-backed one.
    const origCreate = doc.createElement.bind(doc);
    doc.createElement = function (tag) {
        if (String(tag).toLowerCase() === 'canvas') return makeGLCanvas(1, 1);
        return origCreate(tag);
    };
    const origCreateNS = doc.createElementNS.bind(doc);
    doc.createElementNS = function (ns, tag) {
        if (String(tag).toLowerCase() === 'canvas') return makeGLCanvas(1, 1);
        return origCreateNS(ns, tag);
    };

    // Some of these (e.g. navigator) are read-only getters on modern Node, so
    // assign defensively.
    const setGlobal = (name, value) => {
        try { global[name] = value; }
        catch (e) { try { Object.defineProperty(global, name, { value, configurable: true, writable: true }); } catch (e2) { /* leave Node's own */ } }
    };

    setGlobal('window', win);
    setGlobal('document', doc);
    setGlobal('self', win);
    if (win.navigator) setGlobal('navigator', win.navigator);
    setGlobal('Image', win.Image);
    setGlobal('HTMLElement', win.HTMLElement);
    setGlobal('HTMLCanvasElement', win.HTMLCanvasElement);
    setGlobal('DOMParser', win.DOMParser);
    setGlobal('XMLHttpRequest', win.XMLHttpRequest);
    if (typeof global.requestAnimationFrame !== 'function') {
        setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 16));
        setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
    }
    win.requestAnimationFrame = global.requestAnimationFrame;

    _installed = true;
    return win;
}

// A canvas-like object backed by a headless-gl WebGL1 context. preserveDrawingBuffer
// lets us gl.readPixels() after composer.render().
function makeGLCanvas(width, height) {
    let createGL;
    try {
        createGL = require('gl');
    } catch (e) {
        throw new Error(
            "headless-gl ('gl') is not installed. Run `npm install` in server/ " +
            '(it builds a native addon needing python + GL dev libs — see server/README.md).'
        );
    }
    const gl = createGL(Math.max(1, width | 0), Math.max(1, height | 0), {
        preserveDrawingBuffer: true,
        antialias: false, // AA happens via the FXAA pass + supersample, like the browser
    });
    if (!gl) {
        throw new Error(
            'headless-gl failed to create a WebGL context. On Linux install the GL dev ' +
            'libraries and (if headless) run under xvfb — see server/README.md.'
        );
    }

    const canvas = {
        width: width,
        height: height,
        style: {},
        __gl: gl,
        getContext(type) {
            if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') return gl;
            return null;
        },
        getContextAttributes() { return gl.getContextAttributes ? gl.getContextAttributes() : {}; },
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; },
    };
    return canvas;
}

// Read the drawing buffer as RGBA bytes (rows bottom-to-top, GL convention).
function readPixels(canvas) {
    const gl = canvas.__gl;
    const w = canvas.width, h = canvas.height;
    const buf = Buffer.alloc(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
}

module.exports = { installEnvironment, makeGLCanvas, readPixels, REPO_ROOT };
