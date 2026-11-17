package expo.modules.t3voicemode

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer
import java.nio.LongBuffer

/** How likely a frame of 16 kHz mono PCM16 is to be speech, from 0 to 1. */
internal fun interface SpeechModel {
  fun speechProbability(frame: ShortArray): Float
}

/**
 * Silero VAD v5, the model the web client's detector runs. It takes 512-sample frames, each led by
 * the last 64 samples of the one before, and carries a recurrent state from frame to frame.
 */
internal class SileroVad(model: ByteArray) : SpeechModel, AutoCloseable {
  private val environment = OrtEnvironment.getEnvironment()
  private val session = environment.createSession(
    model,
    OrtSession.SessionOptions().apply {
      setIntraOpNumThreads(1)
      setInterOpNumThreads(1)
    }
  )
  private val sampleRate = OnnxTensor.createTensor(
    environment,
    LongBuffer.wrap(longArrayOf(16000)),
    longArrayOf(1)
  )
  private val input = FloatArray(CONTEXT_SAMPLES + FRAME_SAMPLES)
  private val state = FloatArray(STATE_SIZE)

  override fun speechProbability(frame: ShortArray): Float {
    require(frame.size == FRAME_SAMPLES) {
      "Silero needs $FRAME_SAMPLES samples, not ${frame.size}."
    }
    input.copyInto(input, 0, FRAME_SAMPLES, FRAME_SAMPLES + CONTEXT_SAMPLES)
    for (i in frame.indices) input[CONTEXT_SAMPLES + i] = frame[i] / 32768f
    OnnxTensor.createTensor(
      environment,
      FloatBuffer.wrap(input),
      longArrayOf(1, input.size.toLong())
    ).use { audio ->
      OnnxTensor.createTensor(
        environment,
        FloatBuffer.wrap(state),
        longArrayOf(2, 1, 128)
      ).use { previous ->
        session.run(
          mapOf("input" to audio, "state" to previous, "sr" to sampleRate)
        ).use { result ->
          (result.get("stateN").get() as OnnxTensor).floatBuffer.get(state)
          return (result.get("output").get() as OnnxTensor).floatBuffer.get(0)
        }
      }
    }
  }

  override fun close() {
    sampleRate.close()
    session.close()
  }

  companion object {
    const val FRAME_SAMPLES = 512
    const val ASSET = "silero_vad_v5.onnx"
    private const val CONTEXT_SAMPLES = 64
    private const val STATE_SIZE = 2 * 128
  }
}
