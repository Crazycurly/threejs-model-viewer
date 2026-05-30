/*
 * modelManager.js — multi-model registry, click-to-select, transform gizmo + XYZ panel.
 *
 * Reads globals defined in main.js: scene, camera, renderer, controls,
 * transformControls, raycaster, outlinePass, loadedModels, selectedModel, model.
 * setCamera() lives in utils.js.
 */

/* ---------- registry ---------- */

// Add a freshly loaded model to the scene and select it. Called by every loader
// (sample loader in main.js, userModel.js, userModelTextures.js).
function registerModel(obj, name) {

    var isFirst = loadedModels.length === 0;

    if (isFirst) {
        loadedModels.push({ obj: obj, name: name || 'model 1' });
        scene.add(obj);
        setCamera(obj); // fit the camera to the very first model
    } else {
        // Place the new model BESIDE the existing ones so they don't overlap
        // (every loader drops models at the origin), then reframe to show all.
        offsetModel(obj);
        loadedModels.push({ obj: obj, name: name || ('model ' + (loadedModels.length + 1)) });
        scene.add(obj);
        frameAll();
    }

    selectModel3D(obj); // attach gizmo, update panel + list
}

// Shift obj along +X so its left edge sits just past the right edge of every
// model already in the scene. Keeps additive loads visibly separate.
function offsetModel(obj) {

    var groupBox = new THREE.Box3();
    var haveGroup = false;

    loadedModels.forEach(function (m) {
        groupBox.expandByObject(m.obj);
        haveGroup = true;
    });

    if (!haveGroup) return;

    var objBox = new THREE.Box3().setFromObject(obj);
    var gap = objBox.getSize().x * 0.2 + 1; // small visual gap, never zero
    obj.position.x += (groupBox.max.x + gap) - objBox.min.x;
}

// Move the camera so the combined bounding box of every loaded model is in view.
function frameAll() {

    var box = new THREE.Box3();
    loadedModels.forEach(function (m) { box.expandByObject(m.obj); });
    if (box.isEmpty()) return;

    var size = box.getSize();
    var center = box.getCenter();
    var maxDim = Math.max(size.x, size.y, size.z);
    var dist = maxDim / (2 * Math.tan(camera.fov * Math.PI / 360));

    camera.position.set(center.x, center.y, center.z + dist * 2.2);
    camera.lookAt(center);

    if (controls) {
        controls.target.copy(center);
        controls.update();
    }
}

// Make obj the active model (gizmo + panel + outline highlight act on it).
// Pass null to clear the selection.
function selectModel3D(obj) {

    selectedModel = obj;
    model = obj; // keep the legacy global pointing at the active model

    if (obj) {
        transformControls.attach(obj);
        outlinePass.selectedObjects = [obj];
    } else {
        transformControls.detach();
        outlinePass.selectedObjects = [];
    }

    syncPanelFromModel();
    refreshModelListUI();
}

// Delete the currently selected model; select the next remaining one (if any).
function removeSelectedModel() {

    if (!selectedModel) return;

    transformControls.detach();
    scene.remove(selectedModel);

    var idx = loadedModels.findIndex(function (m) { return m.obj === selectedModel; });
    if (idx !== -1) loadedModels.splice(idx, 1);

    var next = loadedModels.length
        ? loadedModels[Math.min(idx, loadedModels.length - 1)].obj
        : null;

    selectModel3D(next);
}

// Wipe every model from the scene.
function removeAllModels() {

    loadedModels.forEach(function (m) { scene.remove(m.obj); });
    loadedModels = [];
    selectModel3D(null);
}

/* ---------- click-to-select ---------- */

// Walk up the parent chain of a picked mesh until we hit a registered root model.
function findRegisteredRoot(obj) {

    var node = obj;
    while (node) {
        for (var i = 0; i < loadedModels.length; i++) {
            if (loadedModels[i].obj === node) return node;
        }
        node = node.parent;
    }
    return null;
}

function pickModel(e) {

    if (!loadedModels.length) return;

    var rect = renderer.domElement.getBoundingClientRect();
    var mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
    );

    raycaster.setFromCamera(mouse, camera);

    // Test only registered models — this skips the gizmo and the grid/bbox/axis helpers.
    var objs = loadedModels.map(function (m) { return m.obj; });
    var hits = raycaster.intersectObjects(objs, true);

    if (hits.length) {
        var root = findRegisteredRoot(hits[0].object);
        if (root) selectModel3D(root);
    }
}

/* ---------- transform panel ---------- */

function num(v, fallback) {
    var n = parseFloat(v);
    return isNaN(n) ? fallback : n;
}

function round3(v) { return Math.round(v * 1000) / 1000; }

