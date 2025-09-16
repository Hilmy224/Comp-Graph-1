# WebGL2 Lab 1

This guide walks through the **exact code** used in `index.html` + `main.js`, with explanations of the most important parts: **shaders**, **buffer/VAO setup**, **MVP math**, **resizing**, and **UI binding**.

---

## 0) Mental model on how the code works

1. We draw 2D vertices (x, y) on the CPU.
2. The **vertex shader** turns them into 4D clip-space positions using **M** (model), **V** (view/camera), and **P** (projection) matrices.
3. The **fragment shader** fills pixels with a color.
4. We repeat for each object, with a different **model matrix** and color.
5. A tiny “render once after change” scheduler keeps things fast for non-animated scenes.

**Key equation** (runs in the vertex shader):

```
gl_Position = P * V * (M * vec4(x, y, 0, 1));
```

---

## 1) Shaders

The code builds shader source strings in JavaScript and compiles them at runtime.

### 1.1 Vertex Shader (`vsSource`)

```glsl
#version 300 es                                     // (1)
precision highp float;                              // (2)
layout(location = 0) in vec2 aPosition;             // (3)
uniform mat4 uModel;                                // (4)
uniform mat4 uViewProj;                             // (5)
uniform float uPointSize;                           // (6)
void main(){                                        // (7)
  vec4 world = uModel * vec4(aPosition, 0.0, 1.0);  // (8)
  gl_Position = uViewProj * world;                  // (9)
  gl_PointSize = uPointSize;                        // (10)
}                                                   // (11)
```

**Explanation**

1. `#version 300 es` → Use **WebGL2/GLSL ES 3.00** features (e.g., `layout(location=...)`, `in`/`out`).
2. `precision highp float;` → Default float precision for this shader. Vertex shaders often use `highp` for accurate matrix math.
3. `layout(location = 0) in vec2 aPosition;` → Vertex attribute **slot 0** will supply a 2D position per vertex. We bind the buffer to this slot later.
4. `uniform mat4 uModel;` → Per-object **M matrix** (scale→rotate→translate).
5. `uniform mat4 uViewProj;` → Combined **view** (camera) × **projection** matrix. Upload once per frame unless the camera changes.
6. `uniform float uPointSize;` → Size used when drawing `gl.POINTS`.
7. `void main(){` → Entry point for each vertex.
8. `world = uModel * vec4(aPosition, 0, 1);` → Lift 2D to 4D and apply **M** to move from object space → world space.
9. `gl_Position = uViewProj * world;` → Apply **V** then **P** (combined) to get **clip-space** coordinates.
10. `gl_PointSize = uPointSize;` → Controls rasterized point size for `gl.POINTS`. Ignored for geometry objects.
11. End of shader.

> **Clip space → NDC → pixels**: After the vertex shader, the GPU divides by `w` to get **NDC** in `[-1..+1]`. Then the viewport maps NDC to pixel coordinates.

### 1.2 Fragment Shader (`fsSource`)

```glsl
#version 300 es              // (1)
precision mediump float;     // (2)
uniform vec4 uColor;         // (3)
out vec4 fragColor;          // (4)
void main(){                 // (5)
  fragColor = uColor;        // (6)
}                            // (7)
```

**Explanation**

1. WebGL2 GLSL again.
2. `mediump` is fine for color work.
3. `uColor` arrives per draw call (RGBA).
4. `fragColor` is the shader’s output color for the pixel.
5. Entry point.
6. Output solid color; replace with lighting/texture later.
7. End.

---

## 2) Compiling & Linking

### 2.1 `compile(type, src)`

```js
const sh = gl.createShader(type);                       // (1)
gl.shaderSource(sh, src);                               // (2)
gl.compileShader(sh);                                   // (3)
if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){     // (4)
  const log = gl.getShaderInfoLog(sh);                  // (5)
  gl.deleteShader(sh);                                  // (6)
  throw new Error("Shader compile error:\n" + log);     // (7)
}
return sh;                                              // (8)
```

1. Allocate a shader object (`VERTEX_SHADER` or `FRAGMENT_SHADER`).
2. Attach GLSL source.
3. Ask the driver to compile.
4. Check result.
5. Fetch error log if any.
6. Avoid leaks on failure.
7. Throw a helpful error (surfaces in the console).
8. Return compiled shader handle.

