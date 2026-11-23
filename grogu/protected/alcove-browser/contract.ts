import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const node = <T extends import("typebox").TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const ALCOVE_BROWSER_PLUGIN_ID = "alcove-browser";
export const ALCOVE_BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_snapshot",
  "browser_follow_link",
  "browser_back",
] as const;

export const AlcoveBrowserOpenParametersSchema = node({
  url: Type.String({ minLength: 1, maxLength: 2048 }),
});
export const AlcoveBrowserSnapshotParametersSchema = node({});
export const AlcoveBrowserFollowLinkParametersSchema = node({
  ref: Type.String({ minLength: 2, maxLength: 16, pattern: "^e[1-9][0-9]{0,6}$" }),
});
export const AlcoveBrowserBackParametersSchema = node({});

export type AlcoveBrowserOpenParameters = Static<typeof AlcoveBrowserOpenParametersSchema>;
export type AlcoveBrowserFollowLinkParameters = Static<
  typeof AlcoveBrowserFollowLinkParametersSchema
>;

export type AlcoveBrowserPage = {
  status: "ok";
  url: string;
  title: string;
  snapshot: string;
  truncated: boolean;
};
export type AlcoveBrowserResult =
  | AlcoveBrowserPage
  | {
      status: "blocked" | "invalid" | "unavailable" | "failed";
      reason: string;
    };

/** Host operations bound to one member chat's private browser session for one turn. */
export type AlcoveBrowserBindings = {
  browser: "fresh";
  open: (input: AlcoveBrowserOpenParameters) => Promise<AlcoveBrowserResult>;
  snapshot: () => Promise<AlcoveBrowserResult>;
  followLink: (input: AlcoveBrowserFollowLinkParameters) => Promise<AlcoveBrowserResult>;
  back: () => Promise<AlcoveBrowserResult>;
};

export const isAlcoveBrowserOpenParameters = (
  value: unknown,
): value is AlcoveBrowserOpenParameters => Value.Check(AlcoveBrowserOpenParametersSchema, value);
export const isAlcoveBrowserFollowLinkParameters = (
  value: unknown,
): value is AlcoveBrowserFollowLinkParameters =>
  Value.Check(AlcoveBrowserFollowLinkParametersSchema, value);
