// ========================= WebGL2 =========================
const canvas = document.getElementById("glCanvas");

// Canvas & GL
let gl = canvas.getContext("webgl2", { antialias: true });
if (!gl) { alert("WebGL2 not supported"); throw new Error("WebGL2 not supported"); }

// Handle context loss/restoration (rebuild GL; schedule redraw)
canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    cancelAnimationFrame(state._raf);
}, false);

canvas.addEventListener("webglcontextrestored", () => {
    // Rebuild everything on restore
    initGL();
    markDirty();
}, false);

// Central app state
const state = {
    // camera
    mode: "ortho",                      // 'ortho' | 'persp'
    cx: 0, cy: 0, cz: 3,                // camera position (z only used in perspective)
    ang: 0,                             // camera yaw (around Z), radians
    zoom: 1,                            // ortho only // orthographic zoom (world extent scale)
    fovDeg: 60, near: 0.01, far: 100,   // persp only // perspective FOV in degrees

    // GL stuff
    program: null,
    uniforms: null,

    // geometry cache
    geo: {},                            // geometry VAOs

    // render scheduling
    _dirty: true,
    _raf: 0,
};

// One-shot render scheduler: render once after any state change
function markDirty(){
    state._dirty = true;
    if (!state._raf) {
        state._raf = requestAnimationFrame(frame);
    }
}
function frame(){
    state._raf = 0;
    if (state._dirty) {
        render();
        state._dirty = false;
    }
}

// ========== Shaders ==========
// MVP in vertex shader: gl_Position = uViewProj * (uModel * vec4(pos,0,1))
const vsSource = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPosition;

uniform mat4 uModel;
uniform mat4 uViewProj;
uniform float uPointSize;

void main() {
  vec4 world = uModel * vec4(aPosition, 0.0, 1.0);
  gl_Position = uViewProj * world;
  gl_PointSize = uPointSize;
}`;

const fsSource = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 fragColor;
void main(){ fragColor = uColor; }`;

// ========== GL helpers ==========
function compile(type, src){
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error("Shader compile error:\n" + gl.getShaderInfoLog(sh));
    }
    return sh;
}
function linkProgram(vs, fs){
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error("Program link error:\n" + gl.getProgramInfoLog(prog));
    }
    return prog;
}

function initProgram(){
    const program = linkProgram(compile(gl.VERTEX_SHADER, vsSource), compile(gl.FRAGMENT_SHADER, fsSource));
    gl.useProgram(program);
    state.program = program;
    state.uniforms = {
        color:     gl.getUniformLocation(program, "uColor"),
        model:     gl.getUniformLocation(program, "uModel"),
        viewProj:  gl.getUniformLocation(program, "uViewProj"),
        pointSize: gl.getUniformLocation(program, "uPointSize"),
    };
}

// ========== Minimal mat4 (column-major; column vectors) ==========
const idx4 = (r,c)=>c*4+r;

function mat4Identity(){
    const m = new Float32Array(16);
    m[0]=1; m[5]=1; m[10]=1; m[15]=1;
    return m;
}
function mat4Mul(B, A){ // out = B * A
    const o = new Float32Array(16);
    for (let r=0;r<4;r++){
        for (let c=0;c<4;c++){
            o[idx4(r,c)] =
                B[idx4(r,0)]*A[idx4(0,c)] +
                B[idx4(r,1)]*A[idx4(1,c)] +
                B[idx4(r,2)]*A[idx4(2,c)] +
                B[idx4(r,3)]*A[idx4(3,c)];
        }
    }
    return o;
}
function mat4Translate(tx,ty,tz){
    const m = mat4Identity();
    m[12]=tx; m[13]=ty; m[14]=tz;
    return m;
}
function mat4Scale(sx,sy,sz){
    const m = mat4Identity();
    m[0]=sx; m[5]=sy; m[10]=sz;
    return m;
}
function mat4RotateZ(a){
    const c=Math.cos(a), s=Math.sin(a);
    const m = mat4Identity();
    m[0]=c; m[4]=-s;
    m[1]=s; m[5]= c;
    return m;
}
function mat4TRS(tx,ty,tz, angZ, sx,sy,sz){
    return mat4Mul(mat4Translate(tx,ty,tz), mat4Mul(mat4RotateZ(angZ), mat4Scale(sx,sy,sz)));
}
// Perspective (right-handed, clip z in [-1,+1])
function mat4Perspective(fovDeg, aspect, near, far){
    const fov = fovDeg * Math.PI/180;
    const f = 1.0 / Math.tan(fov/2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f/aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = (2 * far * near) * nf;
    return m;
}
// Orthographic (right-handed, clip z in [-1,+1])
function mat4Ortho(l, r, b, t, n, f){
    const m = new Float32Array(16);
    m[0]  = 2/(r-l);
    m[5]  = 2/(t-b);
    m[10] = -2/(f-n);
    m[12] = -(r+l)/(r-l);
    m[13] = -(t+b)/(t-b);
    m[14] = -(f+n)/(f-n);
    m[15] = 1;
    return m;
}
// View: camera at (cx,cy,cz), yaw around Z
function mat4View(cx, cy, cz, angZ){
    // Inverse of camera transform: rotate(-angZ) then translate(-pos)
    return mat4Mul(mat4RotateZ(-angZ), mat4Translate(-cx, -cy, -cz));
}

// ========== Geometry (VAO) ==========
function makeVAO(verts){
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, count: verts.length / 2, indexed: false };
}
function makePolygonVAO(segments=64){
    const verts = [];
    for (let i=0;i<segments;i++){
        const t = (i/segments) * Math.PI * 2.0;
        verts.push(Math.cos(t), Math.sin(t));
    }
    return makeVAO(verts);
}

