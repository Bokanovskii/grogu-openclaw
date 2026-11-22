import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { readResponseWithLimit } from "../../src/infra/http-response-body.js";
import { registerSecretValueForRedaction } from "../../src/logging/secret-redaction-registry.js";
import { operateUserConnector } from "../../src/state/user-connectors.js";
import {
  gmailReadOnlyScope,
  type UserConnector,
  type UserConnectorKind,
  type UserGmailConnector,
} from "../../src/state/user-connectors.types.js";
import { ProtectedError } from "./errors.js";

export type ProtectedConnectorAuthority = {
  profileId: string;
  /** The caller must check the configured Alcove owner and the exact current profile grant. */
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
};
type GoogleClient = UserGmailConnector["client"];
const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(8192).optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive().max(86400),
  scope: z.literal(gmailReadOnlyScope).optional(),
});

function unavailable(message: string): never {
  throw new ProtectedError(409, "connector_unavailable", message);
}
function invalid(): never {
  throw new ProtectedError(400, "invalid_connector_request", "Enter valid connector details.");
}
function calendarUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== "https:" ||
    !/^(?:caldav|p[0-9]{2,3}-caldav)\.icloud\.com$/u.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    return invalid();
  }
  return url;
}

/** Private credentials stay here. Dispatch receives only the fixed read operations below. */
export function createProtectedConnectors(options: {
  stateDir: string;
  authority: ProtectedConnectorAuthority;
  googleClient?: GoogleClient;
  fetchImpl?: typeof fetch;
}) {
  const { authority } = options;
  const env = { OPENCLAW_STATE_DIR: options.stateDir };
  const fetchImpl = options.fetchImpl ?? fetch;
  const read = (kind: UserConnectorKind) =>
    operateUserConnector(
      { action: "read", kind, profileId: authority.profileId },
      {
        env,
        assertCurrent: authority.assertCurrent,
      },
    );
  const replace = (connector: UserConnector, expectedGeneration: string | null) =>
    operateUserConnector(
      {
        action: "replace",
        kind: connector.kind,
        profileId: authority.profileId,
        connector,
        expectedGeneration,
      },
      { env, assertCurrent: authority.assertCurrent },
    );
  const current = async (kind: UserConnectorKind, generation: string) => {
    await authority.revalidate();
    authority.assertCurrent();
    if ((await read(kind))?.generation !== generation) {
      unavailable("Connector changed. Reconnect and try again.");
    }
    authority.assertCurrent();
  };
  const request = async (url: string | URL, init: RequestInit, maxBytes = 256 * 1024) => {
    authority.assertCurrent();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Fetch errors can contain authorization headers. Do not propagate their cause.
      unavailable("Connector request failed. Check the connection and try again.");
    }
    authority.assertCurrent();
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      unavailable("Connector redirected to another endpoint. Reconnect and try again.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      unavailable(`Connector returned HTTP ${response.status}. Reconnect and try again.`);
    }
    if (
      (init.method === "PROPFIND" || init.method === "REPORT") &&
      (response.status !== 207 || !response.headers.get("content-type")?.includes("xml"))
    ) {
      await response.body?.cancel();
      unavailable("Calendar returned an invalid CalDAV response. Connect Calendar again.");
    }
    const result = await readResponseWithLimit(response, maxBytes, { timeoutMs: 30_000 });
    authority.assertCurrent();
    return result.toString("utf8");
  };
  const jsonRequest = async (url: string, init: RequestInit): Promise<unknown> => {
    const text = await request(url, init);
    try {
      return JSON.parse(text);
    } catch {
      unavailable("Connector returned invalid JSON. Try again.");
    }
  };
  const token = async (client: GoogleClient, fields: Record<string, string>) => {
    const raw = await jsonRequest("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        ...fields,
      }),
    });
    const parsed = tokenSchema.safeParse(raw);
    if (!parsed.success) {
      unavailable("Google returned invalid credentials. Connect Gmail again.");
    }
    const tokens = parsed.data;
    registerSecretValueForRedaction(tokens.access_token);
    if (tokens.refresh_token) {
      registerSecretValueForRedaction(tokens.refresh_token);
    }
    // Verify actual token permissions, not only the requested or response scope.
    const info = await jsonRequest(
      `https://www.googleapis.com/oauth2/v2/tokeninfo?${new URLSearchParams({ access_token: tokens.access_token })}`,
      {},
    );
    const verified = z
      .object({
        scope: z.literal(gmailReadOnlyScope),
        audience: z.literal(client.clientId),
        issued_to: z.literal(client.clientId),
      })
      .safeParse(info);
    if (!verified.success) {
      unavailable("Gmail requires a fresh credential with only gmail.readonly permission.");
    }
    return tokens;
  };
  const gmail = async (): Promise<
    UserGmailConnector & {
      credential: NonNullable<UserGmailConnector["credential"]>;
    }
  > => {
    await authority.revalidate();
    const connection = await read("gmail");
    if (connection?.kind !== "gmail" || !connection.credential) {
      return unavailable("Connect Gmail in Alcove first.");
    }
    if (connection.credential.expiresAt > Date.now() + 60_000) {
      return { ...connection, credential: connection.credential };
    }
    // A durable claim prevents another resolver from refreshing the same generation.
    if (connection.pending) {
      return unavailable("Gmail authorization is pending. Finish or reconnect Gmail.");
    }
    const claimed: UserGmailConnector = {
      ...connection,
      generation: randomUUID(),
      pending: {
        state: randomBytes(32).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
        expiresAt: Date.now() + 10 * 60_000,
        claimed: true,
      },
    };
    await replace(claimed, connection.generation);
    await current("gmail", claimed.generation);
    const tokens = await token(claimed.client, {
      grant_type: "refresh_token",
      refresh_token: connection.credential.refreshToken,
    });
    await current("gmail", claimed.generation);
    const credential = {
      ...connection.credential,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? connection.credential.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    const next: UserGmailConnector = {
      ...claimed,
      generation: randomUUID(),
      pending: undefined,
      credential,
    };
    await replace(next, claimed.generation);
    return { ...next, credential };
  };
  const calendarRequest = async (url: string, body: string, method: "PROPFIND" | "REPORT") => {
    await authority.revalidate();
    const connection = await read("icloud-calendar");
    if (connection?.kind !== "icloud-calendar") {
      return unavailable("Connect iCloud Calendar in Alcove first.");
    }
    const target = calendarUrl(url);
    await current("icloud-calendar", connection.generation);
    const authorization = `Basic ${Buffer.from(`${connection.account}:${connection.password}`).toString("base64")}`;
    registerSecretValueForRedaction(authorization);
    const text = await request(
      target,
      {
        method,
        headers: { authorization, "content-type": "application/xml; charset=utf-8", depth: "1" },
        body,
      },
      1024 * 1024,
    );
    await current("icloud-calendar", connection.generation);
    return text;
  };
  return {
    async status() {
      await authority.revalidate();
      const savedGmail = await read("gmail");
      const calendar = await read("icloud-calendar");
      authority.assertCurrent();
      return {
        gmail: {
          connected: savedGmail?.kind === "gmail" && Boolean(savedGmail.credential),
          account: savedGmail?.kind === "gmail" ? savedGmail.credential?.account : undefined,
        },
        calendar: {
          connected: calendar?.kind === "icloud-calendar",
          account: calendar?.kind === "icloud-calendar" ? calendar.account : undefined,
        },
      };
    },
    async startGmail(suppliedClient?: GoogleClient) {
      await authority.revalidate();
      const client = suppliedClient ?? options.googleClient;
      if (!client) {
        unavailable("The operator must configure an Alcove Google OAuth client first.");
      }
      const previous = await read("gmail");
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const connector: UserGmailConnector = {
        version: 1,
        kind: "gmail",
        generation: randomUUID(),
        client,
        pending: { state, verifier, expiresAt: Date.now() + 10 * 60_000, claimed: false },
      };
      await replace(connector, previous?.generation ?? null);
      const query = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        response_type: "code",
        scope: gmailReadOnlyScope,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      });
      return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}` };
    },
    async completeGmail(code: string, state: string) {
      if (!code || code.length > 8192 || !/^[A-Za-z0-9_-]{43}$/u.test(state)) {
        return invalid();
      }
      registerSecretValueForRedaction(code);
      await authority.revalidate();
      const previous = await read("gmail");
      if (
        previous?.kind !== "gmail" ||
        !previous.pending ||
        previous.pending.state !== state ||
        previous.pending.claimed ||
        previous.pending.expiresAt <= Date.now()
      ) {
        return unavailable("Gmail authorization expired or changed. Connect Gmail again.");
      }
      const claimed: UserGmailConnector = {
        ...previous,
        generation: randomUUID(),
        pending: { ...previous.pending, claimed: true },
      };
      await replace(claimed, previous.generation);
      await current("gmail", claimed.generation);
      const tokens = await token(claimed.client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: claimed.client.redirectUri,
        code_verifier: previous.pending.verifier,
      });
      if (!tokens.refresh_token) {
        return unavailable(
          "Google did not grant offline access. Connect Gmail with fresh consent.",
        );
      }
      await current("gmail", claimed.generation);
      const profile = z.object({ emailAddress: z.string().email().max(254) }).safeParse(
        await jsonRequest("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
      );
      if (!profile.success) {
        return unavailable("Google did not return a Gmail account. Connect Gmail again.");
      }
      await current("gmail", claimed.generation);
      await replace(
        {
          ...claimed,
          generation: randomUUID(),
          pending: undefined,
          credential: {
            account: profile.data.emailAddress,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + tokens.expires_in * 1000,
            scope: gmailReadOnlyScope,
          },
        },
        claimed.generation,
      );
      return { connected: true };
    },
    async connectCalendar(account: string, password: string) {
      await authority.revalidate();
      if (
        !z.string().email().max(254).safeParse(account).success ||
        !/^[a-z]{4}(?:-[a-z]{4}){3}$/u.test(password)
      ) {
        return invalid();
      }
      registerSecretValueForRedaction(password);
      const previous = await read("icloud-calendar");
      const authorization = `Basic ${Buffer.from(`${account}:${password}`).toString("base64")}`;
      registerSecretValueForRedaction(authorization);
      await request("https://caldav.icloud.com/", {
        method: "PROPFIND",
        headers: { authorization, "content-type": "application/xml", depth: "0" },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>',
      });
      await authority.revalidate();
      await replace(
        {
          version: 1,
          generation: randomUUID(),
          kind: "icloud-calendar",
          account,
          password,
        },
        previous?.generation ?? null,
      );
      return { connected: true };
    },
    async disconnect(kind: UserConnectorKind) {
      await authority.revalidate();
      const previous = await read(kind);
      await operateUserConnector(
        {
          action: "delete",
          kind,
          profileId: authority.profileId,
          expectedGeneration: previous?.generation ?? null,
        },
        { env, assertCurrent: authority.assertCurrent },
      );
      return { connected: false };
    },
    /** Only fixed Gmail GET endpoints are exposed; no send, modify, or arbitrary URL operation. */
    async readGmail(input: { query?: string; messageId?: string }) {
      if (
        (input.query?.length ?? 0) > 2048 ||
        (input.messageId !== undefined && !/^[a-f0-9]{1,32}$/u.test(input.messageId))
      ) {
        return invalid();
      }
      const connection = await gmail();
      await current("gmail", connection.generation);
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      if (input.messageId) {
        url.pathname += `/${input.messageId}`;
        url.searchParams.set("format", "full");
      } else {
        url.searchParams.set("maxResults", "50");
        if (input.query) {
          url.searchParams.set("q", input.query);
        }
      }
      const result = await jsonRequest(url.href, {
        headers: { authorization: `Bearer ${connection.credential.accessToken}` },
      });
      await current("gmail", connection.generation);
      return result;
    },
    /** Returns CalDAV XML for principal, calendar-home, and calendar discovery. */
    discoverCalendar(url = "https://caldav.icloud.com/") {
      return calendarRequest(
        url,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/><d:displayname/><d:resourcetype/></d:prop></d:propfind>',
        "PROPFIND",
      );
    },
    readCalendar(input: { url: string; start: string; end: string }) {
      if (
        !/^\d{8}T\d{6}Z$/u.test(input.start) ||
        !/^\d{8}T\d{6}Z$/u.test(input.end) ||
        input.start >= input.end
      ) {
        return invalid();
      }
      return calendarRequest(
        input.url,
        `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${input.start}" end="${input.end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
        "REPORT",
      );
    },
  };
}

/** Automation dispatch gets no connection mutations, credential values, or arbitrary transport. */
export function resolveProtectedReadOnlyConnectors(options: {
  stateDir: string;
  authority: ProtectedConnectorAuthority;
}) {
  const { readGmail, discoverCalendar, readCalendar } = createProtectedConnectors(options);
  return { readGmail, discoverCalendar, readCalendar };
}
