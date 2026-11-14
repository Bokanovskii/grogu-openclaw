# Local voice input

This plugin transcribes a deliberate recording with an installed whisper.cpp executable and model.
It uses the existing browser microphone and Gateway transcription relay.
It sends no audio to a hosted provider and starts no reasoning model.
Sparky receives only the transcript that the user edits and sends.

OpenClaw 2026.10.7 has the Gateway relay and Control UI support that this plugin needs.
Plugin bootstrap does not set up this plugin.
Repeat the steps below on each new host, or the dashboard microphone reports that dictation is unavailable.

## Build whisper-cli

The plugin does not find, install, or download `whisper-cli` or a model.
This build pins whisper.cpp `v1.9.5` at commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`.
It needs Xcode Command Line Tools, `git`, and CMake.
If CMake is missing, `uv tool run --from cmake==3.31.6 cmake` runs a pinned copy without a system install.

```sh
set -euo pipefail
TAG=v1.9.5
COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
ROOT="$HOME/.local/share/whisper.cpp"
WORK="$(mktemp -d)"
git -c advice.detachedHead=false clone --depth 1 --branch "$TAG" \
  https://github.com/ggml-org/whisper.cpp.git "$WORK/src"
test "$(git -C "$WORK/src" rev-parse HEAD)" = "$COMMIT"
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
cmake --build "$WORK/build" --config Release --target whisper-cli
install -d "$ROOT/$TAG/bin"
install -m 0755 "$WORK/build/bin/whisper-cli" "$ROOT/$TAG/bin/whisper-cli"
rm -rf "$WORK"
```

The static Metal build needs no Homebrew libraries.
`otool -L` on the result lists only system libraries and frameworks.

## Choose a model

Download one English model and check it against the SHA-1 in the whisper.cpp `models/README.md` of the same tag.
`small.en` is the recommended default.

```sh
MODELS="$HOME/.local/share/whisper-models"
mkdir -p "$MODELS"
curl -fL -o "$MODELS/ggml-small.en.bin" \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
echo "db8a495a91d927739e50b3fc1cc4c6b8f6c2d022  $MODELS/ggml-small.en.bin" | shasum -a 1 -c -
```

These numbers come from one Apple M4 Mac mini with 16 GB of memory.
Each run used the plugin's `whisper-cli -np -nt` arguments on an 11-second and a 55-second English clip.

| Model                 | SHA-1                                      | File   | 11 s clip | 55 s clip | Peak memory |
| --------------------- | ------------------------------------------ | ------ | --------- | --------- | ----------- |
| `base.en`             | `137c40403d78fd54d454da0f9bd998f78703390c` | 148 MB | 0.25 s    | 0.65 s    | 390 MB      |
| `small.en`            | `db8a495a91d927739e50b3fc1cc4c6b8f6c2d022` | 488 MB | 0.6 s     | 1.4 s     | 870 MB      |
| `large-v3-turbo-q5_0` | `e050f7970618a659205450ad97eb95a18d69c9ee` | 574 MB | 1.3 s     | 2.6 s     | 850 MB      |

## Memory use

No speech model stays loaded.
While you record, the Gateway keeps only the compressed audio in memory, at most 960 KB.
After Stop, the plugin starts one `whisper-cli` process.
That process loads the model, writes the transcript, and exits.
Its memory returns to the system when it exits.
With `small.en`, one Stop uses about 870 MB for one to two seconds.
Two dictations at the same time can use about 1.7 GB.

## Install and enable

Copy the plugin directory to a retained, owner-only location that names its source commit.
A later checkout change then cannot change the running plugin.
Install it disabled, so it stays off until both paths are set.
`--force` acknowledges a local source that does not come from ClawHub.

```sh
openclaw plugins install --link --force --no-enable /absolute/path/to/grogu-local-voice
```

Configure both paths explicitly under `plugins.entries.grogu-local-voice.config`.
If `plugins.allow` exists, add `grogu-local-voice` to it.
Apply the change with `openclaw config patch --stdin --dry-run`, then without `--dry-run`.
A patch replaces each array as a whole, so include every existing `plugins.allow` entry.
Plugin configuration changes reload without a Gateway restart.

```json5
{
  plugins: {
    entries: {
      "grogu-local-voice": {
        enabled: true,
        config: {
          command: "/absolute/path/to/whisper-cli",
          modelPath: "/absolute/path/to/ggml-model.bin",
        },
      },
    },
  },
}
```

Check the result with `openclaw gateway call talk.catalog --json`.
Expect `transcription.ready: true` and `transcription.activeProvider: "grogu-local-voice"`.
The dashboard rereads this catalog when its window gains focus.
Make sure that `talk.catalog.transcription.providers` lists only the intended configured provider.
The composer uses normal transcription selection, not a plugin-specific microphone route.
If other transcription providers are enabled, select this provider through the existing voice-call streaming configuration owner.
Do not enable a hosted provider as a fallback.

Tap the microphone, speak, and select Stop and keep text.
Wait for Finishing dictation to end.
Edit the transcript and select Send.
The transcript stays in the same chat draft until that explicit send.

The browser sends G.711 mu-law audio at 8 kHz.
The plugin uses the existing audio codec to produce mono PCM at 16 kHz.
It gives whisper.cpp one temporary WAV file after Stop.
It emits a final transcript, not live partial text.
It removes the temporary recording when the process settles.

Recordings are limited to two minutes.
At most two transcription processes run at once.
Final processing and shutdown have a two-minute budget.
Silence produces no transcript and a visible browser notice.
Cancellation and connection loss discard audio and stop active processing.
Errors stay visible and never switch to another provider.

To turn dictation off, set `plugins.entries.grogu-local-voice.enabled` to `false`.
`openclaw plugins uninstall grogu-local-voice` removes the plugin record.
Neither step deletes `whisper-cli` or the model file.

This plugin does not change TTS, the system browser, login state, or startup registration.
The existing `tts-local-cli` provider can provide optional speech playback.
Changing its voice or enabling automatic playback is a separate operator action.
