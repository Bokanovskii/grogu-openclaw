# Local voice input

This plugin transcribes a deliberate recording with an installed whisper.cpp executable and model.
It uses the existing browser microphone and Gateway transcription relay.
It sends no audio to a hosted provider and starts no reasoning model.
Sparky receives only the transcript that the user edits and sends.

Install this plugin only from a retained source or release directory.
Use the existing plugin installer after the operator approves the live cutover.
The plugin needs the matching Gateway and Control UI changes in this branch.
It cannot run against the older installed relay contract.

```sh
openclaw plugins install --link /absolute/path/to/grogu/plugins/grogu-local-voice
```

Configure both paths explicitly under `plugins.entries.grogu-local-voice.config`.
Use an already installed `whisper-cli` executable and a readable GGML model.
The plugin does not find, install, or download either file.
Enable the plugin through the normal plugin configuration owner.

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

This plugin does not change TTS, the system browser, login state, or startup registration.
The existing `tts-local-cli` provider can provide optional speech playback.
Changing its voice or enabling automatic playback is a separate operator action.
