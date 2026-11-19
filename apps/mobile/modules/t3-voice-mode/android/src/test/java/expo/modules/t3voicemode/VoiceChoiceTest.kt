package expo.modules.t3voicemode

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceChoiceTest {
  private fun voice(
    name: String,
    locale: String = "en-US",
    quality: Int = 400,
    offline: Boolean = true,
    isDefault: Boolean = false
  ): VoiceOption {
    val parsed = Locale.forLanguageTag(locale)
    return VoiceOption(name, parsed.language, parsed.country, quality, offline, isDefault)
  }

  private val us = Locale.US

  @Test
  fun choosesTheHighestQualityOfflineVoice() {
    val options = listOf(voice("plain", quality = 300), voice("natural", quality = 400))

    assertEquals("natural", bestVoice(options, us))
  }

  @Test
  fun neverWaitsOnTheNetworkOrAVoiceStillToDownload() {
    val options = listOf(voice("cloud", quality = 500, offline = false), voice("local"))

    assertEquals("local", bestVoice(options, us))
  }

  @Test
  fun prefersThePhonesOwnCountryThenTheEnginesDefault() {
    val options = listOf(
      voice("british", locale = "en-GB", quality = 500),
      voice("american"),
      voice("american-default", isDefault = true)
    )

    assertEquals("american-default", bestVoice(options, us))
  }

  @Test
  fun leavesTheEnginesChoiceWhenNothingSpeaksThePhonesLanguage() {
    assertNull(bestVoice(listOf(voice("french", locale = "fr-FR")), us))
  }
}
