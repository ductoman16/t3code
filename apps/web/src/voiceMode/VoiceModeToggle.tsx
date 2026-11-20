import { msg, T, useGT, useMessages } from "gt-react";
import { AudioLinesIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { toggleVoiceMode, useVoiceModeState, useVoiceModeTranscription } from "./voiceMode";
import type { VoiceModeActivity } from "@t3tools/client-runtime/voice-mode";

const ACTIVITY_LABELS = {
  listening: msg("Listening"),
  hearing: msg("Hearing you"),
  transcribing: msg("Transcribing"),
  sending: msg("Sending"),
  speaking: msg("Speaking"),
} satisfies Record<VoiceModeActivity, string>;

/** Turns the spoken conversation on and off, and shows what it is doing while on. */
export function VoiceModeToggle(props: { readonly disabled?: boolean }) {
  useVoiceModeTranscription();
  const state = useVoiceModeState();
  const gt = useGT();
  const m = useMessages();

  if (state.power === "off") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={gt("Start voice mode")}
              disabled={props.disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={toggleVoiceMode}
              className="shrink-0"
            >
              <AudioLinesIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          <T>Start voice mode</T>
        </TooltipPopup>
      </Tooltip>
    );
  }

  const status =
    state.power === "starting"
      ? state.downloading === null
        ? gt("Starting", { $context: "voice mode is starting" })
        : gt("Loading voice {percent}%", { percent: Math.round(state.downloading * 100) })
      : m(ACTIVITY_LABELS[state.activity]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="compact"
            variant="outline"
            aria-label={gt("Stop voice mode")}
            onPointerDown={(event) => event.preventDefault()}
            onClick={toggleVoiceMode}
            className="shrink-0"
          >
            {state.power === "starting" ? <Spinner /> : <AudioLinesIcon />}
            <span aria-live="polite">{status}</span>
          </Button>
        }
      />
      <TooltipPopup side="top">
        <T>Stop voice mode</T>
      </TooltipPopup>
    </Tooltip>
  );
}
