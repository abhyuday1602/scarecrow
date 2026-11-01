// cli/coming-soon.js — features that are wired into the CLI/TUI surface but don't work
// end to end yet. Rather than let them silently do nothing (or half-work), every entry
// point checks here and tells the user plainly that the feature is coming soon.
// Un-gating a feature = make it work, then delete its entry below.

export const COMING_SOON = {
  record: {
    label: "Video recording",
    flag: "--record",
    reason: "recordings aren't reliably saved yet",
  },
  a11y: {
    label: "Accessibility audit",
    flag: "--a11y",
    reason: "it only audits the first page today, not every page the persona visits",
  },
  resume: {
    label: "Resume",
    flag: "crow resume",
    reason: "an interrupted run can't be picked up where it stopped yet",
  },
  tuiDevice: {
    label: "Choosing a device in the interactive UI",
    flag: "/device",
    reason: "the interactive UI doesn't apply the preset to runs yet — use `crow <url> --device mobile`",
  },
};

export const isComingSoon = (name) => Object.hasOwn(COMING_SOON, name);

// One-line, user-facing notice for a gated feature.
export function comingSoon(name) {
  const f = COMING_SOON[name];
  return f ? `${f.label} is coming soon — ${f.reason}.` : "";
}
