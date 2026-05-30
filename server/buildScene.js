'use strict';
// Recreates the viewer scene (js/main.js) against the loaded THREE, applies the
// render script's scene state, loads the embedded model, and wires the same
// composer chain (RenderPass -> OutlinePass -> FXAA).

function rgb255(c) { return [c[0] / 255, c[1] / 255, c[2] / 255]; }

// Mirror of materials in js/main.js. xrayMaterial reads the shader source from
// the (jsdom) DOM, exactly like the browser does.
function createMaterials(THREE) {
    return {
        default_material: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }),
        wireframeMaterial: new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide, wireframe: true, color: 0xffffff,
            depthWrite: true, depthTest: true,
        }),
        wireframeAndModel: new THREE.LineBasicMaterial({ color: 0xffffff }),
        phongMaterial: new THREE.MeshPhongMaterial({
            color: 0x555555, specular: 0xffffff, shininess: 10,
            flatShading: false, side: THREE.DoubleSide, skinning: true,
        }),
        xrayMaterial: new THREE.ShaderMaterial({
            uniforms: {
                p: { type: 'f', value: 3 },
                glowColor: { type: 'c', value: new THREE.Color(0x84ccff) },
            },
            vertexShader: document.getElementById('vertexShader').textContent,
            fragmentShader: document.getElementById('fragmentShader').textContent,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
            transparent: true, depthWrite: false,
        }),
    };
}

function buildScene(THREE, renderer, script, RW, RH) {
    const sc = script.scene || {};
    const lights = sc.lights || {};
    const mat = sc.material || {};
    const camCfg = script.camera || {};

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(
        camCfg.fov || 70, RW / RH, camCfg.near || 0.1, camCfg.far || 500000
    );

    // Lights (js/main.js initScene). Colours come from the slider-driven live
    // values captured in the script.
    const ambient = new THREE.AmbientLight(0x404040);
    if (lights.ambientColor255) ambient.color.setRGB.apply(ambient.color, rgb255(lights.ambientColor255));
    if (lights.ambientEnabled !== false) scene.add(ambient);

    const dirColor = lights.directionalColor255 ? rgb255(lights.directionalColor255) : null;
    [[0, 0, 1], [0, 0, -1], [0, 1, 0]].forEach((p) => {
        const d = new THREE.DirectionalLight(0xffeedd);
        d.position.set(p[0], p[1], p[2]).normalize();
        if (dirColor) d.color.setRGB(dirColor[0], dirColor[1], dirColor[2]);
        scene.add(d);
    });

    scene.add(new THREE.AmbientLight(0x808080, 0.2));

    const pointLight = new THREE.PointLight(0xcccccc, lights.pointIntensity != null ? lights.pointIntensity : 0.5);
    camera.add(pointLight);
    scene.add(camera);

    renderer.setClearColor(sc.background || '#000000');

    const materials = createMaterials(THREE);
    if (mat.phongShininess != null) materials.phongMaterial.shininess = mat.phongShininess;

    // Composer chain identical to js/main.js.
    const composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));

    const outlinePass = new THREE.OutlinePass(new THREE.Vector2(RW, RH), scene, camera);
    outlinePass.edgeStrength = mat.glowEdgeStrength != null ? mat.glowEdgeStrength : 1.5;
    outlinePass.edgeGlow = 2;
    outlinePass.enabled = !!mat.glowEnabled;
    if (mat.glowColor && outlinePass.visibleEdgeColor) outlinePass.visibleEdgeColor.set(mat.glowColor);
    composer.addPass(outlinePass);

    const fxaaPass = new THREE.ShaderPass(THREE.FXAAShader);
    fxaaPass.material.uniforms['resolution'].value.set(1 / RW, 1 / RH);
    fxaaPass.renderToScreen = true;
    composer.addPass(fxaaPass);

    return { scene, camera, composer, outlinePass, fxaaPass, materials, pointLight };
}

function bufToArrayBuffer(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// Load the embedded model via the same per-format loaders the browser uses.
// Returns { model, animations }.
function loadModel(THREE, script) {
    return new Promise((resolve, reject) => {
        const m = script.model;
        if (!m || !m.data) return reject(new Error('Render script has no embedded model.'));
        const buf = Buffer.from(m.data, 'base64');
        const format = (m.format || '').toLowerCase();

        try {
            switch (format) {
                case 'obj': {
                    const objLoader = new THREE.OBJLoader();
                    const mtlAsset = (m.assets || []).find(a => /\.mtl$/i.test(a.name));
                    if (mtlAsset) {
                        const mtlLoader = new THREE.MTLLoader();
                        const materials = mtlLoader.parse(Buffer.from(mtlAsset.data, 'base64').toString('utf8'), '');
                        materials.preload();
                        objLoader.setMaterials(materials);
                    }
                    const model = objLoader.parse(buf.toString('utf8'));
                    model.userData.__textured = !!mtlAsset;
                    return resolve({ model, animations: [] });
                }
                case 'stl': {
                    const geometry = new THREE.STLLoader().parse(bufToArrayBuffer(buf));
                    const model = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }));
                    model.userData.__textured = false;
                    return resolve({ model, animations: [] });
                }
                case 'dae': {
                    const collada = new THREE.ColladaLoader().parse(buf.toString('utf8'), '');
                    collada.scene.userData.__textured = true;
                    return resolve({ model: collada.scene, animations: collada.animations || [] });
                }
                case 'fbx': {
                    const model = new THREE.FBXLoader().parse(bufToArrayBuffer(buf), '');
                    model.userData.__textured = true;
                    return resolve({ model, animations: model.animations || [] });
                }
                case 'glb':
                case 'gltf': {
                    const data = format === 'glb' ? bufToArrayBuffer(buf) : buf.toString('utf8');
                    new THREE.GLTFLoader().parse(data, '', (gltf) => {
                        gltf.scene.userData.__textured = true;
                        resolve({ model: gltf.scene, animations: gltf.animations || [] });
                    }, (err) => reject(new Error('glTF parse failed: ' + (err && err.message || err))));
                    return;
                }
                default:
                    return reject(new Error('Unsupported model format: ' + format));
            }
        } catch (e) {
            reject(e);
        }
    });
}

// Apply the captured material mode (mutually-exclusive in the viewer) + smooth.
// Mirrors js/utils.js setWireFrame/setPhong/setXray + setSmooth.
function applyMaterial(THREE, model, materials, mat) {
    const mode = (mat && mat.mode) || 'default';
    const textured = !!model.userData.__textured;

    model.traverse((child) => {
        if (!child.isMesh) return;
        const original = child.material;
        switch (mode) {
            case 'wireframe': child.material = materials.wireframeMaterial; break;
            case 'phong':     child.material = materials.phongMaterial; break;
            case 'xray':      child.material = materials.xrayMaterial; break;
            case 'glow':      // glow keeps the surface material; outline is a post pass
            case 'modelWire':
            case 'default':
            default:
                child.material = textured ? original : materials.default_material;
                break;
        }
        if (mat && mat.smooth && child.geometry && child.geometry.computeVertexNormals) {
            child.geometry.computeVertexNormals();
        }
    });
}

function applyTransform(model, t) {
    if (!t) return;
    if (t.position) model.position.set(t.position[0], t.position[1], t.position[2]);
    if (t.quaternion) model.quaternion.set(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
    if (t.scale) model.scale.set(t.scale[0], t.scale[1], t.scale[2]);
    model.updateMatrixWorld(true);
}

module.exports = { buildScene, loadModel, applyMaterial, applyTransform };
