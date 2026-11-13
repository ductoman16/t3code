// @effect-diagnostics nodeBuiltinImport:off -- Vite plugin runs in Node before any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { Plugin } from "vite-plus";

const require = NodeModule.createRequire(import.meta.url);

interface AssetGroup {
  /** Path under the web root, ending in a slash. The package version keeps caches in step. */
  readonly urlPath: string;
  readonly files: ReadonlyArray<{ readonly name: string; readonly path: string }>;
}

// Not every package exports its package.json, so walk up from its entry point to find it.
function packageRoot(resolve: NodeJS.Require, name: string) {
  const entry = resolve.resolve(name);
  for (
    let directory = NodePath.dirname(entry);
    directory !== NodePath.dirname(directory);
    directory = NodePath.dirname(directory)
  ) {
    const manifest = NodePath.join(directory, "package.json");
    if (!NodeFS.existsSync(manifest)) continue;
    const contents = JSON.parse(NodeFS.readFileSync(manifest, "utf8")) as {
      name?: string;
      version?: string;
    };
    if (contents.name === name && contents.version) {
      return { directory, manifest, version: contents.version };
    }
  }
  throw new Error(`Could not find the package.json of "${name}" above "${entry}".`);
}

// Voice mode's speech detector and speech synthesizer load these by URL at runtime, so they ship
// as plain files under stable names instead of hashed bundler assets. Loading them from a CDN, as
// both libraries do by default, is blocked by the desktop app's content security policy.
function resolveAssets() {
  const vad = packageRoot(require, "@ricky0123/vad-web");
  // onnxruntime-web is vad-web's own dependency, so resolve it the way vad-web does.
  const vadRuntime = NodePath.dirname(
    NodeModule.createRequire(vad.manifest).resolve("onnxruntime-web/wasm"),
  );
  // kokoro-js runs on Transformers.js, which bundles the WebGPU build of its own runtime.
  const kokoro = packageRoot(require, "kokoro-js");
  const transformers = packageRoot(
    NodeModule.createRequire(kokoro.manifest),
    "@huggingface/transformers",
  );
  const fromDirectory = (directory: string, names: readonly string[]) =>
    names.map((name) => ({ name, path: NodePath.join(directory, name) }));
  return {
    detector: {
      urlPath: `voice-mode/vad-${vad.version}/`,
      files: [
        ...fromDirectory(NodePath.join(vad.directory, "dist"), [
          "silero_vad_v5.onnx",
          "vad.worklet.bundle.min.js",
        ]),
        ...fromDirectory(vadRuntime, ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]),
      ],
    },
    synthesizer: {
      urlPath: `voice-mode/tts-${transformers.version}/`,
      files: fromDirectory(NodePath.join(transformers.directory, "dist"), [
        "ort-wasm-simd-threaded.jsep.mjs",
        "ort-wasm-simd-threaded.jsep.wasm",
      ]),
    },
  } satisfies Record<string, AssetGroup>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

export function voiceModeAssetsPlugin(): Plugin {
  const assets = resolveAssets();
  const groups: ReadonlyArray<AssetGroup> = [assets.detector, assets.synthesizer];
  for (const file of groups.flatMap((group) => group.files)) {
    if (!NodeFS.existsSync(file.path)) {
      throw new Error(
        `Voice mode asset "${file.name}" is missing at "${file.path}". ` +
          "A dependency upgrade probably renamed it; update apps/web/vite/voiceModeAssets.ts.",
      );
    }
  }
  return {
    name: "t3code:voice-mode-assets",
    config() {
      return {
        define: {
          "import.meta.env.VITE_VOICE_MODE_DETECTOR_ASSETS": JSON.stringify(
            assets.detector.urlPath,
          ),
          "import.meta.env.VITE_VOICE_MODE_SYNTHESIZER_ASSETS": JSON.stringify(
            assets.synthesizer.urlPath,
          ),
        },
      };
    },
    configureServer(server) {
      for (const group of groups) {
        server.middlewares.use(`/${group.urlPath}`, (request, response, next) => {
          const name = (request.url ?? "").split("?")[0]?.replace(/^\//, "");
          const file = group.files.find((candidate) => candidate.name === name);
          if (!file) return next();
          response.setHeader(
            "Content-Type",
            CONTENT_TYPES[NodePath.extname(file.name)] ?? "application/octet-stream",
          );
          NodeFS.createReadStream(file.path).pipe(response);
        });
      }
    },
    generateBundle() {
      for (const group of groups) {
        for (const file of group.files) {
          this.emitFile({
            type: "asset",
            fileName: `${group.urlPath}${file.name}`,
            source: NodeFS.readFileSync(file.path),
          });
        }
      }
    },
  };
}
