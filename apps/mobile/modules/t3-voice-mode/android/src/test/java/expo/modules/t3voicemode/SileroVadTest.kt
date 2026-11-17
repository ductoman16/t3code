package expo.modules.t3voicemode

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class SileroVadTest {
  @Test
  fun scoresSilenceAsUnlikelyToBeSpeech() {
    SileroVad(File("src/main/assets/${SileroVad.ASSET}").readBytes()).use { vad ->
      val probabilities = List(30) { vad.speechProbability(ShortArray(SileroVad.FRAME_SAMPLES)) }

      assertTrue(probabilities.toString(), probabilities.all { it in 0f..0.1f })
    }
  }
}
