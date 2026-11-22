import type { ProtectedProfileIcon } from "@openclaw/gateway-protocol/protected";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readImageProbeFromHeader } from "../../src/media/image-ops.js";
import {
  MAX_USER_PROFILE_AVATAR_BYTES,
  USER_PROFILE_AVATAR_MIME_TYPES,
} from "../../src/shared/avatar-limits.js";
import type { UserProfileAvatarMime } from "../../src/state/user-profiles.types.js";

// The selection lives in canonical preferences; image bytes stay in profile avatar storage.
export const iconPreference = "grogu.protected.icon";
export const maxIconBytes = MAX_USER_PROFILE_AVATAR_BYTES;
const maxIconSide = 4096;
const revisionPattern = /^[a-f0-9]{64}-(?:png|jpeg|webp)$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiPart = /^[\p{Extended_Pictographic}\p{Emoji_Component}]$/u;
const emojiJoiners = new Set(["\u200D", "\uFE0F", "\u20E3"]);
const probeFormats: Record<UserProfileAvatarMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

export type StoredIcon = { kind: "emoji"; emoji: string } | { kind: "image"; revision: string };

/** Accept exactly one emoji grapheme, including flags, keycaps, ZWJ sequences, and skin tones. */
export function isSingleEmoji(value: string) {
  return (
    value.length > 0 &&
    value.length <= 32 &&
    [...graphemes.segment(value)].length === 1 &&
    [...value].every((char) => emojiPart.test(char) || emojiJoiners.has(char)) &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|\u20E3/u.test(value)
  );
}

export function parseStoredIcon(value: unknown): StoredIcon | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "emoji" && typeof value.emoji === "string" && isSingleEmoji(value.emoji)) {
    return { kind: "emoji", emoji: value.emoji };
  }
  if (
    value.kind === "image" &&
    typeof value.revision === "string" &&
    revisionPattern.test(value.revision)
  ) {
    return { kind: "image", revision: value.revision };
  }
  return null;
}

export function projectIcon(profileId: string, value: unknown): ProtectedProfileIcon | null {
  const icon = parseStoredIcon(value);
  if (icon?.kind === "image") {
    return {
      kind: "image",
      url: `/api/protected/v1/people/${encodeURIComponent(profileId)}/icon?v=${icon.revision}`,
    };
  }
  return icon;
}

export function iconImageMime(contentType: string | null): UserProfileAvatarMime | undefined {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  return USER_PROFILE_AVATAR_MIME_TYPES.find((candidate) => candidate === mime);
}

/** The header must probe as the declared raster format with bounded dimensions. */
export function isIconImage(bytes: Buffer, mime: UserProfileAvatarMime) {
  const probe = readImageProbeFromHeader(bytes);
  return (
    probe?.format === probeFormats[mime] &&
    probe.width > 0 &&
    probe.height > 0 &&
    probe.width <= maxIconSide &&
    probe.height <= maxIconSide
  );
}
