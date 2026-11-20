import { describe, expect, it } from "vite-plus/test";

import { shouldSwitchMicrophone } from "./microphoneSwitch";

const laptop = { kind: "audioinput", deviceId: "laptop", groupId: "laptop-group" } as const;
const headset = { kind: "audioinput", deviceId: "headset", groupId: "headset-group" } as const;
const defaultIs = (groupId: string) =>
  ({ kind: "audioinput", deviceId: "default", groupId }) as const;

describe("shouldSwitchMicrophone", () => {
  it("moves when the order now picks another microphone", () => {
    const open = { microphoneId: "laptop", groupId: "laptop-group" };

    expect(shouldSwitchMicrophone(open, "headset", [laptop, headset])).toBe(true);
  });

  it("stays on a chosen microphone whatever the system default does", () => {
    const open = { microphoneId: "laptop", groupId: "laptop-group" };

    expect(
      shouldSwitchMicrophone(open, "laptop", [defaultIs("headset-group"), laptop, headset]),
    ).toBe(false);
  });

  it("follows the system default to headphones that just connected", () => {
    const open = { microphoneId: "", groupId: "laptop-group" };

    expect(shouldSwitchMicrophone(open, "", [defaultIs("headset-group"), laptop, headset])).toBe(
      true,
    );
  });

  it("stays when the system default is unchanged", () => {
    const open = { microphoneId: "", groupId: "laptop-group" };
    const speakers = {
      kind: "audiooutput",
      deviceId: "default",
      groupId: "speaker-group",
    } as const;

    expect(shouldSwitchMicrophone(open, "", [speakers, defaultIs("laptop-group"), laptop])).toBe(
      false,
    );
  });
});
