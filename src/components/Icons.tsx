/** Inline SVG icons. No icon font, no network requests. */

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const PlayIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M6 4.5 19 12 6 19.5z" fill="currentColor" stroke="none" />
  </Svg>
);

export const PauseIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const StopIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
);

export const SkipStartIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M18 5 8 12l10 7z" fill="currentColor" stroke="none" />
    <path d="M6 5v14" />
  </Svg>
);

export const LoopIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M4 9a4 4 0 0 1 4-4h10" />
    <path d="m15 2 3 3-3 3" />
    <path d="M20 15a4 4 0 0 1-4 4H6" />
    <path d="m9 22-3-3 3-3" />
  </Svg>
);

export const SearchIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.6-3.6" />
  </Svg>
);

export const FolderIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

export const TrashIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M4 7h16" />
    <path d="M9 7V5h6v2" />
    <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
);

export const PlusIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const DownloadIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M12 4v11" />
    <path d="m7.5 11 4.5 4.5 4.5-4.5" />
    <path d="M5 19h14" />
  </Svg>
);

export const SettingsIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14.5a1.7 1.7 0 0 0 .35 1.9l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.9-.35 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.9.35l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .35-1.9 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.35-1.9l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.9.35H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.9-.35l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.35 1.9V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.03z" />
  </Svg>
);

export const CloseIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const BackIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);

export const ZoomInIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M11 8.5v5M8.5 11h5" />
    <path d="m20 20-3.6-3.6" />
  </Svg>
);

export const ZoomOutIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M8.5 11h5" />
    <path d="m20 20-3.6-3.6" />
  </Svg>
);

export const ShieldIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M12 3 5 6v6c0 4.2 2.9 7.9 7 9 4.1-1.1 7-4.8 7-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);

export const RestoreIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M4 12a8 8 0 1 0 2.5-5.8" />
    <path d="M4 4v5h5" />
  </Svg>
);

export const LinkIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M10 13a4 4 0 0 0 5.7.4l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7" />
    <path d="M14 11a4 4 0 0 0-5.7-.4l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7" />
  </Svg>
);

export const WarningIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M12 4.5 2.8 20h18.4z" />
    <path d="M12 10v4.5M12 17.5v.01" />
  </Svg>
);
