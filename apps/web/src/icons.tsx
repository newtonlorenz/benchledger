import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "arrow-left"
  | "arrow-right"
  | "arrow-up-right"
  | "archive"
  | "box"
  | "check"
  | "check-circle"
  | "chevron-down"
  | "chevron-right"
  | "circle"
  | "clipboard"
  | "clock"
  | "close"
  | "code"
  | "copy"
  | "download"
  | "external"
  | "file"
  | "filter"
  | "folder"
  | "grid"
  | "help"
  | "info"
  | "layers"
  | "link"
  | "menu"
  | "minus"
  | "package"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "sliders"
  | "spark"
  | "tag"
  | "tool"
  | "upload"
  | "warning"
  | "wrench";

const paths: Record<IconName, ReactNode> = {
  "arrow-left": <path d="M19 12H5m6 6-6-6 6-6" />,
  "arrow-right": <path d="M5 12h14m-6-6 6 6-6 6" />,
  "arrow-up-right": <><path d="M7 17 17 7" /><path d="M7 7h10v10" /></>,
  archive: <><path d="M3 6h18" /><path d="M5 6v13h14V6" /><path d="M3 6l1-3h16l1 3" /><path d="M9 11h6" /></>,
  box: <><path d="m3 7 9-4 9 4-9 4-9-4Z" /><path d="M3 7v10l9 4 9-4V7M12 11v10" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  "check-circle": <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  circle: <circle cx="12" cy="12" r="8" />,
  clipboard: <><rect x="5" y="4" width="14" height="17" rx="1" /><path d="M9 4.5V3h6v1.5M8 9h8M8 13h6M8 17h4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  code: <><path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14" /></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="1" /><path d="M16 8V5H5v11h3" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M5 21h14" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h4M9 13h6M9 17h5" /></>,
  filter: <><path d="M4 5h16l-6 7v5l-4 2v-7z" /></>,
  folder: <><path d="M3 6h7l2 2h9v10H3z" /></>,
  grid: <><rect x="4" y="4" width="6" height="6" /><rect x="14" y="4" width="6" height="6" /><rect x="4" y="14" width="6" height="6" /><rect x="14" y="14" width="6" height="6" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.4 2.4 0 1 1 3.7 2c-.9.6-1.3 1-1.3 2M12 16h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  layers: <><path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z" /><path d="m3 12 9 4.5 9-4.5M3 16.5l9 4.5 9-4.5" /></>,
  link: <><path d="M10 13.5a4 4 0 0 0 5.7.1l2-2a4 4 0 0 0-5.7-5.6l-1.1 1.1" /><path d="M14 10.5a4 4 0 0 0-5.7-.1l-2 2A4 4 0 0 0 12 18l1.1-1.1" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  minus: <path d="M5 12h14" />,
  package: <><path d="m4 7 8-4 8 4-8 4-8-4Z" /><path d="M4 7v10l8 4 8-4V7M12 11v10" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.8-3L3 11" /><path d="M3 5v6h6M4 13a8 8 0 0 0 14.8 3L21 13" /><path d="M21 19v-6h-6" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1-1.7 1.7-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2h-2.4v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1-1.7-1.7.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H7v-2.4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1L10 7l.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5v-.2h2.4v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3L18.2 7l1.7 1.7-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1h.2V14H21a1.6 1.6 0 0 0-1.6 1Z" /></>,
  sliders: <><path d="M4 6h7M16 6h4M13 4v4M4 12h3M12 12h8M9 10v4M4 18h11M18 16v4" /></>,
  spark: <><path d="m12 3 1.3 5.7L19 10l-5.7 1.3L12 17l-1.3-5.7L5 10l5.7-1.3L12 3ZM19 16l.5 2.5L22 19l-2.5.5L19 22l-.5-2.5L16 19l2.5-.5L19 16Z" /></>,
  tag: <path d="M20 13 13 20 4 11V4h7l9 9ZM8 8h.01" />,
  tool: <><path d="m14.5 6.5 3-3a5 5 0 0 0-6.1 6.1L4 17a2.1 2.1 0 1 0 3 3l7.4-7.4a5 5 0 0 0 6.1-6.1l-3 3-3-3Z" /></>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5M5 20h14" /></>,
  warning: <><path d="m12 3 9 17H3L12 3Z" /><path d="M12 9v4M12 16h.01" /></>,
  wrench: <><path d="M14.5 6.5 18 3l3 3-3.5 3.5" /><path d="m15 9-5 5-2-2-5 5 3 3 5-5-2-2 5-5" /></>
};

export function Icon({ name, size = 18, strokeWidth = 1.8, ...props }: { name: IconName; size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" focusable="false" {...props}>
      {paths[name]}
    </svg>
  );
}