// Push the selected model's transform into the panel inputs.
function syncPanelFromModel() {

    var has = !!selectedModel;

    $('#pos_x, #pos_y, #pos_z, #rot_x, #rot_y, #rot_z, #scl_x, #scl_y, #scl_z, #scl_uniform')
        .prop('disabled', !has);

    if (!has) {
        $('#pos_x, #pos_y, #pos_z, #rot_x, #rot_y, #rot_z, #scl_x, #scl_y, #scl_z, #scl_uniform').val('');
        return;
    }

    $('#pos_x').val(round3(selectedModel.position.x));
    $('#pos_y').val(round3(selectedModel.position.y));
    $('#pos_z').val(round3(selectedModel.position.z));

    $('#rot_x').val(Math.round(THREE.Math.radToDeg(selectedModel.rotation.x)));
    $('#rot_y').val(Math.round(THREE.Math.radToDeg(selectedModel.rotation.y)));
    $('#rot_z').val(Math.round(THREE.Math.radToDeg(selectedModel.rotation.z)));

    $('#scl_x').val(round3(selectedModel.scale.x));
    $('#scl_y').val(round3(selectedModel.scale.y));
    $('#scl_z').val(round3(selectedModel.scale.z));
    $('#scl_uniform').val(round3(selectedModel.scale.x));
}

function setActiveMode(btn) {
    $('#tc_translate, #tc_rotate, #tc_scale').removeClass('tc_active');
    $(btn).addClass('tc_active');
}

function wireTransformPanel() {

    ['x', 'y', 'z'].forEach(function (ax) {

        $('#pos_' + ax).on('input change', function () {
            if (!selectedModel) return;
            selectedModel.position[ax] = num(this.value, selectedModel.position[ax]);
        });

        $('#rot_' + ax).on('input change', function () {
            if (!selectedModel) return;
            selectedModel.rotation[ax] = THREE.Math.degToRad(num(this.value, 0));
        });

        $('#scl_' + ax).on('input change', function () {
            if (!selectedModel) return;
            var v = num(this.value, selectedModel.scale[ax]);
            if (v !== 0) selectedModel.scale[ax] = v; // 0 scale is degenerate — ignore
            $('#scl_uniform').val(''); // per-axis edit breaks uniformity
        });
    });

    // Uniform scale convenience — drives all three axes at once.
    $('#scl_uniform').on('input change', function () {
        if (!selectedModel) return;
        var v = num(this.value, 0);
        if (v > 0) {
            selectedModel.scale.set(v, v, v);
            $('#scl_x, #scl_y, #scl_z').val(round3(v));
        }
    });

    // Gizmo mode
    $('#tc_translate').click(function () { transformControls.setMode('translate'); setActiveMode(this); });
    $('#tc_rotate').click(function () { transformControls.setMode('rotate'); setActiveMode(this); });
    $('#tc_scale').click(function () { transformControls.setMode('scale'); setActiveMode(this); });

    // Removal — #remove is the existing "Remove file" button, repurposed here.
    $('#remove, #remove_selected').click(function () { removeSelectedModel(); });
    $('#remove_all').click(function () { removeAllModels(); });
}

// Rebuild the model-list rows in the panel.
function refreshModelListUI() {

    var $list = $('#model_list');
    if (!$list.length) return;

    $list.empty();

    if (!loadedModels.length) {
        $list.append('<div class="ml_empty">No models loaded</div>');
        return;
    }

    loadedModels.forEach(function (m, i) {

        var $row = $('<div class="ml_row"></div>');
        if (m.obj === selectedModel) $row.addClass('ml_selected');

        var $name = $('<span class="ml_name"></span>').text(m.name || ('model ' + (i + 1)));
        $name.click(function () { selectModel3D(m.obj); });

        var $del = $('<button class="ml_del" title="Remove this model">&times;</button>');
        $del.click(function (e) {
            e.stopPropagation();
            selectModel3D(m.obj);
            removeSelectedModel();
        });

        $row.append($name).append($del);
        $list.append($row);
    });
}

/* ---------- init ---------- */

// Called once from initScene() in main.js, after the gizmo + raycaster exist.
function initModelManager() {

    var dom = renderer.domElement;
    var downPos = null;
    var gizmoDragging = false;

    // Track gizmo drags so a release over a model doesn't immediately reselect.
    transformControls.addEventListener('mouseDown', function () { gizmoDragging = true; });
    transformControls.addEventListener('mouseUp', function () {
        setTimeout(function () { gizmoDragging = false; }, 0); // reset after the click event fires
    });

    dom.addEventListener('mousedown', function (e) {
        downPos = { x: e.clientX, y: e.clientY };
    });

    dom.addEventListener('click', function (e) {
        if (gizmoDragging) return;                 // just finished dragging the gizmo
        if (transformControls.axis) return;        // pointer is on a gizmo handle
        if (downPos && (Math.abs(e.clientX - downPos.x) > 4 ||
                        Math.abs(e.clientY - downPos.y) > 4)) return; // was an orbit/drag, not a click
        pickModel(e);
    });

    wireTransformPanel();
    refreshModelListUI();

    // Keep the gizmo hidden while the video exporter renders the scene itself.
    (function tickGizmo() {
        requestAnimationFrame(tickGizmo);
        if (!transformControls) return;
        transformControls.visible = window.videoExporting ? false : !!transformControls.object;
    })();
}
