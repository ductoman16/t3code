import { isSystemDefaultDeviceId } from "../speech/microphoneOrder";

/** The microphone a call is recording from. */
export interface OpenMicrophone {
  /** The device id it was opened with, empty for the system default. */
  readonly microphoneId: string;
  /** The physical device the browser opened, which for the system default says which one it was. */
  readonly groupId: string;
}

/** The id to open, empty for the system default, including Chromium's "default" alias once saved. */
export function recordingDeviceId(microphoneId: string): string {
  return isSystemDefaultDeviceId(microphoneId) ? "" : microphoneId;
}

/**
 * Whether a call should move to another microphone now: Settings → Voice's order picks a different
 * one, or it picks the system default and the system default is now another device, as when
 * headphones connect.
 */
export function shouldSwitchMicrophone(
  open: OpenMicrophone,
  microphoneId: string,
  devices: ReadonlyArray<Pick<MediaDeviceInfo, "kind" | "deviceId" | "groupId">>,
): boolean {
  if (microphoneId !== open.microphoneId) return true;
  if (microphoneId) return false;
  const systemDefault = devices.find(
    (device) => device.kind === "audioinput" && device.deviceId === "default",
  );
  return systemDefault !== undefined && systemDefault.groupId !== open.groupId;
}
