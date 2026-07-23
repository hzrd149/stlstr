import { parseStl, type Mesh } from './stl';

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
void main() {
  vec3 normal = normalize(vNormal);
  if (!gl_FrontFacing) normal = -normal;
  vec3 keyDirection = normalize(vec3(0.4, 0.7, 1.0));
  float key = max(dot(normal, keyDirection), 0.0);
  float fill = 0.5 + 0.5 * normal.y;
  vec3 lit = uColor * (0.25 + 0.55 * key + 0.30 * fill);
  gl_FragColor = vec4(lit, 1.0);
}
`;

type Matrix = Float32Array;

export type StlThumbnailOptions = {
  width?: number;
  height?: number;
  mimeType?: 'image/png' | 'image/webp';
};

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

function link(gl: WebGLRenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create a WebGL program.');

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Shader program failed to link: ${log ?? 'unknown error'}`);
  }

  return program;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The STL thumbnail could not be encoded.'));
    }, mimeType);
  });
}

function renderMesh(gl: WebGLRenderingContext, mesh: Mesh): void {
  const program = link(gl);
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);

  const positionLocation = gl.getAttribLocation(program, 'aPosition');
  const normalLocation = gl.getAttribLocation(program, 'aNormal');
  const projectionLocation = gl.getUniformLocation(program, 'uProjection');
  const modelViewLocation = gl.getUniformLocation(program, 'uModelView');
  const colorLocation = gl.getUniformLocation(program, 'uColor');
  if (!projectionLocation || !modelViewLocation || !colorLocation) {
    gl.deleteProgram(program);
    throw new Error('The STL thumbnail renderer is missing shader bindings.');
  }

  const positionBuffer = gl.createBuffer();
  const normalBuffer = gl.createBuffer();
  if (!positionBuffer || !normalBuffer) {
    gl.deleteProgram(program);
    throw new Error('Could not allocate STL thumbnail buffers.');
  }

  const center: [number, number, number] = [
    (mesh.min[0] + mesh.max[0]) / 2,
    (mesh.min[1] + mesh.max[1]) / 2,
    (mesh.min[2] + mesh.max[2]) / 2,
  ];
  const radius =
    Math.max(
      Math.hypot(mesh.max[0] - mesh.min[0], mesh.max[1] - mesh.min[1], mesh.max[2] - mesh.min[2]) /
        2,
      1e-6,
    ) || 1;
  const distance = radius * 3.2;
  const near = Math.max(radius * 0.01, 0.01);
  const far = distance + radius * 4;
  const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight || 1;
  const modelView = multiply(
    multiply(
      multiply(translation(0, 0, -distance), rotationX(-Math.PI * 0.15)),
      rotationY(Math.PI * 0.25),
    ),
    translation(-center[0], -center[1], -center[2]),
  );

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(normalLocation);
  gl.vertexAttribPointer(normalLocation, 3, gl.FLOAT, false, 0, 0);

  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.uniformMatrix4fv(projectionLocation, false, perspective(Math.PI / 4, aspect, near, far));
  gl.uniformMatrix4fv(modelViewLocation, false, modelView);
  gl.uniform3f(colorLocation, 0.55, 0.62, 0.78);
  gl.drawArrays(gl.TRIANGLES, 0, mesh.triangleCount * 3);
  gl.finish();

  gl.deleteBuffer(positionBuffer);
  gl.deleteBuffer(normalBuffer);
  gl.deleteProgram(program);
}

/** Renders STL bytes to a detached canvas and returns an upload-ready raster thumbnail. */
export async function renderStlThumbnail(
  bytes: Uint8Array,
  options: StlThumbnailOptions = {},
): Promise<Blob> {
  const mesh = parseStl(bytes);
  const canvas = document.createElement('canvas');
  canvas.width = options.width ?? 512;
  canvas.height = options.height ?? 512;

  const gl =
    (canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    }) as WebGLRenderingContext | null) ??
    (canvas.getContext('experimental-webgl', {
      preserveDrawingBuffer: true,
    }) as WebGLRenderingContext | null);
  if (!gl) throw new Error('This browser could not start WebGL for the STL thumbnail.');

  renderMesh(gl, mesh);
  return canvasToBlob(canvas, options.mimeType ?? 'image/png');
}
