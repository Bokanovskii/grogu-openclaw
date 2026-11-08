import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalVoiceProvider } from "../../grogu/plugins/grogu-local-voice/index.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function installedCli(body: string) {
  const directory = tempDirs.make("grogu-local-voice-");
  const command = path.join(directory, "whisper-cli");
  const modelPath = path.join(directory, "model.bin");
  const receipt = path.join(directory, "input-path");
  fs.writeFileSync(modelPath, "synthetic model fixture");
  fs.writeFileSync(
    command,
    `#!${process.execPath}
import fs from "node:fs";
import assert from "node:assert/strict";
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 2), ["-m", ${JSON.stringify(modelPath)}]);
assert.deepEqual(args.slice(4), ["-np", "-nt"]);
assert.equal(args[2], "-f");
const inputPath = args[3];
const audio = fs.readFileSync(inputPath);
assert.equal(audio.toString("ascii", 0, 4), "RIFF");
assert.equal(audio.toString("ascii", 8, 16), "WAVEfmt ");
assert.equal(audio.readUInt16LE(20), 1);
assert.equal(audio.readUInt16LE(22), 1);
assert.equal(audio.readUInt32LE(24), 16000);
assert.equal(audio.readUInt16LE(34), 16);
assert.equal(audio.readUInt32LE(40), audio.length - 44);
fs.appendFileSync(${JSON.stringify(receipt)}, inputPath + "\\n");
${body}
`,
    { mode: 0o700 },
  );
  return { provider: createLocalVoiceProvider({ command, modelPath }), receipt, modelPath };
}

describe("Grogu local transcription", () => {
  it("runs the installed CLI with browser audio and removes its private recording", async () => {
    const { provider, receipt } = installedCli(`
assert.equal(audio.length, 56);
console.log("Please check the calendar.");
`);
    const onTranscript = vi.fn();
    const session = provider.createSession({ providerConfig: {}, onTranscript });
    expect(provider.isConfigured({ providerConfig: {} })).toBe(true);
    await session.connect();
    session.sendAudio(Buffer.from([0xff, 0x80, 0x00]));
    await session.finish?.();

    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Please check the calendar.");
    expect(session.isConnected()).toBe(false);
    const recordingPath = fs.readFileSync(receipt, "utf8").trim();
    expect(fs.existsSync(recordingPath)).toBe(false);
    await session.finish?.();
    expect(onTranscript).toHaveBeenCalledOnce();
    session.close();
  });

  it("keeps simultaneous recordings separate and rejects audio after Stop", async () => {
    const { provider, receipt } = installedCli(`
console.log(audio.readInt16LE(44) > 0 ? "First recording." : "Second recording.");
`);
    const firstTranscript = vi.fn();
    const secondTranscript = vi.fn();
    const first = provider.createSession({ providerConfig: {}, onTranscript: firstTranscript });
    const second = provider.createSession({ providerConfig: {}, onTranscript: secondTranscript });
    await Promise.all([first.connect(), second.connect()]);
    first.sendAudio(Buffer.from([0x80]));
    second.sendAudio(Buffer.from([0x00]));
    const completion = Promise.all([first.finish?.(), second.finish?.()]);
    expect(() => first.sendAudio(Buffer.from([0x80]))).toThrow("not accepting audio");
    await completion;

    expect(firstTranscript).toHaveBeenCalledExactlyOnceWith("First recording.");
    expect(secondTranscript).toHaveBeenCalledExactlyOnceWith("Second recording.");
    const recordings = fs.readFileSync(receipt, "utf8").trim().split("\n");
    expect(new Set(recordings).size).toBe(2);
    expect(recordings.every((file) => !fs.existsSync(file))).toBe(true);
    first.close();
    second.close();
  });

  it.each(["silence", "discard"] as const)("does not start a process for %s", async (action) => {
    const { provider, receipt } = installedCli(`throw new Error("must not run");`);
    const onTranscript = vi.fn();
    const session = provider.createSession({ providerConfig: {}, onTranscript });
    await session.connect();
    session.sendAudio(Buffer.from([action === "silence" ? 0xff : 0x80]));
    if (action === "discard") {
      session.close();
    }
    await session.finish?.();
    expect(fs.existsSync(receipt)).toBe(false);
    expect(onTranscript).not.toHaveBeenCalled();
    session.close();
  });

  it("aborts active processing and removes its recording without a late transcript", async () => {
    const { provider, receipt, modelPath } = installedCli("fs.watch(args[1], () => {});");
    const onTranscript = vi.fn();
    const session = provider.createSession({ providerConfig: {}, onTranscript });
    const directory = path.dirname(receipt);
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const watcher = fs.watch(directory, (_event, name) => {
      if (name === path.basename(receipt) && fs.existsSync(receipt)) {
        ready();
      }
    });
    await session.connect();
    session.sendAudio(Buffer.from([0x80]));
    const completion = session.finish?.();
    try {
      await Promise.race([
        started,
        completion?.then(() => {
          throw new Error("Fixture exited before cancellation.");
        }),
      ]);
    } finally {
      watcher.close();
      session.close();
      await completion;
    }
    expect(session.isConnected()).toBe(false);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(fs.existsSync(fs.readFileSync(receipt, "utf8").trim())).toBe(false);
    expect(fs.existsSync(modelPath)).toBe(true);
  });

  it("reports missing installation and process failure without another provider", async () => {
    const { provider, receipt, modelPath } = installedCli("process.exitCode = 3;");
    const session = provider.createSession({ providerConfig: {} });
    await session.connect();
    session.sendAudio(Buffer.from([0x80]));
    await expect(session.finish?.()).rejects.toThrow("exit 3");
    expect(fs.existsSync(fs.readFileSync(receipt, "utf8").trim())).toBe(false);
    session.close();
    fs.unlinkSync(modelPath);
    expect(provider.isConfigured({ providerConfig: {} })).toBe(false);
    await expect(provider.createSession({ providerConfig: {} }).connect()).rejects.toThrow(
      "Check both paths",
    );
  });
});