function initGeometry(){
    state.geo.point    = makeVAO([0,0]);
    state.geo.line     = makeVAO([-0.5,0, 0.5,0]);
    state.geo.tri      = makePolygonVAO(3);
    state.geo.square   = makePolygonVAO(4);
    state.geo.circle   = makePolygonVAO(96);
    state.geo.hexagon  = makePolygonVAO(6);
}

// ========== Draw helper ==========
function draw({ vaoObj, mode, color, model = mat4Identity(), pointSize = 1 }){
    const { uniforms } = state;
    gl.uniform4fv(uniforms.color, color);
    gl.uniformMatrix4fv(uniforms.model, false, model);
    gl.uniform1f(uniforms.pointSize, pointSize);

    gl.bindVertexArray(vaoObj.vao);
    if (vaoObj.indexed) {
        gl.drawElements(mode, vaoObj.count, vaoObj.indexType || gl.UNSIGNED_SHORT, 0);
    } else {
        gl.drawArrays(mode, 0, vaoObj.count);
    }
    gl.bindVertexArray(null);
}

// ========== Camera & VP ==========
function computeViewProj(){
    const aspect = canvas.width / canvas.height;
    const s = state;

    let P;
    if (s.mode === "persp") {
        P = mat4Perspective(s.fovDeg, aspect, s.near, s.far);
    } else {
        // Ortho: zoom scales world units; preserve aspect
        const halfH = 1.0 / Math.max(0.001, s.zoom);
        const halfW = halfH * aspect;
        P = mat4Ortho(-halfW, +halfW, -halfH, +halfH, -10, 10);
    }
    const V = mat4View(s.cx, s.cy, s.cz, s.ang);
    return mat4Mul(P, V);
}

function uploadViewProj(){
    const VP = computeViewProj();
    gl.uniformMatrix4fv(state.uniforms.viewProj, false, VP);
}

// ========== Resize (DPR-aware) ==========
function resize(){
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.floor(window.innerWidth  * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
        uploadViewProj();
        markDirty();
    }
    updateUIState();
}

// ========== Scene ==========
function render(){
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    //Sun
    draw({
        vaoObj: state.geo.circle,
        mode: gl.TRIANGLE_FAN,
        color: [1, 0.918, 0.498,1],
        model: mat4TRS(0, 0, 0, 0.0, 0.12, 0.12, 0.12),
    });

    const P1=0.4
    const P2= 0.6
    const P3= 0.7
    const P4 = 0.82
    //Orbit 1
    draw({
        vaoObj: state.geo.circle,
        mode: gl.LINE_LOOP,
        color: [1.0, 1, 1, 0.8],
        model: mat4TRS(0, 0, 0, 0.0, P1,P1,P1),
    });

    //Orbit 2
    draw({
        vaoObj: state.geo.circle,
        mode: gl.LINE_LOOP,
        color: [1.0, 1, 1, 0.8],
        model: mat4TRS(0, 0, 0, 0.0, P2,P2,P2),
    });

    //Orbit 3
    draw({
        vaoObj: state.geo.circle,
        mode: gl.LINE_LOOP,
        color: [1.0, 1, 1, 0.8],
        model: mat4TRS(0, 0, 0, 0.0, P3,P3,P3),
    });

    //Orbit 4
    draw({
        vaoObj: state.geo.circle,
        mode: gl.LINE_LOOP,
        color: [1.0, 1, 1, 0.8],
        model: mat4TRS(0, 0, 0, 0.0, P4,P4,P4),
    });

    //Planet 1
    var [px, py] = within_orbit(P1)
    draw({
        vaoObj: state.geo.circle,
        mode: gl.TRIANGLE_FAN,
        color: [0.655, 0.655, 0.65,1 ],
        model: mat4TRS(px, py, 0.4, 0.0, 0.06, 0.06, 1),
    });

    //Planet 2
    var [px, py] = within_orbit(P2)
    draw({
        vaoObj: state.geo.circle,
        mode: gl.TRIANGLE_FAN,
        color: [0.114, 0.729, 0.408,1],
        model: mat4TRS(px, py, 0.6, 0.5, 0.07, 0.07, 1),
    });
    //Planet 3
    var [px, py] = within_orbit(P3)
    draw({
        vaoObj: state.geo.circle,
        mode: gl.TRIANGLE_FAN,
        color: [0.188, 0.427, 0.941,1],
        model: mat4TRS(px, py, 0.8, 0.0, 0.09, 0.09, 1),
    });

    //Planet 4
    var [px, py] = within_orbit(P4)
    draw({
        vaoObj: state.geo.circle,
        mode: gl.TRIANGLE_FAN,
        color: [0.886, 0.341, 0.169,1],
        model: mat4TRS(px, py, 0.9, 0.0, 0.15, 0.15, ),
    });

    for (let i = 0; i < 500; i++) {
        var [px, py] = random_points(-4,4)
        draw({
        vaoObj: state.geo.point,
        mode: gl.POINTS,
        color: [1.0, 1, 1, 1.0],
        model: mat4TRS(px, py, -0.5, 0.0, 1.0, 1.0, 1.0),
        pointSize: 1,
        });
    }
    
}

