import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let binding = null;

try {
  binding = require(path.join(__dirname, "build", "Release", "avara_native_core.node"));
} catch {
  binding = null;
}

export const nativeCoreAvailable = Boolean(binding);

export function buildCollisionTriangleBuffer(meshes) {
  const triangles = [];

  for (const mesh of meshes ?? []) {
    for (const triangle of mesh.triangles ?? []) {
      triangles.push(
        triangle.a.x,
        triangle.a.y,
        triangle.a.z,
        triangle.b.x,
        triangle.b.y,
        triangle.b.z,
        triangle.c.x,
        triangle.c.y,
        triangle.c.z
      );
    }
  }

  return new Float64Array(triangles);
}

export function findSegmentImpactNative(triangleBuffer, start, end, radius = 0) {
  if (!binding || !(triangleBuffer instanceof Float64Array) || triangleBuffer.length === 0) {
    return null;
  }

  return binding.findSegmentImpact(
    triangleBuffer,
    start.x,
    start.y,
    start.z,
    end.x,
    end.y,
    end.z,
    radius
  );
}

export function findRayDistanceNative(triangleBuffer, origin, target) {
  if (!binding || !(triangleBuffer instanceof Float64Array) || triangleBuffer.length === 0) {
    return null;
  }

  return binding.findRayDistance(
    triangleBuffer,
    origin.x,
    origin.y,
    origin.z,
    target.x,
    target.y,
    target.z
  );
}
