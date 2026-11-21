import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("OCSTOR1\n");
const STORAGE_SEGMENT_BYTES = 1048576;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 1024;
const VALUE_MAGIC = Buffer.from("OCSEAL1\n");
const VALUE_NONCE_BYTES = 12;
const VALUE_KEY_BYTES = 32;
const VALUE_HEADER_BYTES = VALUE_MAGIC.length + VALUE_NONCE_BYTES * 2 + VALUE_KEY_BYTES + TAG_BYTES;
const VALUE_OVERHEAD_BYTES = VALUE_HEADER_BYTES + TAG_BYTES;

export type StorageValueEncryption = {
  encrypt(value: Buffer, context: string): Buffer;
  decrypt(value: Buffer, context: string): Buffer;
  storedSize(plaintextBytes: number): number;
  plaintextSize(storedBytes: number): number;
  dispose(): void;
};

function sealValue(value: Buffer, key: Buffer, iv: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()]);
}

function openValue(value: Buffer, key: Buffer, iv: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(value.subarray(-TAG_BYTES));
  return Buffer.concat([decipher.update(value.subarray(0, -TAG_BYTES)), decipher.final()]);
}

/** Each bounded value has a fresh data key; its caller-owned context binds both key and content. */
export function createStorageValueEncryption(masterKey: Buffer): StorageValueEncryption {
  if (masterKey.length !== VALUE_KEY_BYTES) {
    throw new Error("Storage encryption requires a 32-byte key.");
  }
  const key = Buffer.from(masterKey);
  let disposed = false;
  const contextBytes = (context: string) => {
    if (disposed) {
      throw new Error("Storage encryption is closed.");
    }
    if (!context || Buffer.byteLength(context) > MAX_HEADER_BYTES) {
      throw new Error("Storage encryption requires a bounded owner context.");
    }
    return Buffer.from(context, "utf8");
  };
  const storedSize = (plaintextBytes: number) => {
    if (
      !Number.isSafeInteger(plaintextBytes) ||
      plaintextBytes < 0 ||
      plaintextBytes > Number.MAX_SAFE_INTEGER - VALUE_OVERHEAD_BYTES
    ) {
      throw new Error("Storage size must be a nonnegative safe integer.");
    }
    return plaintextBytes + VALUE_OVERHEAD_BYTES;
  };
  const plaintextSize = (storedBytes: number) => {
    if (!Number.isSafeInteger(storedBytes) || storedBytes < VALUE_OVERHEAD_BYTES) {
      throw new Error("Truncated encrypted storage value.");
    }
    return storedBytes - VALUE_OVERHEAD_BYTES;
  };
  return {
    encrypt(value, context) {
      const owner = contextBytes(context);
      storedSize(value.length);
      const dataKey = randomBytes(VALUE_KEY_BYTES);
      try {
        const keyNonce = randomBytes(VALUE_NONCE_BYTES);
        const dataNonce = randomBytes(VALUE_NONCE_BYTES);
        const wrappedKey = sealValue(dataKey, key, keyNonce, Buffer.concat([VALUE_MAGIC, owner]));
        const header = Buffer.concat([VALUE_MAGIC, keyNonce, wrappedKey, dataNonce]);
        return Buffer.concat([
          header,
          sealValue(value, dataKey, dataNonce, Buffer.concat([header, owner])),
        ]);
      } finally {
        dataKey.fill(0);
      }
    },
    decrypt(value, context) {
      const owner = contextBytes(context);
      plaintextSize(value.length);
      if (!value.subarray(0, VALUE_MAGIC.length).equals(VALUE_MAGIC)) {
        throw new Error("Invalid encrypted storage value.");
      }
      const nonceEnd = VALUE_MAGIC.length + VALUE_NONCE_BYTES;
      const keyEnd = nonceEnd + VALUE_KEY_BYTES + TAG_BYTES;
      const dataKey = openValue(
        value.subarray(nonceEnd, keyEnd),
        key,
        value.subarray(VALUE_MAGIC.length, nonceEnd),
        Buffer.concat([VALUE_MAGIC, owner]),
      );
      try {
        return openValue(
          value.subarray(VALUE_HEADER_BYTES),
          dataKey,
          value.subarray(keyEnd, VALUE_HEADER_BYTES),
          Buffer.concat([value.subarray(0, VALUE_HEADER_BYTES), owner]),
        );
      } finally {
        dataKey.fill(0);
      }
    },
    storedSize,
    plaintextSize,
    dispose() {
      disposed = true;
      key.fill(0);
    },
  };
}

/** Reads only the requested bounded window, even when the upstream chunks are uneven. */
class StreamReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array();
  private offset = 0;
  constructor(body: AsyncIterable<Uint8Array>) {
    this.iterator = body[Symbol.asyncIterator]();
  }
  async read(maxBytes: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(maxBytes);
    let used = 0;
    while (used < maxBytes) {
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next();
        if (next.done) {
          break;
        }
        this.chunk = next.value;
        this.offset = 0;
        if (this.chunk.length === 0) {
          continue;
        }
      }
      const count = Math.min(maxBytes - used, this.chunk.length - this.offset);
      result.set(this.chunk.subarray(this.offset, this.offset + count), used);
      used += count;
      this.offset += count;
    }
    return result.subarray(0, used);
  }
  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

