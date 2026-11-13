import type { HTMLAttributes } from "react";

const ICONS = {
  activity: "fa-wave-square",
  "arrow-left": "fa-arrow-left",
  "arrow-up-right": "fa-arrow-up-right-from-square",
  ban: "fa-ban",
  "bar-chart": "fa-chart-column",
  boxes: "fa-boxes-stacked",
  braces: "fa-code",
  "check-circle": "fa-circle-check",
  "chevron-down": "fa-chevron-down",
  "chevron-right": "fa-chevron-right",
  circle: "fa-circle",
  "circle-help": "fa-circle-question",
  clock: "fa-clock",
  code: "fa-code",
  compass: "fa-compass",
  copy: "fa-copy",
  database: "fa-database",
  external: "fa-arrow-up-right-from-square",
  fingerprint: "fa-fingerprint",
  filter: "fa-filter",
  flask: "fa-flask",
  gauge: "fa-gauge-high",
  github: "fa-github",
  "git-branch": "fa-code-branch",
  inbox: "fa-inbox",
  key: "fa-key",
  layers: "fa-layer-group",
  loader: "fa-spinner",
  minus: "fa-circle-minus",
  moon: "fa-moon",
  play: "fa-play",
  refresh: "fa-rotate",
  retry: "fa-rotate-right",
  server: "fa-server",
  settings: "fa-gear",
  shield: "fa-shield-halved",
  sun: "fa-sun",
  terminal: "fa-terminal",
  timer: "fa-hourglass-half",
  "triangle-alert": "fa-triangle-exclamation",
  trending: "fa-chart-line",
  workflow: "fa-diagram-project",
  x: "fa-xmark",
  "x-circle": "fa-circle-xmark",
} as const;

export type IconName = keyof typeof ICONS;

interface IconProps extends HTMLAttributes<HTMLElement> {
  name: IconName;
}

export function Icon({ name, className, ...props }: IconProps) {
  return (
    <i
      aria-hidden="true"
      className={`${name === "github" ? "fa-brands" : "fa-solid"} ${ICONS[name]}${className === undefined ? "" : ` ${className}`}`}
      {...props}
    />
  );
}
