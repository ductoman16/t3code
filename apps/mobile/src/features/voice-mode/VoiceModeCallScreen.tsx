import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { requireNativeModule } from "expo";
import { useEffect } from "react";
import { Platform, Pressable, StatusBar, View } from "react-native";
import Animated, { css } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { useAppForeground, useReduceMotionEnabled } from "../../lib/appState";
import { useThreadShell } from "../../state/entities";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { callLook, callStatusLabel, type CallLook } from "./callLook";
import { turnOffVoiceMode, useVoiceModeCaption, useVoiceModeState } from "./voiceMode";

// Dark in both themes, with bright marks, so the call stays legible when the phone dims it.
const BACKGROUND = "#05070D";
const TITLE = "#E5E7EB";
const CAPTION = "#F8FAFC";
const NOTICE = "#FBBF24";
const HANG_UP = "#E5484D";

const ORB = 280;
const CORE = 148;

const pulse = (from: object, to: object) => css.keyframes({ from, to });

const THINKING = {
  rgb: "167, 139, 250",
  halo: pulse(
    { opacity: 0.35, transform: [{ scale: 0.94 }] },
    { opacity: 0.8, transform: [{ scale: 1 }] },
  ),
  core: pulse({ opacity: 0.72 }, { opacity: 1 }),
  ms: 1100,
};

const LOOKS: Record<
  CallLook,
  {
    readonly rgb: string;
    readonly halo: ReturnType<typeof css.keyframes>;
    readonly core: ReturnType<typeof css.keyframes>;
    readonly ms: number;
  }
> = {
  connecting: {
    rgb: "148, 163, 184",
    halo: pulse({ opacity: 0.3 }, { opacity: 0.6 }),
    core: pulse({ opacity: 0.7 }, { opacity: 0.9 }),
    ms: 1600,
  },
  listening: {
    rgb: "45, 212, 191",
    halo: pulse(
      { opacity: 0.55, transform: [{ scale: 0.9 }] },
      { opacity: 0.85, transform: [{ scale: 1.02 }] },
    ),
    core: pulse({ transform: [{ scale: 1 }] }, { transform: [{ scale: 1.03 }] }),
    ms: 2400,
  },
  hearing: {
    rgb: "94, 234, 212",
    halo: pulse(
      { opacity: 0.8, transform: [{ scale: 0.96 }] },
      { opacity: 1, transform: [{ scale: 1.16 }] },
    ),
    core: pulse({ transform: [{ scale: 1.02 }] }, { transform: [{ scale: 1.1 }] }),
    ms: 600,
  },
  thinking: THINKING,
  transcribing: THINKING,
  sending: THINKING,
  speaking: {
    rgb: "96, 165, 250",
    halo: pulse(
      { opacity: 0.7, transform: [{ scale: 1 }] },
      { opacity: 0.95, transform: [{ scale: 1.1 }] },
    ),
    core: pulse({ transform: [{ scale: 1 }] }, { transform: [{ scale: 1.05 }] }),
    ms: 800,
  },
};

const RIPPLE = css.keyframes({
  from: { opacity: 0.7, transform: [{ scale: 1 }] },
  to: { opacity: 0, transform: [{ scale: 1.8 }] },
});

type VoiceModeCallRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/** A voice mode call in a thread: the thread's name, its state, what the agent says, Hang up. */
export function VoiceModeCallRouteScreen({ route }: VoiceModeCallRouteScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const state = useVoiceModeState();
  const caption = useVoiceModeCaption();
  const thread = useThreadShell(
    scopeThreadRef(
      EnvironmentId.make(route.params.environmentId),
      ThreadId.make(route.params.threadId),
    ),
  );
  const look = callLook(state, threadRuntimeIsActive(thread?.runtime));
  const ended = state.power === "off";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaves the screen when the call ends, whether hung up here, from the notification, or by an error
  useEffect(() => {
    if (ended && navigation.canGoBack()) navigation.goBack();
  }, [ended, navigation]);
  useDarkNavigationBar();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: BACKGROUND,
        paddingTop: insets.top + 32,
        paddingBottom: insets.bottom + 40,
        paddingHorizontal: 24,
      }}
    >
      <StatusBar barStyle="light-content" />
      <AppText
        numberOfLines={2}
        accessibilityRole="header"
        style={{ color: TITLE, fontSize: 20, fontWeight: "700", textAlign: "center" }}
      >
        {thread?.title ?? ""}
      </AppText>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 20 }}>
        <CallOrb look={look} />
        <AppText
          accessibilityLiveRegion="polite"
          style={{
            color: `rgb(${LOOKS[look].rgb})`,
            fontSize: 22,
            fontWeight: "600",
          }}
        >
          {callStatusLabel(state, look)}
        </AppText>
      </View>
      <AppText
        numberOfLines={5}
        style={{
          color: state.notice ? NOTICE : CAPTION,
          fontSize: 20,
          lineHeight: 28,
          minHeight: 28 * 3,
          textAlign: "center",
        }}
      >
        {state.notice ?? caption}
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Hang up"
        onPress={turnOffVoiceMode}
        style={({ pressed }) => ({
          alignSelf: "center",
          marginTop: 32,
          width: 80,
          height: 80,
          borderRadius: 40,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: HANG_UP,
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <SymbolView name="phone.down.fill" size={36} tintColor="#FFFFFF" />
      </Pressable>
    </View>
  );
}

function CallOrb(props: { readonly look: CallLook }) {
  const look = LOOKS[props.look];
  // Still while the app is out of sight, so the animation never draws for nobody.
  const foreground = useAppForeground();
  const reduceMotion = useReduceMotionEnabled();
  const moving = foreground && !reduceMotion;
  const animation = (name: ReturnType<typeof css.keyframes>, direction: "alternate" | "normal") =>
    moving
      ? {
          animationName: name,
          animationDuration: direction === "alternate" ? look.ms : look.ms * 1.75,
          animationDirection: direction,
          animationIterationCount: "infinite" as const,
          animationTimingFunction: "ease-in-out" as const,
        }
      : { animationName: "none" as const };
  const circle = (size: number) =>
    ({ position: "absolute", width: size, height: size, borderRadius: size / 2 }) as const;

  return (
    <View
      style={{ width: ORB, height: ORB, alignItems: "center", justifyContent: "center" }}
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[circle(ORB), animation(look.halo, "alternate")]}>
        {/* A plain View: Reanimated's Animated.View drops experimental_backgroundImage on Android. */}
        <View
          style={{
            ...circle(ORB),
            experimental_backgroundImage: `radial-gradient(circle, rgba(${look.rgb}, 0.6) 0%, rgba(${look.rgb}, 0.22) 42%, rgba(${look.rgb}, 0) 70%)`,
          }}
        />
      </Animated.View>
      {props.look === "speaking" ? (
        <Animated.View
          style={[
            circle(CORE),
            { borderWidth: 3, borderColor: `rgb(${look.rgb})` },
            animation(RIPPLE, "normal"),
          ]}
        />
      ) : null}
      <Animated.View
        style={[
          circle(CORE),
          { backgroundColor: `rgb(${look.rgb})` },
          animation(look.core, "alternate"),
        ]}
      >
        <View
          style={{
            ...circle(CORE),
            experimental_backgroundImage:
              "radial-gradient(circle at 38% 32%, rgba(255, 255, 255, 0.55) 0%, rgba(255, 255, 255, 0) 60%)",
          }}
        />
      </Animated.View>
    </View>
  );
}

/** Light navigation bar buttons over the dark call, whatever the app theme. */
function useDarkNavigationBar() {
  const { themeAppearance } = useAppearancePreferences();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the Android navigation bar is outside React; the theme's style comes back when the call screen closes
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const controls = requireNativeModule<{
      setNavigationBarStyle(light: boolean): Promise<void>;
    }>("T3NativeControls");
    void controls.setNavigationBarStyle(false);
    return () => void controls.setNavigationBarStyle(themeAppearance === "light");
  }, [themeAppearance]);
}
