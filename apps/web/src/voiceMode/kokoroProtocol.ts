/** Messages between the page and the worker that runs the Kokoro speech model. */

export type KokoroRequest =
  | {
      readonly type: "load";
      /** Absolute URL of the directory holding the ONNX runtime's WebAssembly files. */
      readonly runtimeAssets: string;
      readonly voice: string;
    }
  | {
      readonly type: "say";
      readonly id: number;
      /** Sentences from a generation that has since been forgotten are not synthesized. */
      readonly generation: number;
      readonly text: string;
      readonly voice: string;
      readonly speed: number;
    }
  | { readonly type: "forget"; readonly generation: number };

export type KokoroResponse =
  | { readonly type: "downloading"; readonly fraction: number }
  | { readonly type: "ready" }
  | {
      readonly type: "audio";
      readonly id: number;
      readonly generation: number;
      readonly samples: Float32Array<ArrayBuffer>;
      readonly sampleRate: number;
    }
  | { readonly type: "failed"; readonly message: string };
