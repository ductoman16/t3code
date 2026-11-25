import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

vi.mock("expo-secure-store", () => ({}));

import { androidVoice } from "../features/voice-mode/androidSpeaker";
import {
  MobilePreferencesStore,
  layer as preferencesLayer,
  voiceModeReadingSpeed,
} from "./mobile-preferences";
import { MobileSecureStorage } from "./mobile-secure-storage";
import * as MobileDatabase from "./mobile-database";

describe("mobile database", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  async function sqliteDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.gen(function* () {
      yield* Effect.promise(sqliteDatabase);
      const database = yield* MobileDatabase.make;
      yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
      yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
      expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
        Option.some('{"entries":[]}'),
      );
      yield* database.clearEnvironmentCache(environmentId);
      expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
        "None",
      );
      expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
        "Some",
      );
    }),
  );

  it.effect(
    "uses the saved voice speed for speech and defaults for invalid or missing values",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        const preferences = yield* MobilePreferencesStore.pipe(
          Effect.provide(
            preferencesLayer.pipe(
              Layer.provide(Layer.succeed(MobileDatabase.MobileDatabase, database)),
              Layer.provide(
                Layer.succeed(MobileSecureStorage, {
                  getItem: () => Effect.succeed(null),
                  setItem: () => Effect.void,
                  removeItem: () => Effect.void,
                }),
              ),
            ),
          ),
        );
        let loaded = yield* preferences.load;
        const rates: number[] = [];
        const voice = androidVoice(
          {
            prepareVoice: async () => {},
            say: (_id, _text, rate) => rates.push(rate),
            stopSpeaking: () => {},
            shutDownVoice: () => {},
          },
          () => voiceModeReadingSpeed(loaded),
        );

        voice.say("missing", "Default speed.");
        yield* preferences.savePatch({ voiceModeSpeed: 1.4 });
        loaded = yield* preferences.load;
        expect(loaded.voiceModeSpeed).toBe(1.4);
        voice.say("saved", "Selected speed.");

        yield* database.savePreferencesJson('{"voiceModeSpeed":1.6}', 1);
        loaded = yield* preferences.load;
        expect(loaded.voiceModeSpeed).toBeUndefined();
        voice.say("invalid", "Default speed again.");

        expect(rates).toEqual([1.1, 1.4, 1.1]);
      }),
  );
});
