import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { summarizeGroguDigest } from "./digest.mjs";

export default definePluginEntry({
  id: "grogu-digest",
  name: "Grogu Deterministic Digest",
  description: "Deterministic, model-free transcript compaction for Grogu.",
  register(api) {
    api.registerCompactionProvider({
      id: "grogu-digest",
      label: "Grogu deterministic digest",
      summarize: summarizeGroguDigest,
    });
  },
});