### 2.2 `linkProgram(vs, fs)`

```js
const prog = gl.createProgram();                        // (1)
gl.attachShader(prog, vs);                              // (2)
gl.attachShader(prog, fs);                              // (3)
gl.linkProgram(prog);                                   // (4)
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)){     // (5)
  const log = gl.getProgramInfoLog(prog);               // (6)
  gl.deleteProgram(prog);                               // (7)
  throw new Error("Program link error:\n" + log);       // (8)
}
return prog;                                            // (9)
```

1. New program container.
   2–3. Attach compiled shaders.
2. Link into a GPU-executable pipeline.
   5–8. Error handling.
3. Return the **program** to use with `gl.useProgram(...)`.

### 2.3 `initProgram()` (high level)

```js
const program = linkProgram(compile(gl.VERTEX_SHADER, vsSource),
                            compile(gl.FRAGMENT_SHADER, fsSource));     // (1)
gl.useProgram(program);                                                 // (2)
state.program = program;                                                // (3)
state.uniforms = {                                                      // (4)
  color:     gl.getUniformLocation(program, "uColor"),
  model:     gl.getUniformLocation(program, "uModel"),
  viewProj:  gl.getUniformLocation(program, "uViewProj"),
  pointSize: gl.getUniformLocation(program, "uPointSize"),
};
```

1. Build & link shaders.
2. Make the program active on the context.
3. Cache for later.
4. Resolve and cache **uniform locations** once (faster & less error-prone than calling `getUniformLocation` before every draw).

---

## 3) Matrices & Camera

### 3.1 Column-major note

OpenGL/GLSL uses **column-major** matrices with **column vectors**. The helper `idx4(row, col) => col*4 + row` computes the 1D index in a 4×4 matrix.

### 3.2 Multiplication order

`mat4Mul(B, A)` returns **B·A** — i.e., apply `A` first, then `B`. This matches the vertex multiply order in the shader.

### 3.3 Model TRS

```js
function mat4TRS(tx,ty,tz, angZ, sx,sy,sz){
  // T * (R * S): scale → rotate → translate
  return mat4Mul(mat4Translate(tx,ty,tz), mat4Mul(mat4RotateZ(angZ), mat4Scale(sx,sy,sz)));
}
```

* **Why this order?** With column vectors, the rightmost matrix acts first on the vector. So `S` scales local geometry, `R` rotates the scaled geometry, `T` moves it to world position.

### 3.4 View matrix

```js
function mat4View(cx, cy, cz, angZ){
  // Inverse of camera transform
  return mat4Mul(mat4RotateZ(-angZ), mat4Translate(-cx, -cy, -cz));
}
```

* If the camera is at `(cx, cy, cz)` and rotated by `angZ`, the **view** transforms the entire world by the **inverse** so the camera appears fixed at the origin facing -Z (default OpenGL camera).

### 3.5 Projection matrices

* **Perspective**: builds a frustum based on vertical FOV, aspect, near/far. Produces perspective divide (parallax, size change).
* **Orthographic**: builds a cuboid box; no size change with depth. We choose `left/right/top/bottom` from **zoom** and **aspect**.

---

## 4) Geometry & VAOs

### 4.1 `makeVAO(verts)`

```js
const vao = gl.createVertexArray();                                         // (1)
gl.bindVertexArray(vao);                                                    // (2)

const vbo = gl.createBuffer();                                              // (3)
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);                                        // (4)
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);    // (5)

gl.enableVertexAttribArray(0);                                              // (6)
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);                        // (7)

gl.bindVertexArray(null);                                                   // (8)
return { vao, count: verts.length/2, indexed: false };                      // (9)
```

**Explanation**

