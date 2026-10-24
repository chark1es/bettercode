"use strict"

// [PACKAGING] electron-builder `afterPack` hook. node-pty ships prebuilds for
// every platform/arch plus Windows .pdb debug symbols (~64 MB), but
// node-pty/lib/utils.js only loads `build/Release` or
// `prebuilds/<process.platform>-<process.arch>`. Drop everything that cannot be
// loaded by the app being packed. The strip-packaging-artifacts.cjs script is
// not part of the CI package action, so this runs inside electron-builder.

const fs = require("fs")
const path = require("path")

// electron-builder `Arch` enum values.
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "arm", 3: "arm64", 4: "universal" }

function keptPrebuildDirs(platform, arch) {
  // Universal macOS builds run as either arch.
  if (arch === "universal") return new Set([`${platform}-x64`, `${platform}-arm64`])
  return new Set([`${platform}-${arch}`])
}

function removePdbFiles(dir) {
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) bytes += removePdbFiles(full)
    else if (entry.name.endsWith(".pdb")) {
      bytes += fs.statSync(full).size
      fs.unlinkSync(full)
    }
  }
  return bytes
}

const NATIVE_MODULES = ["better-sqlite3", "node-pty"]
const BUILD_ONLY_DIRS = new Set(["obj", "obj.target", ".deps"])
const BUILD_ONLY_EXTENSIONS = [".iobj", ".ipdb", ".obj", ".lib", ".exp", ".ilk", ".tlog", ".o", ".a"]

function removeBuildIntermediates(dir) {
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (BUILD_ONLY_DIRS.has(entry.name)) bytes += removeTree(full)
      else bytes += removeBuildIntermediates(full)
    } else if (BUILD_ONLY_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      bytes += fs.statSync(full).size
      fs.unlinkSync(full)
    }
  }
  return bytes
}

function treeBytes(dir) {
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    bytes += entry.isDirectory() ? treeBytes(full) : fs.statSync(full).size
  }
  return bytes
}

function removeTree(dir) {
  const bytes = treeBytes(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  return bytes
}

// Removes native sources and compiler output; only lib/, package.json and the
// built binaries are needed to load the module.
function pruneNativeBuildInputs({ resourcesDir }) {
  let bytes = 0
  for (const name of NATIVE_MODULES) {
    const moduleDir = path.join(resourcesDir, "app.asar.unpacked", "node_modules", name)
    if (!fs.existsSync(moduleDir)) continue
    for (const sub of ["src", "deps"]) {
      const full = path.join(moduleDir, sub)
      if (fs.existsSync(full)) bytes += removeTree(full)
    }
    const buildDir = path.join(moduleDir, "build")
    if (fs.existsSync(buildDir)) bytes += removeBuildIntermediates(buildDir)
  }
  return bytes
}

function pruneNodePtyPrebuilds({ resourcesDir, platform, arch }) {
  const prebuildsDir = path.join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds")
  if (!fs.existsSync(prebuildsDir)) return { removed: [], pdbBytes: 0 }

  const keep = keptPrebuildDirs(platform, arch)
  const removed = []
  for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
    if (keep.has(entry.name)) continue
    fs.rmSync(path.join(prebuildsDir, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  return { removed, pdbBytes: removePdbFiles(prebuildsDir) }
}

module.exports = async function afterPack(context) {
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  const result = pruneNodePtyPrebuilds({
    resourcesDir,
    platform: context.electronPlatformName,
    arch: ARCH_NAMES[context.arch] ?? String(context.arch),
  })
  const sourceBytes = pruneNativeBuildInputs({ resourcesDir })
  console.log(
    `[prune-native-modules] removed node-pty prebuilds [${result.removed.join(", ")}], ${(result.pdbBytes / (1024 * 1024)).toFixed(1)} MB of .pdb symbols and ${(sourceBytes / (1024 * 1024)).toFixed(1)} MB of native sources/build intermediates`,
  )
}

module.exports.pruneNodePtyPrebuilds = pruneNodePtyPrebuilds
module.exports.pruneNativeBuildInputs = pruneNativeBuildInputs
