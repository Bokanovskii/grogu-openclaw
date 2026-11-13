import { html, svg } from "lit";

/*
 * Grogu-fork working indicator: an animated pixel sprite of Grogu, derived from
 * his 24px pixel avatar (same silhouette, ears, eyes, and robe), who reaches for
 * the live reasoning stream, bites a crumb of it, and chews. Poses are full
 * frames so each step shows real mouth, head, ear, and arm changes; CSS owns
 * their timing and reduced-motion fallback. Agents not named Grogu keep the
 * theme's indicator.
 */

const GROGU_AGENT_NAME = /^grogu\b/i;

export function isGroguAgentName(name: string | null | undefined): boolean {
  return GROGU_AGENT_NAME.test(name?.trim() ?? "");
}

// Avatar palette; T is a crumb of reasoning text and takes the text color.
const PALETTE: Record<string, string> = {
  A: "#648c52",
  B: "#b0d696",
  C: "#8cba70",
  D: "#f0f6eb",
  E: "#1c221c",
  F: "#d6c7a6",
  G: "#b09e7a",
  H: "#807054",
  T: "currentColor",
};

// Rows 5-18 of the avatar, widened so the arm can reach toward the stream.
const POSES = {
  look: [
    ".........ABBCCA...........",
    "........ABBBCCCA..........",
    "........ABCCCCCA..........",
    "...AB...ABCCCCCA...BA.....",
    "..ABBBBBCDECCDECBBBBBA....",
    "...AAABBCEECCEECBBAAA.....",
    ".....ABBACCAACCABBA.......",
    ".........ACCCCA...........",
    "..........ACCA............",
    "........FFGGGGFF..........",
    ".......FFGGGGGGFF.........",
    "......FFGGGGGGGGFF........",
    "......FGGGGGGGGGGF........",
    "......HHHHHHHHHHHH........",
  ],
  blink: [
    ".........ABBCCA...........",
    "........ABBBCCCA..........",
    "........ABCCCCCA..........",
    "...AB...ABCCCCCA...BA.....",
    "..ABBBBBCCCCCCCCBBBBBA....",
    "...AAABBCEECCEECBBAAA.....",
    ".....ABBACCAACCABBA.......",
    ".........ACCCCA...........",
    "..........ACCA............",
    "........FFGGGGFF..........",
    ".......FFGGGGGGFF.........",
    "......FFGGGGGGGGFF........",
    "......FGGGGGGGGGGF........",
    "......HHHHHHHHHHHH........",
  ],
  reach: [
    "..........ABBCCA..........",
    ".........ABBBCCCA.........",
    ".........ABCCCCCA.........",
    "....AB...ABCCCCCA...BA....",
    "...ABBBBBCDECCDECBBBBBA...",
    "....AAABBCEECCEECBBAAA....",
    "......ABBACCAECCABBA......",
    "..........ACCCCA..........",
    "...........ACCA...........",
    "........FFGGGGFF...AB.....",
    ".......FFGGGGGGFFFFBCTT...",
    "......FFGGGGGGGGFF........",
    "......FGGGGGGGGGGF........",
    "......HHHHHHHHHHHH........",
  ],
  bite: [
    "..........ABBCCA..........",
    ".........ABBBCCCA.........",
    "....AB...ABCCCCCA...BA....",
    "...ABBBBBABCCCCCABBBBBA...",
    "....AAABBCDECCDECBBAAA....",
    "......ABBCEECCEECBBA......",
    ".........ACCEECCA.........",
    "..........ACEETBB.........",
    "...........ACCA.FF........",
    "........FFGGGGFFFF........",
    ".......FFGGGGGGFF.........",
    "......FFGGGGGGGGFF........",
    "......FGGGGGGGGGGF........",
    "......HHHHHHHHHHHH........",
  ],
  chew: [
    "..........ABBCCA..........",
    ".........ABBBCCCA.........",
    ".........ABCCCCCA.........",
    "....AB...ABCCCCCA...BA....",
    "...ABBBBBCCCCCCCCBBBBBA...",
    "....AAABBCEECCEECBBAAA....",
    "......ABBACCAACCABBA......",
    ".........ACCCCCCA.........",
    "..........ACCCA...........",
    "........FFGGGGFF..........",
    ".......FFGGGGGGFF.........",
    "......FFGGGGGGGGFF........",
    "......FGGGGGGGGGGF........",
    "......HHHHHHHHHHHH........",
  ],
} as const;

function renderPose(pose: string, rows: readonly string[]) {
  const runs = rows.flatMap((row, y) =>
    [...row.matchAll(/([A-HT])\1*/g)].map((run) => ({
      x: run.index,
      y,
      width: run[0].length,
      fill: PALETTE[run[1]!],
    })),
  );
  return svg`<g class="chat-grogu-eater__pose chat-grogu-eater__pose--${pose}">${runs.map(
    (run) =>
      svg`<rect x=${run.x} y=${run.y} width=${run.width} height="1" fill=${run.fill}></rect>`,
  )}</g>`;
}

const SPRITE = svg`<svg
  class="chat-grogu-eater__sprite"
  viewBox="2 0 22 14"
  shape-rendering="crispEdges"
  focusable="false"
>${Object.entries(POSES).map(([pose, rows]) => renderPose(pose, rows))}</svg>`;

export function renderGroguEater(eating: boolean) {
  return html`<span
    class="chat-grogu-eater ${eating ? "chat-grogu-eater--eating" : ""}"
    aria-hidden="true"
    >${SPRITE}</span
  >`;
}
