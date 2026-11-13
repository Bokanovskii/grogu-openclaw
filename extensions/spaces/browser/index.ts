import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { SpacesController } from "./controller.ts";
import type { SpacesDraftState } from "./drafts.ts";
import { createSpacesView } from "./view.ts";
import "./spaces.css";

// The host retires activations on disconnect; the same Gateway asset module keeps only unsaved input.
let retainedDrafts: SpacesDraftState | undefined;

export default defineControlUiPlugin({
  id: "spaces",
  activate(host) {
    const controller = new SpacesController(host, retainedDrafts);
    retainedDrafts = undefined;
    const registrations = [
      host.ui.registerPage({
        id: "spaces",
        label: "Spaces",
        mount: createSpacesView(controller, false),
      }),
      host.ui.registerNavigation({
        id: "spaces",
        label: "Spaces",
        page: { id: "spaces" },
        icon: "list",
        order: 30,
      }),
      host.ui.registerPanel({
        id: "details",
        label: "Space details",
        mount: createSpacesView(controller, true),
      }),
    ];
    return () => {
      for (const dispose of registrations.toReversed()) {
        dispose();
      }
      retainedDrafts = controller.dispose();
    };
  },
});