1. Allocate a **VAO** (Vertex Array Object). A VAO remembers “how to read vertex attributes.”
2. Bind it so subsequent attribute/buffer calls are **captured** into this VAO.
3. Allocate a **VBO** (Vertex Buffer Object) to store raw vertex data.
4. Make it the current `ARRAY_BUFFER`.
5. Upload vertex data into GPU memory (`Float32Array`). `STATIC_DRAW` = data won’t change often.
6. Enable **attribute slot 0** (must match `layout(location=0)` in the vertex shader).
7. Describe the attribute format:

  * slot **0**
  * **2** components per vertex (x, y) --> `aPosition`
  * type **FLOAT**
  * `normalized=false` (not converting integers)
  * `stride=0` (tightly packed; GL infers `2 * sizeof(float)`),
  * `offset=0` (starts at beginning).
8. Unbind the VAO (optional, but avoids accidental edits later).
9. Return a small object containing the VAO and **vertex count** (verts are pairs). We mark `indexed:false` because we didn’t create an index buffer here.

> **What is a VAO?** Think of it as a little “recipe card” that says: “when drawing, read attribute slot 0 from THIS buffer, 2 floats per vertex, tightly packed.”

### 4.2 `makePolygonVAO(segments=64)`

```js
const verts = [];                           // (1)
for (let i=0;i<segments;i++){               // (2)
  const t = (i/segments) * Math.PI*2;       // (3)
  verts.push(Math.cos(t), Math.sin(t));     // (4)
}
return makeVAO(verts);                      // (5)
```

1. Start empty list of xy pairs.
2. For each vertex around a circle…
3. Angle from 0..2π.
4. Unit circle coordinates (cos, sin).
5. Build a VAO for those vertices. Draw with `LINE_LOOP` (outline) or `TRIANGLE_FAN` (filled).

> This is an example of custom geometry object builder based on how a circle is built

---

## 5) Drawing an Object

### 5.1 `draw({ vaoObj, mode, color, model, pointSize })`

```js
gl.uniform4fv(state.uniforms.color, color);                                         // (1)
gl.uniformMatrix4fv(state.uniforms.model, false, model);                            // (2)
gl.uniform1f(state.uniforms.pointSize, pointSize);                                  // (3)

gl.bindVertexArray(vaoObj.vao);                                                     // (4)
if (vaoObj.indexed){                                                                // (5)
  gl.drawElements(mode, vaoObj.count, vaoObj.indexType || gl.UNSIGNED_SHORT, 0);    // (6)
} else {
  gl.drawArrays(mode, 0, vaoObj.count);                                             // (7)
}
gl.bindVertexArray(null);                                                           // (8)
```

1. Set per-object RGBA color.
2. Upload **model matrix** for this object.
3. Set point size (used only for points).
4. Bind the **VAO** describing vertex layout.
5. If geometry uses an **index buffer**…
6. …draw by indices (we didn’t in this template).
7. Else draw **`vaoObj.count`** vertices starting at 0.
8. Unbind VAO (optional).

> **Modes** you’ll see:
>
> * `gl.POINTS` — each vertex is a point.
> * `gl.LINES` — pairs of vertices form independent line segments.
> * `gl.LINE_STRIP` — connects all vertices without a direct connection between first and last vertex.
> * `gl.LINE_LOOP` — connects all vertices with a final closing segment.
> * `gl.TRIANGLES` — groups of 3 vertices form independent triangles.
> * `gl.TRIANGLE_STRIP` — for each additional vertices, draw a triangle using the last 3 vertices.  
> * `gl.TRIANGLE_FAN` — first vertex is a hub; each new vertex makes a triangle with previous vertex and hub (great for convex fills).

---

## 6) Camera & Projection

### 6.1 `computeViewProj()`

```js
const aspect = canvas.width / canvas.height;                            // (1)
let P;                                                                  // (2)
if (state.mode === "persp"){                                            // (3)
  P = mat4Perspective(state.fovDeg, aspect, state.near, state.far);
} else {
  const halfH = 1.0 / Math.max(0.001, state.zoom);                      // (4)
  const halfW = halfH * aspect;                                         // (5)
  P = mat4Ortho(-halfW, +halfW, -halfH, +halfH, -10, 10);               // (6)
}
const V = mat4View(state.cx, state.cy, state.cz, state.ang);            // (7)
return mat4Mul(P, V);                                                   // (8)
```

