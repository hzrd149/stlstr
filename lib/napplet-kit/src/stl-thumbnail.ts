import { parseStl, type Mesh } from './stl';
import {
  canvasToBlob,
  createWebglContext,
  linkProgram,
  meshFrame,
  multiply,
  perspective,
  rotationX,
  rotationY,
  translation,
} from './stl-webgl';

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

export type StlThumbnailOptions = {
  width?: number;
  height?: number;
  mimeType?: 'image/png' | 'image/webp';
  rotationX?: number;
  rotationY?: number;
};

function renderMesh(gl: WebGLRenderingContext, mesh: Mesh, options: StlThumbnailOptions): void {
  const program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
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

  const { center, radius } = meshFrame(mesh);
  const distance = radius * 3.2;
  const near = Math.max(radius * 0.01, 0.01);
  const far = distance + radius * 4;
  const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight || 1;
  const rotationXPreset = options.rotationX ?? -Math.PI * 0.15;
  const rotationYPreset = options.rotationY ?? Math.PI * 0.25;
  const modelView = multiply(
    multiply(
      multiply(translation(0, 0, -distance), rotationX(rotationXPreset)),
      rotationY(rotationYPreset),
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

  const gl = createWebglContext(canvas, {
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('This browser could not start WebGL for the STL thumbnail.');

  renderMesh(gl, mesh, options);
  return canvasToBlob(canvas, options.mimeType ?? 'image/png');
}
