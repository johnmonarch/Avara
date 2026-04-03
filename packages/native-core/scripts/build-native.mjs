import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const nativeRoot = path.join(packageRoot, "native");
const outputDir = path.join(packageRoot, "build", "Release");
const outputFile = path.join(outputDir, "avara_native_core.node");

const includeCandidates = [
  "/usr/local/include/node",
  "/opt/homebrew/include/node"
];

const includeDir = includeCandidates.find((candidate) => spawnSync("test", ["-d", candidate]).status === 0);
if (!includeDir) {
  console.error("Unable to locate node_api.h include directory.");
  process.exit(1);
}

const compiler = process.env.CXX
  || ["c++", "clang++", "g++"].find((candidate) => spawnSync("which", [candidate], { stdio: "ignore" }).status === 0);

if (!compiler) {
  console.error("Unable to locate a C++ compiler.");
  process.exit(1);
}

await mkdir(outputDir, { recursive: true });

const args = [
  "-std=c++17",
  "-O3",
  "-I",
  includeDir,
  path.join(nativeRoot, "collision_core.cpp"),
  path.join(nativeRoot, "native_core.cc"),
  "-o",
  outputFile
];

if (process.platform === "darwin") {
  args.unshift("-undefined", "dynamic_lookup");
  args.unshift("-bundle");
} else {
  args.unshift("-fPIC");
  args.unshift("-shared");
}

const result = spawnSync(compiler, args, { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
