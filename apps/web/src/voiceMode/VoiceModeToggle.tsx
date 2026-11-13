import { AudioLinesIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { toggleVoiceMode, useVoiceModeState, useVoiceModeTranscription } from "./voiceMode";
import type { VoiceModeActivity } from "./voiceModeController";

const ACTIVITY_LABELS: Record<VoiceModeActivity, string> = {
  listening: "Listening",
  hearing: "Hearing you",
  transcribing: "Transcribing",
  sending: "Sending",
  speaking: "Speaking",
};

/** Turns the spoken conversation on and off, and shows what it is doing while on. */
export function VoiceModeToggle(props: { readonly disabled?: boolean }) {
  useVoiceModeTranscription();
  const state = useVoiceModeState();

  if (state.power === "off") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Start voice mode"
              disabled={props.disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={toggleVoiceMode}
              className="shrink-0"
            >
              <AudioLinesIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">Start voice mode</TooltipPopup>
      </Tooltip>
    );
  }

  const status =
    state.power === "starting"
      ? state.downloading === null
        ? "Starting"
        : `Loading voice ${Math.round(state.downloading * 100)}%`
      : ACTIVITY_LABELS[state.activity];

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="compact"
            variant="outline"
            aria-label="Stop voice mode"
            onPointerDown={(event) => event.preventDefault()}
            onClick={toggleVoiceMode}
            className="shrink-0"
          >
            {state.power === "starting" ? <Spinner /> : <AudioLinesIcon />}
            <span aria-live="polite">{status}</span>
          </Button>
        }
      />
      <TooltipPopup side="top">Stop voice mode</TooltipPopup>
    </Tooltip>
  );
}
