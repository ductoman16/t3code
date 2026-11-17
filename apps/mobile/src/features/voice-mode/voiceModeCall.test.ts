import type { VoiceModeState } from "@t3tools/client-runtime/voice-mode";
import { describe, expect, it } from "vite-plus/test";

import { createVoiceModeCall } from "./voiceModeCall";

function setUp(options: { askingForMicrophone?: boolean } = {}) {
  let hangUp: (() => void) | null = null;
  const listeners = new Set<() => void>();
  let notificationAsks = 0;
  const controller = {
    state: { power: "off" } as VoiceModeState,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    turnOff: () => controller.setPower("off"),
    setPower: (power: VoiceModeState["power"]) => {
      controller.state = { ...controller.state, power };
      listeners.forEach((listener) => listener());
    },
  };
  const call = createVoiceModeCall({
    native: {
      addListener: (_event: "onHangUp", listener: () => void) => {
        hangUp = listener;
        return { remove: () => (hangUp = null) };
      },
    } as unknown as Parameters<typeof createVoiceModeCall>[0]["native"],
    controller,
    askingForMicrophone: () => options.askingForMicrophone ?? false,
    askForNotifications: async () => {
      notificationAsks += 1;
    },
  });
  return { call, controller, hangUp: () => hangUp?.(), notificationAsks: () => notificationAsks };
}

describe("createVoiceModeCall", () => {
  it("hangs up from the notification", () => {
    const { controller, hangUp } = setUp();
    controller.setPower("on");

    hangUp();

    expect(controller.state.power).toBe("off");
  });

  it("keeps a running call going in the background and stops one still starting", () => {
    const { call, controller } = setUp();
    controller.setPower("on");
    call.appStateChanged("background");
    expect(controller.state.power).toBe("on");

    controller.setPower("off");
    controller.setPower("starting");
    call.appStateChanged("background");
    expect(controller.state.power).toBe("off");
  });

  it("keeps starting while Android asks for the microphone", () => {
    const { call, controller } = setUp({ askingForMicrophone: true });
    controller.setPower("starting");

    call.appStateChanged("background");

    expect(controller.state.power).toBe("starting");
  });

  it("asks to show its notification once, when the call is on", () => {
    const { controller, notificationAsks } = setUp();
    controller.setPower("starting");
    expect(notificationAsks()).toBe(0);

    controller.setPower("on");
    controller.setPower("off");
    controller.setPower("on");

    expect(notificationAsks()).toBe(1);
  });
});
