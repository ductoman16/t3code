package expo.modules.t3voicemode

import java.io.File
import kotlin.math.abs
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceModeChimeTest {
  @Test
  fun eachNoteRampsInAndOutSoItDoesNotClick() {
    for (chime in VoiceModeChime.entries) {
      val pcm = chime.pcm()
      val note = VoiceModeChime.SAMPLE_RATE * VoiceModeChime.NOTE_MS / 1000
      assertEquals(0, pcm.size % note)
      for (start in pcm.indices step note) {
        val edges = (0 until 8).map { pcm[start + it] } + (1..8).map { pcm[start + note - it] }
        assertTrue("$chime $edges", edges.all { abs(it.toInt()) < 1000 })
        assertTrue(chime.name, (start until start + note).maxOf { pcm[it].toInt() } in 7000..8200)
      }
    }
  }

  @Test
  fun theStartChimeRisesAndTheStopChimeFalls() {
    fun crossings(
      pcm: ShortArray,
      range: IntRange
    ) = range.count { pcm[it - 1] < 0 && pcm[it] >= 0 }
    for ((chime, rising) in listOf(VoiceModeChime.START to true, VoiceModeChime.STOP to false)) {
      val pcm = chime.pcm()
      val half = pcm.size / 2
      val first = crossings(pcm, 1 until half)
      val second = crossings(pcm, half + 1 until pcm.size)
      assertEquals(chime.name, rising, second > first)
    }
  }

  @Test
  fun theDetectorDoesNotTakeTheChimesForSpeech() {
    val random = Random(3)
    fun quiet(ms: Int) = ShortArray(16 * ms) { (random.nextInt(-30, 30)).toShort() }
    SileroVad(File("src/main/assets/${SileroVad.ASSET}").readBytes()).use { vad ->
      val detector = SpeechDetector(vad)
      val chimes = VoiceModeChime.entries.map { it.pcm(sampleRate = 16000) }
      val audio =
        quiet(500) + chimes[0] + quiet(300) + chimes[1] + chimes[0] + chimes[1] + quiet(1000)

      val events = audio.toList().chunked(SileroVad.FRAME_SAMPLES)
        .filter { it.size == SileroVad.FRAME_SAMPLES }
        .mapNotNull { detector.process(it.toShortArray()) }

      assertEquals(emptyList<SpeechDetector.Event>(), events)
    }
  }
}
