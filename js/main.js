var container = document.getElementById('container');
var view = document.getElementById('main_viewer');

if (!Detector.webgl) Detector.addGetWebGLMessage();

var camera, camerHelper, scene, renderer, loader,
    stats, controls, numOfMeshes = 0, model, modelDuplicate, sample_model, wireframe, mat, scale, delta;

//MULTI-MODEL GLOBALS
var loadedModels = [];      // [{ obj, name }] — every model currently in the scene
var selectedModel = null;   // the model the gizmo + transform panel act on
var transformControls;      // shared move/rotate/scale gizmo
var raycaster;              // click-to-select picking

const manager = new THREE.LoadingManager();

var modelLoaded = false, sample_model_loaded = false;
var modelWithTextures = false, fbxLoaded = false, gltfLoaded = false;;
var bg_Texture = false;

var glow_value, selectedObject, composer, effectFXAA, position, outlinePass, ssaaRenderPass;
var clock = new THREE.Clock();

var ambient, directionalLight, directionalLight2, directionalLight3, pointLight, bg_colour;
var backgroundScene, backgroundCamera, backgroundMesh;

var amb = document.getElementById('ambient_light');
var wire = document.getElementById('wire_check');
var model_wire = document.getElementById('model_wire');
var phong = document.getElementById('phong_check');
var xray = document.getElementById('xray_check');
var glow = document.getElementById('glow_check');
var smooth = document.getElementById('smooth');
var outline = document.getElementById('outline');

var statsNode = document.getElementById('stats');

//ANIMATION GLOBALS
var animations = {}, animationsSelect = document.getElementById("animationSelect"),
animsDiv = document.getElementById("anims"), mixer, currentAnimation, actions = {};

//X-RAY SHADER MATERIAL
//http://free-tutorials.org/shader-x-ray-effect-with-three-js/
var materials = {
    default_material: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }),
    default_material2: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }),
    wireframeMaterial: new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        wireframe: true,
        color: 0xffffff,
        depthWrite: true, depthTest: true
    }),
    wireframeMaterial2: new THREE.LineBasicMaterial({ wireframe: true, color: 0xffffff }),
    wireframeAndModel: new THREE.LineBasicMaterial({ color: 0xffffff }),
    phongMaterial: new THREE.MeshPhongMaterial({
        color: 0x555555, specular: 0xffffff, shininess: 10,
        flatShading: false, side: THREE.DoubleSide, skinning: true
    }),
    xrayMaterial: new THREE.ShaderMaterial({
        uniforms: {
            p: { type: "f", value: 3 },
            glowColor: { type: "c", value: new THREE.Color(0x84ccff) },
        },
        vertexShader: document.getElementById('vertexShader').textContent,
        fragmentShader: document.getElementById('fragmentShader').textContent,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false
    })
};

var clock = new THREE.Clock();
var winDims = [window.innerWidth * 0.8, window.innerHeight * 0.89]; //size of renderer

function onload() {

    //window.addEventListener('resize', onWindowResize, false);
    initScene();
    loadSampleModel(0);
    animate();
}

