import { KokoroTTS, env } from "kokoro-js";

import type { KokoroRequest, KokoroResponse } from "./kokoroProtocol";

// The 82M-parameter Kokoro model. Full precision on WebGPU synthesizes several times faster than
// real time; the quantized WebAssembly build runs at half real time here and cannot keep up.
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const WARM_UP_SENTENCE = "Ready.";

type Voice = NonNullable<NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"]>;

const post = (response: KokoroResponse, transfer: Transferable[] = []) =>
  self.postMessage(response, { transfer });

let model: KokoroTTS | null = null;
let generation = 0;
// One request at a time, in order: sentences must come back in the order they were asked for.
let previous: Promise<void> = Promise.resolve();

async function load(request: Extract<KokoroRequest, { type: "load" }>): Promise<void> {
  if (!("gpu" in navigator)) {
    throw new Error(
      "Voice mode speaks replies with WebGPU, which is not available here. Use the desktop app or a browser with WebGPU.",
    );
  }
  env.wasmPaths = request.runtimeAssets;
  const loaded = await KokoroTTS.from_pretrained(MODEL, {
    dtype: "fp32",
    device: "webgpu",
    progress_callback: (progress) => {
      if (progress.status === "progress" && progress.file.endsWith(".onnx") && progress.total > 0) {
        post({ type: "downloading", fraction: progress.loaded / progress.total });
      }
    },
  });
  // The first synthesis compiles the GPU pipeline and takes seconds; spend them before a reply.
  await loaded.generate(WARM_UP_SENTENCE, { voice: request.voice as Voice });
  model = loaded;
  post({ type: "ready" });
}

async function say(request: Extract<KokoroRequest, { type: "say" }>): Promise<void> {
  if (request.generation !== generation) return;
  if (!model) throw new Error("The voice was asked to speak before it finished loading.");
  const audio = await model.generate(request.text, {
    voice: request.voice as Voice,
    speed: request.speed,
  });
  if (request.generation !== generation) return;
  const samples = audio.audio as Float32Array<ArrayBuffer>;
  post(
    {
      type: "audio",
      id: request.id,
      generation: request.generation,
      samples,
      sampleRate: audio.sampling_rate,
    },
    [samples.buffer],
  );
}

self.addEventListener("message", (event: MessageEvent<KokoroRequest>) => {
  const request = event.data;
  if (request.type === "forget") {
    // Applied at once, ahead of the queue, so sentences already waiting are skipped.
    generation = request.generation;
    return;
  }
  previous = previous
    .then(() => (request.type === "load" ? load(request) : say(request)))
    .catch((error: unknown) => {
      post({ type: "failed", message: error instanceof Error ? error.message : String(error) });
    });
});
