import type { Mesh } from './stl';

/**
 * A minimal WebGL turntable viewer.
 *
 * This is hand-rolled rather than three.js on purpose: the napplet ships as a single-file
 * artifact that the shell fetches and injects as `srcdoc`, so every kilobyte is inlined
 * into every preview open. Showing one flat-shaded mesh on a turntable needs a shader,
 * a bounding box, and pointer math — not a scene graph — and this is a few KB against
 * a few hundred.
 */

export type Viewer = {
  setMesh(mesh: Mesh): void;
  /** Re-frames the camera on the mesh. */
  resetView(): void;
  dispose(): void;
};

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uProjection;
uniform mat4 uModelView;
varying vec3 vNormal;
void main() {
  // Rotation-only model-view with uniform scale, so the 3x3 block transforms normals
  // correctly without a separate inverse-transpose.
  vNormal = normalize(mat3(uModelView) * aNormal);
  gl_Position = uProjection * uModelView * vec4(aPosition, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vNormal;
uniform vec3 uColor;
void main() {
  vec3 normal = normalize(vNormal);
  // Two-sided: STL winding is unreliable, and a flipped facet should not read as a hole.
  if (!gl_FrontFacing) normal = -normal;

  vec3 keyDirection = normalize(vec3(0.4, 0.7, 1.0));
  float key = max(dot(normal, keyDirection), 0.0);
  // Hemispheric fill keeps cavities readable instead of crushing them to black.
  float fill = 0.5 + 0.5 * normal.y;

  vec3 lit = uColor * (0.25 + 0.55 * key + 0.30 * fill);
  gl_FragColor = vec4(lit, 1.0);
}
`;

type Matrix = Float32Array;

function perspective(fovY: number, aspect: number, near: number, far: number): Matrix {
  const f = 1 / Math.tan(fovY / 2);
  const range = 1 / (near - far);

  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (near + far) * range,
    -1,
    0,
    0,
    2 * near * far * range,
    0,
  ]);
}

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Float32Array(16);

  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + column] * b[row * 4 + k];
      out[row * 4 + column] = sum;
    }
  }

  return out;
}

function translation(x: number, y: number, z: number): Matrix {
  // prettier-ignore
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function rotationX(angle: number): Matrix {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // prettier-ignore
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function rotationY(angle: number): Matrix {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // prettier-ignore
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create a WebGL shader.');

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader failed to compile: ${log ?? 'unknown error'}`);
  }

  return shader;
}

/**
 * Creates a viewer on this canvas, or returns null when WebGL is unavailable — a real
 * outcome in hardened browsers and headless environments, and one the caller must be able
 * to fall back from rather than treat as a crash.
 */
export function createViewer(canvas: HTMLCanvasElement): Viewer | null {
  const context =
    (canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
    }) as WebGLRenderingContext | null) ??
    (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
  if (!context) return null;

  // Rebound as a non-null const: the closures below all capture it, and a nullable binding
  // cannot stay narrowed across them.
  const gl = context;

  function link(): WebGLProgram | null {
    try {
      const created = gl.createProgram();
      if (!created) return null;

      gl.attachShader(created, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
      gl.attachShader(created, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
      gl.linkProgram(created);
      if (!gl.getProgramParameter(created, gl.LINK_STATUS)) return null;

      return created;
    } catch {
      return null;
    }
  }

  const program = link();
  if (!program) return null;

  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  // Transparent clear, so the dialog's own background shows through and the viewer
  // follows the shell's light/dark theme without being told what it is.
  gl.clearColor(0, 0, 0, 0);

  const positionLocation = gl.getAttribLocation(program, 'aPosition');
  const normalLocation = gl.getAttribLocation(program, 'aNormal');
  const projectionLocation = gl.getUniformLocation(program, 'uProjection');
  const modelViewLocation = gl.getUniformLocation(program, 'uModelView');
  const colorLocation = gl.getUniformLocation(program, 'uColor');

  const positionBuffer = gl.createBuffer();
  const normalBuffer = gl.createBuffer();

  let vertexCount = 0;
  let center: [number, number, number] = [0, 0, 0];
  let radius = 1;
  let yaw = Math.PI * 0.25;
  let pitch = -Math.PI * 0.15;
  let distance = 4;
  let frame = 0;
  let contextLost = false;

  function draw() {
    frame = 0;
    if (contextLost || vertexCount === 0) return;

    // Match the drawing buffer to the CSS box each frame: the dialog is resizable by the
    // viewport, and a stale buffer shows up as a blurry or letterboxed model.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = canvas.width / canvas.height || 1;
    const near = Math.max(radius * 0.01, 0.01);
    const far = distance + radius * 4;

    const modelView = multiply(
      multiply(multiply(translation(0, 0, -distance), rotationX(pitch)), rotationY(yaw)),
      translation(-center[0], -center[1], -center[2]),
    );

    gl.uniformMatrix4fv(projectionLocation, false, perspective(Math.PI / 4, aspect, near, far));
    gl.uniformMatrix4fv(modelViewLocation, false, modelView);
    gl.uniform3f(colorLocation, 0.55, 0.62, 0.78);

    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  function schedule() {
    if (frame || contextLost) return;
    frame = requestAnimationFrame(draw);
  }

  // --- interaction -------------------------------------------------------------------

  let dragPointer: number | null = null;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(event: PointerEvent) {
    if (dragPointer !== null) return;
    dragPointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (dragPointer !== event.pointerId) return;

    yaw += (event.clientX - lastX) * 0.01;
    // Clamped just short of the poles, where the turntable would gimbal over.
    pitch = Math.max(
      -Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, pitch + (event.clientY - lastY) * 0.01),
    );
    lastX = event.clientX;
    lastY = event.clientY;
    schedule();
  }

  function endDrag(event: PointerEvent) {
    if (dragPointer !== event.pointerId) return;
    dragPointer = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    const next = distance * (event.deltaY > 0 ? 1.12 : 1 / 1.12);
    distance = Math.max(radius * 1.2, Math.min(radius * 20, next));
    schedule();
  }

  function onContextLost(event: Event) {
    // Without preventDefault the context is never restorable; the canvas would stay blank
    // for the rest of the napplet's life.
    event.preventDefault();
    contextLost = true;
  }

  function onResize() {
    schedule();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('webglcontextlost', onContextLost);

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  observer?.observe(canvas);
  window.addEventListener('resize', onResize);

  function frameCamera() {
    yaw = Math.PI * 0.25;
    pitch = -Math.PI * 0.15;
    // Far enough back that the bounding sphere fits the 45° vertical field, with headroom.
    distance = radius * 3.2;
    schedule();
  }

  return {
    setMesh(mesh) {
      center = [
        (mesh.min[0] + mesh.max[0]) / 2,
        (mesh.min[1] + mesh.max[1]) / 2,
        (mesh.min[2] + mesh.max[2]) / 2,
      ];
      radius =
        Math.max(
          Math.hypot(
            mesh.max[0] - mesh.min[0],
            mesh.max[1] - mesh.min[1],
            mesh.max[2] - mesh.min[2],
          ) / 2,
          1e-6,
        ) || 1;

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(normalLocation);
      gl.vertexAttribPointer(normalLocation, 3, gl.FLOAT, false, 0, 0);

      vertexCount = mesh.triangleCount * 3;
      frameCamera();
    },

    resetView: frameCamera,

    dispose() {
      if (frame) cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(normalBuffer);
      gl.deleteProgram(program);
    },
  };
}