function initScene() {

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500000);
    camera.position.set(0, 0, 20);

    //Setup renderer
    //renderer = new THREE.CanvasRenderer({ alpha: true });
    renderer = new THREE.WebGLRenderer();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setClearColor(0x000000); //default background black
    document.body.style.background = '#000000';

    view.appendChild(renderer.domElement);

    THREEx.WindowResize(renderer, camera);

    function toggleFullscreen(elem) {
        elem = elem || document.documentElement;
        if (!document.fullscreenElement && !document.mozFullScreenElement &&
            !document.webkitFullscreenElement && !document.msFullscreenElement) {

            THREEx.FullScreen.request(container);

        }
        else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
                //renderer.setSize(winDims[0], winDims[1]); //Reset renderer size on fullscreen exit
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
                //renderer.setSize(winDims[0], winDims[1]);
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
               // renderer.setSize(winDims[0], winDims[1]);
            }
        }
    }

    document.getElementById('fullscreenBtn').addEventListener('click', function () {
        toggleFullscreen();
    });
  
    ambient = new THREE.AmbientLight(0x404040);
    scene.add(ambient); //on by default (checkbox checked)
    $('#ambient_light').change(function () {
        if (amb.checked) {
            scene.add(ambient);
        }
        else {
            scene.remove(ambient);
        }
    });

    /*LIGHTS*/
    directionalLight = new THREE.DirectionalLight(0xffeedd);
    directionalLight.position.set(0, 0, 1).normalize();
    scene.add(directionalLight);

    directionalLight2 = new THREE.DirectionalLight(0xffeedd);
    directionalLight2.position.set(0, 0, -1).normalize();
    scene.add(directionalLight2);

    directionalLight3 = new THREE.DirectionalLight(0xffeedd);
    directionalLight3.position.set(0, 1, 0).normalize();
    scene.add(directionalLight3);

    var ambientLight = new THREE.AmbientLight(0x808080, 0.2); //Grey colour, low intensity
    scene.add(ambientLight);

    pointLight = new THREE.PointLight(0xcccccc, 0.5);
    camera.add(pointLight);

    scene.add(camera);
    
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.rotateSpeed = 0.09;

    //Colour changer, to set background colour of renderer to user chosen colour
    $(".bg_select").spectrum({
        color: "#000",
        change: function (color) {
            $("#basic_log").text("Hex Colour Selected: " + color.toHexString()); //Log information
            var bg_value = $(".bg_select").spectrum('get').toHexString(); //Get the colour selected
            renderer.setClearColor(bg_value); //Set renderer colour to the selected hex value
            ssaaRenderPass.clearColor = bg_value;
            document.body.style.background = bg_value; //Set body of document to selected colour           
        }
    });

    // postprocessing    
    var renderPass = new THREE.RenderPass( scene, camera );

    var fxaaPass = new THREE.ShaderPass( THREE.FXAAShader );
    var pixelRatio = renderer.getPixelRatio();

    fxaaPass.material.uniforms[ 'resolution' ].value.x = 1 / ( window.innerWidth * pixelRatio );
    fxaaPass.material.uniforms[ 'resolution' ].value.y = 1 / ( window.innerHeight * pixelRatio );
    fxaaPass.renderToScreen = true;

    outlinePass = new THREE.OutlinePass(new THREE.Vector2(window.innerWidth, window.innerHeight), scene, camera);   
    outlinePass.edgeStrength = 1.5; 
    outlinePass.edgeGlow = 2;

    composer = new THREE.EffectComposer( renderer );
    composer.addPass( renderPass );
    composer.addPass(outlinePass);
    composer.addPass( fxaaPass );

    window.fxaaPass = fxaaPass; // exposed so videoExport.js can rescale AA at export resolution

    outlinePass.enabled = false; //glow off by default (toggled by #glow_check)

    loader = new THREE.OBJLoader(manager); //shared OBJ loader (sample models + user .obj files)

    // Single shared transform gizmo for moving/rotating/scaling the selected model
    transformControls = new THREE.TransformControls(camera, renderer.domElement);
    scene.add(transformControls);
    // Stop OrbitControls from fighting the gizmo while dragging it (r90 has no
    // 'dragging-changed' event, so gate on mouseDown/mouseUp instead)
    transformControls.addEventListener('mouseDown', function () { controls.enabled = false; });
    transformControls.addEventListener('mouseUp', function () { controls.enabled = true; });
    transformControls.addEventListener('objectChange', function () { syncPanelFromModel(); });

    raycaster = new THREE.Raycaster();

    initModelManager(); //wire click-to-select + transform panel (modelManager.js)
}

/*LOAD SAMPLE MODELS*/
function loadSampleModel(index) {

    var sceneInfo = modelList[index]; //index from array of sample models in html select options
    var url = sceneInfo.url;

    // Remember the sample model's URL so videoExport.js can fetch + embed it
    // when building a render script.
    window.currentModelSource = { kind: 'url', url: url, filename: url.split(/[\/\\]/).pop(), format: 'obj' };

    //progress/loading bar
    var onProgress = function (data) {
        if (data.lengthComputable) { //if size of file transfer is known
            var percentage = Math.round((data.loaded * 100) / data.total);
            console.log(percentage);
            statsNode.innerHTML = 'Loaded : ' + percentage + '%' + ' of ' + sceneInfo.name
            + '<br>'
            + '<progress value="0" max="100" class="progress"></progress>';
            $('.progress').css({ 'width': percentage + '%' });
            $('.progress').val(percentage);
        }
    }
    var onError = function (xhr) {
        console.log('ERROR');
    };

    loader.load(url, function (data) {

        sample_model = data;
        sample_model_loaded = true;

        console.log(sample_model);

        sample_model.traverse(function (child) {
            if (child instanceof THREE.Mesh) {

                numOfMeshes++;
                var geometry = child.geometry;
                stats(sceneInfo.name, geometry, numOfMeshes);

                child.material = materials.default_material;

                var wireframe2 = new THREE.WireframeGeometry(child.geometry);
                var edges = new THREE.LineSegments(wireframe2, materials.wireframeAndModel);
                materials.wireframeAndModel.visible = false;
                sample_model.add(edges);

                setWireFrame(child);
                setWireframeAndModel(child);

                setPhong(child);
                setXray(child);

            }
        });

        setSmooth(sample_model);

        setBoundBox(sample_model);
        setPolarGrid(sample_model);
        setGrid(sample_model);
        setAxis(sample_model);

        scaleUp(sample_model);
        scaleDown(sample_model);

        registerModel(sample_model, sceneInfo.name); //add + select (handles camera/outline/scene.add)

    }, onProgress, onError);
}