1. Aspect ratio from **backing store** size (pixel-accurate).
2. Declare projection matrix.
3. **Perspective** mode: use vertical FOV, aspect, near/far.
4. **Orthographic** vertical half-extent shrinks as `zoom` grows (zoom in). Clamp to avoid divide-by-zero.
5. Horizontal half-extent preserves aspect (prevents stretching).
6. Build ortho box; we picked a generous z-range for the 2D scene.
7. Build **view** (inverse camera) from state.
8. Return **VP** = P · V.

### 6.2 `uploadViewProj()`

```js
if (!state.uniforms) return;                                // (1)
const VP = computeViewProj();                               // (2)
gl.uniformMatrix4fv(state.uniforms.viewProj, false, VP);    // (3)
```

1. Guard in case a resize happened **before** `initGL` finished.
2. Compute combined matrix.
3. Upload to the shader once per change.

---

## 7) Resizing & Viewport

### 7.1 `resize()`

```js
const dpr = Math.max(1, window.devicePixelRatio || 1); // (1)
const w = Math.floor(window.innerWidth  * dpr);        // (2)
const h = Math.floor(window.innerHeight * dpr);        // (3)
if (canvas.width !== w || canvas.height !== h){        // (4)
  canvas.width = w; canvas.height = h;                 // (5)
  gl.viewport(0, 0, w, h);                             // (6)
  uploadViewProj();                                    // (7)
  markDirty();                                         // (8)
}
updateUIState();                                       // (9)
```

1. Detect **device pixel ratio** (Hi-DPI).
   2–3. Compute backing store size in **pixels**, not CSS units.
2. Change only when necessary (reduces thrash).
3. Resize the canvas **backing store** to match the window at current DPR.
4. Tell GL the new viewport → maps NDC to pixels.
5. Aspect changed → recompute/upload VP.
6. Schedule a one-shot redraw.
7. Also refresh UI state (enable/disable controls).

> **Why do this?** To avoid blurry rendering on Hi-DPI displays and ensure aspect is always correct.

---

## 8) Scene Rendering

We clear color & depth, then draw several objects at different **Z**:

* **Yellow square (front, z=+0.4, filled)** — shows how an object in front occludes others.
* **Teal square (z=−0.3, filled)** — sits behind.
* **Cyan mini square (z=+0.5)** — slightly in front of the yellow.
* **Red point** — demonstrates `gl.POINTS` and `uPointSize`.
* **Blue line** — example of `gl.LINES`.
* **Green triangle** — `TRIANGLES`.
* **Gold circle outline** — `LINE_LOOP` of a 96-gon (looks like a circle).
* **Light blue hexagon** — `TRIANGLE_FAN` convex fill.

This arrangement makes it easy to **switch between Ortho and Perspective** to see parallax and size effects.

---

## 9) UI Binding

### 9.1 `bindControl(rangeEl, numEl, apply)`

```js
const push = (v) => {                                           // (1)
  rangeEl.value = String(v);                                    // (2)
  numEl.value   = String(v);                                    // (3)
  apply(+v);                                                    // (4)
  uploadViewProj();                                             // (5)
  markDirty();                                                  // (6)
};
rangeEl.addEventListener("input", e => push(e.target.value));   // (7)
numEl .addEventListener("input", e => push(e.target.value));    // (8)
push(numEl.value);                                              // (9)
```

1. A closure that updates both widgets and the state.
   2–3. Mirror the value to slider and numeric input (keeps them in sync).
2. `apply` mutates the **state** (e.g., sets `state.cx`). `+v` casts string → number.
3. Camera changed → upload new VP.
4. Schedule a redraw.
   7–8. Handle input from either widget.
5. **Initialize** the pair once with the current number input value.

### 9.2 `updateUIState()`

Disables **Zoom** in perspective mode, and disables **FOV/CamZ** in ortho mode (only relevant controls are active).

---

## 10) Initialization & Lifecyle

* **`initGL()`**: builds program, geometry, enables depth testing, clears background, and pushes the initial VP to the shader.
* **Event hooks**:

  * `window.resize` → runs `resize()`.
  * `matchMedia('(resolution: dppx)')` → fires when **DPR** changes (e.g., moving the window between monitors).
  * WebGL **context lost/restored** → rebuild GL resources and redraw.

---

Happy rendering!
