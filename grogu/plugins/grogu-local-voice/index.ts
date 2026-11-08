import { accessSync, constants, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription-session";

const SAMPLE_RATE = 8000;
const MAX_RECORDING_BYTES = SAMPLE_RATE * 120;
const FINALIZATION_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT_TRANSCRIPTIONS = 2;

function readConfig(config: unknown): { command: string; modelPath: string } {
  if (
    !config ||
    typeof config !== "object" ||
    !("command" in config) ||
    typeof config.command !== "string" ||
    !path.isAbsolute(config.command) ||
    !("modelPath" in config) ||
    typeof config.modelPath !== "string" ||
    !path.isAbsolute(config.modelPath)
  ) {
    throw new Error("Local voice needs absolute paths to an installed whisper-cli and GGML model.");
  }
  return { command: config.command, modelPath: config.modelPath };
}

function isInstalled(config: ReturnType<typeof readConfig>): boolean {
  try {
    accessSync(config.command, constants.X_OK);
    accessSync(config.modelPath, constants.R_OK);
    return statSync(config.command).isFile() && statSync(config.modelPath).isFile();
  } catch {
    return false;
  }
}

function wavFromPcm(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createLocalVoiceProvider(
  pluginConfig: unknown,
): RealtimeTranscriptionProviderPlugin {
  const config = readConfig(pluginConfig);
  let running = 0;
  return {
    id: "grogu-local-voice",
    label: "Local whisper.cpp",
    isConfigured: () => isInstalled(config),
    createSession(
      request: RealtimeTranscriptionSessionCreateRequest,
    ): RealtimeTranscriptionSession {
      const cancellation = new AbortController();
      const chunks: Buffer[] = [];
      let bytes = 0;
      let connected = false;
      let finishing = false;
      let completion: Promise<void> | undefined;

      const transcribe = async () => {
        if (cancellation.signal.aborted) {
          return;
        }
        if (running >= MAX_CONCURRENT_TRANSCRIPTIONS) {
          throw new Error(
            "Local transcription is busy. Try again after the other recording finishes.",
          );
        }
        running++;
        try {
          const { isRealtimeVoiceAudioAudible, mulawToPcm, resamplePcm } =
            await import("openclaw/plugin-sdk/realtime-voice-provider");
          const audio = Buffer.concat(chunks, bytes);
          chunks.length = 0;
          bytes = 0;
          if (
            cancellation.signal.aborted ||
            !isRealtimeVoiceAudioAudible(audio, {
              encoding: "g711_ulaw",
              sampleRateHz: SAMPLE_RATE,
              channels: 1,
            })
          ) {
            return;
          }
          const { resolvePreferredOpenClawTmpDir, withTempWorkspace } =
            await import("openclaw/plugin-sdk/temp-path");
          const { runCommandBuffered } = await import("openclaw/plugin-sdk/process-runtime");
          await withTempWorkspace(
            { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "grogu-dictation-" },
            async (workspace) => {
              const inputPath = path.join(workspace.dir, "recording.wav");
              await writeFile(
                inputPath,
                wavFromPcm(resamplePcm(mulawToPcm(audio), SAMPLE_RATE, 16_000)),
                {
                  mode: 0o600,
                },
              );
              if (cancellation.signal.aborted) {
                return;
              }
              const result = await runCommandBuffered(
                [config.command, "-m", config.modelPath, "-f", inputPath, "-np", "-nt"],
                {
                  signal: cancellation.signal,
                  timeoutMs: FINALIZATION_TIMEOUT_MS - 5_000,
                  maxOutputBytes: { stdout: 256 * 1024, stderr: 1024 * 1024 },
                },
              );
              if (cancellation.signal.aborted) {
                return;
              }
              if (result.termination !== "exit" || result.code !== 0) {
                throw new Error(
                  `Local transcription failed (${result.termination}, exit ${result.code}). Check the installed whisper-cli and model.`,
                );
              }
              const transcript = result.stdout.toString("utf8").trim();
              if (transcript) {
                request.onTranscript?.(transcript);
              }
            },
          );
        } finally {
          running--;
          chunks.length = 0;
          bytes = 0;
        }
      };

      return {
        finalizationTimeoutMs: FINALIZATION_TIMEOUT_MS,
        async connect() {
          if (!isInstalled(config)) {
            throw new Error(
              "Local voice could not read the installed whisper-cli or model. Check both paths.",
            );
          }
          connected = !cancellation.signal.aborted;
        },
        isConnected: () => connected && !finishing && !cancellation.signal.aborted,
        sendAudio(audio) {
          if (!connected || finishing || cancellation.signal.aborted) {
            throw new Error("Local transcription is not accepting audio.");
          }
          if (bytes + audio.length > MAX_RECORDING_BYTES) {
            throw new Error(
              "Local dictation is limited to two minutes. Stop and start a new recording.",
            );
          }
          chunks.push(Buffer.from(audio));
          bytes += audio.length;
        },
        finish() {
          finishing = true;
          completion ??= transcribe();
          return completion;
        },
        close() {
          connected = false;
          cancellation.abort();
          chunks.length = 0;
          bytes = 0;
        },
      };
    },
  };
}

export default definePluginEntry({
  id: "grogu-local-voice",
  name: "Grogu Local Voice",
  description: "Local, final-only composer transcription with whisper.cpp.",
  register(api) {
    api.registerRealtimeTranscriptionProvider(createLocalVoiceProvider(api.pluginConfig));
  },
});
