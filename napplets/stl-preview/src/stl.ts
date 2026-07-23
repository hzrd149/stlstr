/**
 * STL parsing.
 *
 * Both STL flavors are handled here because neither is reliably identifiable from its
 * first bytes: binary STL has an 80-byte free-form header that some exporters fill with
 * the word "solid", which is also exactly how an ASCII file starts. The only sound test is
 * arithmetic — a binary file's length is exactly `84 + 50 * triangleCount` — so that is
 * what `parseStl` checks first, and the textual sniff is the fallback.
 */

/** Flat-shaded triangle soup, ready to hand straight to a vertex buffer. */
export type Mesh = {
  /** Triangle vertices, 9 floats per triangle. */
  positions: Float32Array;
  /** Per-vertex normals, parallel to `positions`. */
  normals: Float32Array;
  triangleCount: number;
  /** Axis-aligned bounds, used to frame the camera. */
  min: [number, number, number];
  max: [number, number, number];
};

const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
const TRIANGLE_BYTES = 50;

/**
 * A facet normal is publisher-supplied and frequently wrong — zero, denormalized, or
 * inverted. Recompute from the winding when it is not a usable unit vector.
 */
function faceNormal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): [number, number, number] {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;

  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;

  const length = Math.hypot(nx, ny, nz);
  // A degenerate triangle has no normal; point it at the camera rather than emitting NaN.
  if (!length) return [0, 0, 1];
  return [nx / length, ny / length, nz / length];
}

function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < HEADER_BYTES + COUNT_BYTES) return false;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(HEADER_BYTES, true);
  return bytes.byteLength === HEADER_BYTES + COUNT_BYTES + count * TRIANGLE_BYTES;
}

function buildMesh(positions: Float32Array, normals: Float32Array, triangleCount: number): Mesh {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }

  return { positions, normals, triangleCount, min, max };
}

function parseBinary(bytes: Uint8Array): Mesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(HEADER_BYTES, true);

  const positions = new Float32Array(triangleCount * 9);
  const normals = new Float32Array(triangleCount * 9);

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    // Skip the stored facet normal; it is recomputed below from the winding.
    const base = HEADER_BYTES + COUNT_BYTES + triangle * TRIANGLE_BYTES + 12;
    const out = triangle * 9;

    for (let corner = 0; corner < 9; corner += 1) {
      positions[out + corner] = view.getFloat32(base + corner * 4, true);
    }

    const [nx, ny, nz] = faceNormal(
      positions[out],
      positions[out + 1],
      positions[out + 2],
      positions[out + 3],
      positions[out + 4],
      positions[out + 5],
      positions[out + 6],
      positions[out + 7],
      positions[out + 8],
    );

    for (let corner = 0; corner < 3; corner += 1) {
      normals[out + corner * 3] = nx;
      normals[out + corner * 3 + 1] = ny;
      normals[out + corner * 3 + 2] = nz;
    }
  }

  return buildMesh(positions, normals, triangleCount);
}

/**
 * Reads every `vertex x y z` in document order. ASCII STL nests those inside `facet`
 * blocks, but the block structure carries no information a flat scan misses: vertices
 * always come in threes, and the facet normal is recomputed anyway.
 */
function parseAscii(text: string): Mesh {
  const vertices: number[] = [];
  const pattern = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;

  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    vertices.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  const triangleCount = Math.floor(vertices.length / 9);
  if (triangleCount === 0) throw new Error('No triangles found in this STL.');

  const positions = new Float32Array(vertices.slice(0, triangleCount * 9));
  const normals = new Float32Array(positions.length);

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const out = triangle * 9;
    const [nx, ny, nz] = faceNormal(
      positions[out],
      positions[out + 1],
      positions[out + 2],
      positions[out + 3],
      positions[out + 4],
      positions[out + 5],
      positions[out + 6],
      positions[out + 7],
      positions[out + 8],
    );

    for (let corner = 0; corner < 3; corner += 1) {
      normals[out + corner * 3] = nx;
      normals[out + corner * 3 + 1] = ny;
      normals[out + corner * 3 + 2] = nz;
    }
  }

  return buildMesh(positions, normals, triangleCount);
}

/** True when these bytes look like either STL flavor. Cheap enough to run before parsing. */
export function looksLikeStl(bytes: Uint8Array): boolean {
  if (isBinaryStl(bytes)) return true;

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 512))
    .trimStart()
    .toLowerCase();
  return head.startsWith('solid') && head.includes('facet');
}

/** Parses either STL flavor into a flat-shaded mesh. Throws with a displayable message. */
export function parseStl(bytes: Uint8Array): Mesh {
  if (isBinaryStl(bytes)) {
    const mesh = parseBinary(bytes);
    if (mesh.triangleCount === 0) throw new Error('This STL contains no triangles.');
    return mesh;
  }

  return parseAscii(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
}
