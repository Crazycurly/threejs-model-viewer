'use strict';
// Loads the viewer's OWN r90 three.js + loaders + post-FX into Node's global
// scope, so server renders use the exact same code paths as the browser (no
// version drift). Each repo script is an old-style global/UMD build: running it
// via `new Function(code).call(global)` puts `this` = Node global, so three's
// UMD sets `global.THREE` and the example loaders/effects extend it.

const fs = require('fs');
const path = require('path');
const { installEnvironment, REPO_ROOT } = require('./domShim');

// Repo scripts, in dependency order — mirrors the <script> tags in index.html.
const SCRIPTS = [
    'js/three.js',
    'js/loaders/inflate.min.js',   // Zlib, used by FBXLoader binary
    'js/loaders/MTLLoader.js',
    'js/loaders/OBJLoader.js',
    'js/loaders/STLLoader.js',
    'js/loaders/ColladaLoader.js',
    'js/loaders/FBXLoader.js',
    'js/loaders/DDSLoader.js',
    'js/loaders/GLTFLoader.js',
    'js/effects/CopyShader.js',
    'js/effects/EffectComposer.js',
    'js/effects/RenderPass.js',
    'js/effects/ShaderPass.js',
    'js/effects/FXAAShader.js',
    'js/effects/OutlinePass.js',
];

function runRepoScript(rel) {
    const file = path.join(REPO_ROOT, rel);
    let code = fs.readFileSync(file, 'utf8');
    if (code.charCodeAt(0) === 0xFEFF) code = code.slice(1); // strip BOM
    // Inject the browser-ish globals as explicit params so resolution is
    // deterministic (Node's eval/global can otherwise expose module/exports,
    // which would send three's UMD down the CommonJS branch and never set the
    // browser-global THREE). `this` = global so anything the scripts attach to
    // `this` (three's UMD, zlib) still lands on the shared global.
    //   - module/exports/define = undefined  -> force UMD browser-global branch
    //   - THREE/Zlib                          -> what the legacy scripts expect
    const fn = new Function(
        'window', 'document', 'self', 'THREE', 'Zlib', 'module', 'exports', 'define',
        code + '\n//# sourceURL=' + file
    );
    fn.call(global, global.window, global.document, global, global.THREE, global.Zlib, undefined, undefined, undefined);
}

let _loaded = false;

function loadThree() {
    if (_loaded) return global.THREE;
    installEnvironment();
    for (const rel of SCRIPTS) {
        try {
            runRepoScript(rel);
        } catch (e) {
            throw new Error(`Failed loading ${rel}: ${e.message}`);
        }
    }
    if (!global.THREE) throw new Error('three.js did not register a global THREE.');
    _loaded = true;
    return global.THREE;
}

module.exports = { loadThree };