function within_orbit(orbit_size) {
  const angle = Math.random() * 2 * Math.PI;
  const x = orbit_size * Math.cos(angle);
  const y = orbit_size * Math.sin(angle);
  return [x, y];
}


function random_points(min, max) {
  const x = Math.random() * (max - min) + min;
  const y = Math.random() * (max - min) + min; 
  return [x, y];           
}


// ========================= UI Wiring =========================
const $ = (id) => document.getElementById(id);

const cxRange = $("cxRange"), cxNum = $("cx");
const cyRange = $("cyRange"), cyNum = $("cy");
const zoomRange = $("zoomRange"), zoomNum = $("zoom");   // Ortho-only
const angRange = $("angRange"), angNum = $("angle");
const fovRange = $("fovRange"), fovNum = $("fov");       // Persp-only
const camzRange = $("camzRange"), camzNum = $("camz");   // Persp-only
const resetBtn = $("reset");
const modeOrtho = $("modeOrtho"), modePersp = $("modePersp");

function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }

function bindControl(rangeEl, numEl, apply){
    const push = (v) => {
        // Avoid NaN and clamp inside apply if needed
        rangeEl.value = String(v);
        numEl.value = String(v);
        apply(+v);
        uploadViewProj();
        markDirty();
    };
    rangeEl.addEventListener("input", e => push(e.target.value));
    numEl.addEventListener("input", e => push(e.target.value));
    // initialize once
    push(numEl.value);
}

function updateUIState(){
    const isPersp = state.mode === "persp";
    zoomRange.disabled = zoomNum.disabled = isPersp;
    fovRange.disabled  = fovNum.disabled  = !isPersp;
    camzRange.disabled = camzNum.disabled = !isPersp;
}

// Bindings
bindControl(cxRange, cxNum, v => { state.cx = v; });
bindControl(cyRange, cyNum, v => { state.cy = v; });
bindControl(angRange, angNum, v => { state.ang = (v * Math.PI) / 180; });

// Ortho zoom
bindControl(zoomRange, zoomNum, v => { state.zoom = Math.max(0.001, v); });

// Perspective
bindControl(fovRange, fovNum, v => { state.fovDeg = clamp(v, 1, 179); });
bindControl(camzRange, camzNum, v => { state.cz = Math.max(0.05, v); });

// Mode toggles
modeOrtho.addEventListener("change", () => {
    if (modeOrtho.checked) {
        state.mode = "ortho";
        updateUIState();
        uploadViewProj();
        markDirty();
    }
});
modePersp.addEventListener("change", () => {
    if (modePersp.checked) {
        state.mode = "persp";
        updateUIState();
        uploadViewProj();
        markDirty();
    }
});

// Buttons
resetBtn.addEventListener("click", () => {
    state.cx = 0; state.cy = 0; state.ang = 0;
    state.mode = modeOrtho.checked ? "ortho" : "persp";
    state.zoom = 1.0;
    state.fovDeg = 60; state.cz = 3.0;

    cxRange.value = cxNum.value = "0";
    cyRange.value = cyNum.value = "0";
    angRange.value = angNum.value = "0";
    zoomRange.value = zoomNum.value = String(state.zoom);
    fovRange.value = fovNum.value = String(state.fovDeg);
    camzRange.value = camzNum.value = String(state.cz);

    updateUIState();
    uploadViewProj();
    markDirty();
});

// ========== GL init & startup ==========
function initGL(){
    initProgram();
    initGeometry();

    gl.useProgram(state.program);
    gl.clearColor(0.05, 0.07, 0.10, 1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.clearDepth(1.0);

    uploadViewProj();
    markDirty();
}

function uploadViewProj(){
    if (!state.uniforms) return;   // <-- guard
    const VP = computeViewProj();
    gl.uniformMatrix4fv(state.uniforms.viewProj, false, VP);
}


// React to window resizes and DPR changes
window.addEventListener("resize", resize);
const mq = matchMedia(`(resolution: ${window.devicePixelRatio||1}dppx)`);
if (mq && mq.addEventListener) {
    // Recompute on DPR changes (zoom/monitor move)
    mq.addEventListener("change", resize);
}
// Kick off
initGL();
resize();
