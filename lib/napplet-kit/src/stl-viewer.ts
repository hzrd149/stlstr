import type { Mesh } from './stl';

/**
 * A minimal WebGL turntable viewer.
 *
 * This is hand-rolled rather than three.js on purpose: napplets ship as single-file
 * artifacts, so every kilobyte is inlined into each load. Showing one flat-shaded mesh on a
 * turntable needs a shader, a bounding box, and pointer math, not a scene graph.
 */

export type Viewer = {
  setMesh(mesh: Mesh): void;
  /** Re-frames the camera on the mesh. */
  resetView(): void;
  /** Encodes the current view of the canvas. Requires `preserveDrawingBuffer`. */
  captureImage(options?: CaptureImageOptions): Promise<Blob>;
  dispose(): void;
};

export type ViewerOptions = {
  preserveDrawingBuffer?: boolean;
};

export type CaptureImageOptions = {
  mimeType?: 'image/png' | 'image/webp';
  quality?: number;
};

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uProjection;
uniform mat4 uModelView;
varying vec3 vNormal;
void main() {
  vNormal = normalize(mat3(uModelView) * aNormal);
  gl_Position = uProjection * uModelView * vec4(aPosition, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vNormal;
uniform vec3 uColor;
uniform vec3 uAmbientColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uDirectionalColor;
uniform vec3 uLightDirection;
void main() {
  vec3 normal = normalize(vNormal);
  if (!gl_FrontFacing) normal = -normal;
  float hemiMix = normal.y * 0.5 + 0.5;
  vec3 hemi = mix(uGroundColor, uSkyColor, hemiMix);
  float direct = max(dot(normal, normalize(uLightDirection)), 0.0);
  vec3 lit = uColor * (uAmbientColor + hemi * 0.65 + uDirectionalColor * direct * 0.75);
  gl_FragColor = vec4(lit, 1.0);
}
`;

const BACKGROUND: [number, number, number] = [0.627, 0.627, 0.627];
const MODEL_BLUE: [number, number, number] = [0.102, 0.373, 0.706];
const AMBIENT: [number, number, number] = [0.5, 0.5, 0.5];
const SKY: [number, number, number] = [1, 1, 1];
const GROUND: [number, number, number] = [0.267, 0.267, 0.267];
const DIRECTIONAL: [number, number, number] = [1, 1, 1];
const LIGHT_DIRECTION: [number, number, number] = [-5, 15, 10];
const DEFAULT_YAW = -Math.PI * 0.22;
const DEFAULT_PITCH = -Math.PI * 0.22;

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
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function rotationX(angle: number): Matrix {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function rotationY(angle: number): Matrix {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
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

export function createViewer(
  canvas: HTMLCanvasElement,
  options: ViewerOptions = {},
): Viewer | null {
  const context =
    (canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    }) as WebGLRenderingContext | null) ??
    (canvas.getContext('experimental-webgl', {
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    }) as WebGLRenderingContext | null);
  if (!context) return null;

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
  gl.clearColor(...BACKGROUND, 1);

  const positionLocation = gl.getAttribLocation(program, 'aPosition');
  const normalLocation = gl.getAttribLocation(program, 'aNormal');
  const projectionLocation = gl.getUniformLocation(program, 'uProjection');
  const modelViewLocation = gl.getUniformLocation(program, 'uModelView');
  const colorLocation = gl.getUniformLocation(program, 'uColor');
  const ambientLocation = gl.getUniformLocation(program, 'uAmbientColor');
  const skyLocation = gl.getUniformLocation(program, 'uSkyColor');
  const groundLocation = gl.getUniformLocation(program, 'uGroundColor');
  const directionalLocation = gl.getUniformLocation(program, 'uDirectionalColor');
  const lightDirectionLocation = gl.getUniformLocation(program, 'uLightDirection');

  const positionBuffer = gl.createBuffer();
  const normalBuffer = gl.createBuffer();

  let vertexCount = 0;
  let center: [number, number, number] = [0, 0, 0];
  let radius = 1;
  let yaw = DEFAULT_YAW;
  let pitch = DEFAULT_PITCH;
  let distance = 4;
  let frame = 0;
  let contextLost = false;

  function draw() {
    frame = 0;
    if (contextLost || vertexCount === 0) return;

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
      multiply(
        multiply(multiply(translation(0, 0, -distance), rotationX(pitch)), rotationY(yaw)),
        rotationX(-Math.PI / 2),
      ),
      translation(-center[0], -center[1], -center[2]),
    );

    gl.uniformMatrix4fv(projectionLocation, false, perspective(Math.PI / 4, aspect, near, far));
    gl.uniformMatrix4fv(modelViewLocation, false, modelView);
    gl.uniform3f(colorLocation, ...MODEL_BLUE);
    gl.uniform3f(ambientLocation, ...AMBIENT);
    gl.uniform3f(skyLocation, ...SKY);
    gl.uniform3f(groundLocation, ...GROUND);
    gl.uniform3f(directionalLocation, ...DIRECTIONAL);
    gl.uniform3f(lightDirectionLocation, ...LIGHT_DIRECTION);

    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  function canvasToBlob(mimeType: string, quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('The STL preview image could not be encoded.'));
        },
        mimeType,
        quality,
      );
    });
  }

  function schedule() {
    if (frame || contextLost) return;
    frame = requestAnimationFrame(draw);
  }

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
    yaw = DEFAULT_YAW;
    pitch = DEFAULT_PITCH;
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

    async captureImage(captureOptions = {}) {
      if (!options.preserveDrawingBuffer) {
        throw new Error('This STL viewer was not created with image capture enabled.');
      }
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      draw();
      return canvasToBlob(captureOptions.mimeType ?? 'image/png', captureOptions.quality);
    },

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