function headerBytes(objSalt: Buffer, noncePrefix: Buffer): Buffer {
  const json = Buffer.from(
    JSON.stringify({
      v: 1,
      objSalt: objSalt.toString("base64"),
      noncePrefix: noncePrefix.toString("base64"),
      segmentBytes: STORAGE_SEGMENT_BYTES,
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json]);
}

const HEADER_BYTES = headerBytes(Buffer.alloc(32), Buffer.alloc(7)).length;

export function encryptedStorageSize(plaintextBytes: number): number {
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0) {
    throw new Error("Storage size must be a nonnegative safe integer.");
  }
  const segments = Math.floor(plaintextBytes / STORAGE_SEGMENT_BYTES) + 1;
  if (segments > 0x100000000) {
    throw new Error("Storage object exceeds the encryption segment limit.");
  }
  return HEADER_BYTES + plaintextBytes + segments * TAG_BYTES;
}

function nonce(prefix: Buffer, index: number, last: boolean): Buffer {
  if (index > 0xffffffff) {
    throw new Error("Storage object exceeds the encryption segment limit.");
  }
  const value = Buffer.alloc(12);
  prefix.copy(value);
  value.writeUInt32BE(index, 7);
  value[11] = last ? 1 : 0;
  return value;
}

export async function* encryptStorageObject(
  body: AsyncIterable<Uint8Array>,
  masterKey: Buffer,
): AsyncGenerator<Uint8Array> {
  const salt = randomBytes(32);
  const prefix = randomBytes(7);
  const header = headerBytes(salt, prefix);
  const key = Buffer.from(hkdfSync("sha256", masterKey, salt, "openclaw-storage v1 object", 32));
  const reader = new StreamReader(body);
  try {
    yield header;
    for (let index = 0; ; index++) {
      const plaintext = await reader.read(STORAGE_SEGMENT_BYTES);
      // Exact multiples end with an authenticated empty final segment.
      const last = plaintext.length < STORAGE_SEGMENT_BYTES;
      const cipher = createCipheriv("aes-256-gcm", key, nonce(prefix, index, last));
      cipher.setAAD(header);
      yield Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      if (last) {
        break;
      }
    }
  } finally {
    key.fill(0);
    await reader.close();
  }
}

function decodeBase64(value: unknown, size: number): Buffer {
  if (typeof value !== "string") {
    throw new Error("Invalid storage encryption header.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== size || decoded.toString("base64") !== value) {
    throw new Error("Invalid storage encryption header.");
  }
  return decoded;
}

async function readHeader(reader: StreamReader) {
  const preamble = await reader.read(MAGIC.length + 4);
  if (preamble.length !== MAGIC.length + 4 || !preamble.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Invalid storage encryption magic.");
  }
  const length = preamble.readUInt32BE(MAGIC.length);
  if (length === 0 || length > MAX_HEADER_BYTES) {
    throw new Error("Invalid storage encryption header length.");
  }
  const json = await reader.read(length);
  if (json.length !== length) {
    throw new Error("Truncated storage encryption header.");
  }
  const value: unknown = JSON.parse(json.toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !("v" in value) ||
    value.v !== 1 ||
    !("segmentBytes" in value) ||
    value.segmentBytes !== STORAGE_SEGMENT_BYTES ||
    !("objSalt" in value) ||
    !("noncePrefix" in value)
  ) {
    throw new Error("Unsupported storage encryption header.");
  }
  return {
    header: Buffer.concat([preamble, json]),
    salt: decodeBase64(value.objSalt, 32),
    prefix: decodeBase64(value.noncePrefix, 7),
  };
}

export async function* decryptStorageObject(
  body: AsyncIterable<Uint8Array>,
  masterKey: Buffer,
): AsyncGenerator<Uint8Array> {
  const reader = new StreamReader(body);
  let key: Buffer | undefined;
  try {
    const { header, salt, prefix } = await readHeader(reader);
    key = Buffer.from(hkdfSync("sha256", masterKey, salt, "openclaw-storage v1 object", 32));
    for (let index = 0; ; index++) {
      const segment = await reader.read(STORAGE_SEGMENT_BYTES + TAG_BYTES);
      if (segment.length < TAG_BYTES) {
        throw new Error("Truncated storage object: missing final segment.");
      }
      const last = segment.length < STORAGE_SEGMENT_BYTES + TAG_BYTES;
      const decipher = createDecipheriv("aes-256-gcm", key, nonce(prefix, index, last));
      decipher.setAAD(header);
      decipher.setAuthTag(segment.subarray(-TAG_BYTES));
      const plaintext = Buffer.concat([
        decipher.update(segment.subarray(0, -TAG_BYTES)),
        decipher.final(),
      ]);
      if (plaintext.length > 0) {
        yield plaintext;
      }
      if (last) {
        return;
      }
    }
  } finally {
    key?.fill(0);
    await reader.close();
  }
}

/** The fixed v1 header and segment tags make plaintext size a metadata-only calculation. */
export function plaintextStorageSize(storedBytes: number): number {
  if (!Number.isSafeInteger(storedBytes) || storedBytes < 0) {
    throw new Error("Storage size must be a nonnegative safe integer.");
  }
  const payloadBytes = storedBytes - HEADER_BYTES;
  const complete = Math.floor(payloadBytes / (STORAGE_SEGMENT_BYTES + TAG_BYTES));
  const finalBytes = payloadBytes % (STORAGE_SEGMENT_BYTES + TAG_BYTES);
  if (payloadBytes < TAG_BYTES || finalBytes < TAG_BYTES) {
    throw new Error("Truncated storage object: missing final segment.");
  }
  if (complete + 1 > 0x100000000) {
    throw new Error("Storage object exceeds the encryption segment limit.");
  }
  return payloadBytes - (complete + 1) * TAG_BYTES;
}