function removeModel() {

    scene.remove(model);
    scale = 1;
    numOfMeshes = 0;
    modelLoaded = false;
    modelWithTextures = false;
    fbxLoaded = false;
    gltfLoaded = false;
    
    // ambient stays in the scene — on by default

    $('#point_light').slider("value", 0.5);
    pointLight.intensity = 0.5;

    camera.position.set(0, 0, 20); //Reset camera to initial position
    controls.reset(); //Reset controls, for when previous object has been moved around e.g. larger object = larger rotation
    statsNode.innerHTML = ''; //Reset stats box (faces, vertices etc)

    $("#red, #green, #blue, #ambient_red, #ambient_green, #ambient_blue").slider("value", 127); //Reset colour sliders

    amb.checked = true; wire.checked = true; //defaults: ambient + wireframe on
    model_wire.checked = false; phong.checked = false; xray.checked = false;
    glow.checked = false;
    smooth.checked = false; 
    smooth.disabled = false; //Uncheck any checked boxes
    

    document.getElementById('smooth-model').innerHTML = "Smooth Model";

    $('#shine').slider("value", 10); //Set phong shine level back to initial

    
    animsDiv.style.display = "none"; //Hide animation <div>
}

// #remove (now "Remove Selected") is wired in modelManager.js → removeSelectedModel()

$("#red, #green, #blue, #ambient_red, #ambient_green, #ambient_blue").slider({
    change: function (event, ui) {
        console.log(ui.value);
        render();
    }
});



function setColours() {

    var colour = getColours($('#red').slider("value"), $('#green').slider("value"), $('#blue').slider("value"));
    directionalLight.color.setRGB(colour[0], colour[1], colour[2]);
    directionalLight2.color.setRGB(colour[0], colour[1], colour[2]);
    directionalLight3.color.setRGB(colour[0], colour[1], colour[2]);

    var colour = getColours($('#ambient_red').slider("value"), $('#ambient_green').slider("value"),
                            $('#ambient_blue').slider("value"));
    ambient.color.setRGB(colour[0], colour[1], colour[2]);

}

function getColours(r, g, b) {

    var colour = [r.valueOf() / 255, g.valueOf() / 255, b.valueOf() / 255];
    return colour;
}

function render() {

    setColours();
   // renderer.render(scene, camera);
}

function animate() {

    delta = clock.getDelta();
    requestAnimationFrame(animate);

    if (window.videoExporting) return; // paused during preview/export, driven manually by videoExport.js

    if (mixer) {
        mixer.update(delta);
    }

    updateCameraMove(delta); // WASD/QE pan the camera + orbit target
    controls.update(delta);

    if (transformControls && transformControls.object) {
        transformControls.update(); // keep gizmo sized/oriented as the camera orbits
    }

    composer.render();
    render();

}
var modelList = [
            {
                name: "crash.obj", url: 'sample_models/crash2.obj'
            },
            {
                name: "bear.obj", url: 'sample_models/bear-obj.obj'
            },
            {
                name: "car.obj", url: 'sample_models/car2.obj'
                //, objectRotation: new THREE.Euler(0, 3 * Math.PI / 2, 0)
                        
            },
            {
                name: "tiger.obj", url: 'sample_models/Tiger.obj'
            },
            {
                name: "dinosaur.obj", url: 'sample_models/Dinosaur_V02.obj'
            },
            {
                name: "skeleton.obj", url: 'sample_models/skeleton.obj'
            }
];

// Sample-model dropdown — additive: append the chosen sample to the scene
function selectModel() {

    var select = document.getElementById("scenes_list");
    var index = select.selectedIndex;

    if (index >= 0) {
        loadSampleModel(index);
    }

}

onload();
