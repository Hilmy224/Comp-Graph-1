# Lab 1

Name: Muhammad Hilmy Abdul Aziz

NPM: 22065828701

Reading Sources and refernce:
+ https://registry.khronos.org/OpenGL-Refpages/gl4/html/glDrawElements.xhtml
+ https://www.geeksforgeeks.org/javascript/how-to-use-shaders-to-apply-color-in-webgl
+ https://www.youtube.com/watch?v=y2UsQB3WSvo&t
+ https://www.youtube.com/watch?v=lLa6XkVLj0w&t

## Screen Shots
#### 1. Target Scene Orthographic


![alt text](<Target Scene (Orthographic).png>)
#### 2. Target Scene Orthographic

![alt text](<Target Scene (Perspective).png>)

## Gradient Shader 
For gradient shading I mostly referenced (Indigos coloring)[https://www.youtube.com/watch?v=lLa6XkVLj0w&t].Where, instead of keeping vertex positions and colors in separate arrays (like in the tutorial) and applying uniform colors, I modified the vertex shader so that each vertex carries both its position (x, y) and color (r, g, b).See Below:
```c
const vsSource = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec3 aColor;

uniform mat4 uModel;
uniform mat4 uViewProj;
uniform float uPointSize;


out vec3 fragmentColor;

void main() {
  fragmentColor = aColor;
  vec4 world = uModel * vec4(aPosition, 0.0, 1.0);
  gl_Position = uViewProj * world;
  gl_PointSize = uPointSize;
}`;
```

This allows me to take advantage of the GPU’s rasterization pipeline, which automatically interpolates can automatically color between vertices based on distance. The result is a linear gradient across the polygon.
Below is where fragmentColor is interpolated automatically by the rasterizer from the vertex colors provided in the VAO.
```c
const fsSource = `#version 300 es
precision mediump float;

in vec3 fragmentColor;
out vec4 outputColor;

void main() {
  outputColor = vec4(fragmentColor, 1.0);
}`;

```

Then in makePolygonVAO, the center vertex is assigned one color, while all edge vertices share another color. The interpolation between these creates the gradient effect.

Changing the multiplePolyGon Function:
```js
function makeVAO(verts, strides=5){
    //Same as tutorial

    //adding the new color mappings
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, strides*4, 2*4); //pass the 2 value first offest
    gl.bindVertexArray(null);
    return { vao, count: verts.length / strides, indexed: false };
}
```
```js
//HERE
function makePolygonVAO(segments=64,center_vert_color = [1,1,1],edge_vert_color=[0.2, 0.3, 0.6]){
    const verts = [];
    for (let i=0;i<segments;i++){
        const t = (i/segments) * Math.PI * 2.0; //Angle
        const t1 = ((i+1)/segments) * Math.PI * 2.0;
        const x1 = Math.cos(t);
        const y1 = Math.sin(t);
        const x2 = Math.cos(t1);
        const y2 = Math.sin(t1);

        // Center vertex that starts at 0 0
        verts.push(
        // Position (x, y)
        0, 0,
        // Color (r, g, b)
        ...center_vert_color
        );
        // The other two vertices of the triangle
        verts.push(
        x1, y1,
        ...edge_vert_color
        );
        verts.push(
        x2, y2,
        ...edge_vert_color
        );
    }
    return makeVAO(verts);
}
```



## uViewProject
In the vertex shader we apply:

```glsl
//MVP in vertex shader: gl_Position = uViewProj * (uModel * vec4(pos,0,1))
vec4 world = uModel * vec4(aPosition, 0.0, 1.0); //Model in MVP
gl_Position = uViewProj * world; //Covers both View and Projection in UviewProj
```

That means uModel puts an object in the right spot in world space, V  thens moves the scene relative to the camera and P projects it into clip space so that it can appear in the canvas.

In the `computeViewProj`function we can tell it first counts the aspect ratio of the canvas then makes a projection matrix (P) depending on the mode:
in perspective mode, mat4Perspective is used so that objects shrink with distance, while in orthographic mode, mat4Ortho is applied, with zoom determining how much of the scene is visible regardless of depth. 
Next, a view matrix (V) is built with mat4View, which repositions the world relative to the camera based on its coordinates (cx, cy, cz) and rotation angle (ang). Lastly, the projection and view matrices are multiplied together, producing the combined uViewProj matrix that is sent to the shader for transforming vertices into clip space.

### Reason why variation in uZ can cause planets and orbital rings to misalign.

In Perspective Target Scene we canse that the planets and orbital rings are missaligned this might be due to `s.cz` is being passed straight into `mat4View` as that is our camera’s z-position. Since the planet positions (uModel transforms) are computed independently of the camera, the camera shift messes up a bit of the geometry.






  


