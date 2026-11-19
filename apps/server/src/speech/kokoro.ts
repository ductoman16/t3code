/** The 82M-parameter Kokoro model the desktop app reads replies with, at the same precision. */
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export interface KokoroVoice {
  readonly voices: ReadonlySet<string>;
  readonly generate: (
    text: string,
    options: { readonly voice: string; readonly speed: number },
  ) => Promise<{ readonly samples: Float32Array; readonly sampleRate: number }>;
  readonly dispose: () => Promise<void>;
}

type Voice = NonNullable<
  NonNullable<Parameters<import("kokoro-js").KokoroTTS["generate"]>[1]>["voice"]
>;

// Imported on first use: the ONNX runtime is a large native library most servers never load.
export async function loadKokoro(cacheDirectory: string): Promise<KokoroVoice> {
  const [{ KokoroTTS }, { env }] = await Promise.all([
    import("kokoro-js"),
    import("@huggingface/transformers"),
  ]);
  env.cacheDir = cacheDirectory;
  const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "fp32", device: "cpu" });
  return {
    voices: new Set(Object.keys(tts.voices)),
    generate: async (text, { voice, speed }) => {
      const audio = await tts.generate(text, { voice: voice as Voice, speed });
      return { samples: audio.audio, sampleRate: audio.sampling_rate };
    },
    dispose: async () => {
      await tts.model.dispose();
    },
  };
}
