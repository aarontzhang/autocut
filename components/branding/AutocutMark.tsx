'use client';

export default function AutocutMark({
  size = 20,
  withTile = true,
}: {
  size?: number;
  withTile?: boolean;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {withTile && <rect x="1" y="1" width="22" height="22" rx="6" fill="#0A0A0A" />}
      <g fill="#FFFFFF">
        <path d="M6.2 4.8 10.5 7.25 6.2 9.7Z" />
        <path d="M6.2 9.95 10.5 12.4 6.2 14.85Z" />
        <path d="M6.2 15.1 10.5 17.55 6.2 20Z" />
        <path d="M10.8 7.45 15.1 9.9 10.8 12.35Z" />
        <path d="M10.8 12.6 15.1 15.05 10.8 17.5Z" />
        <path d="M15.4 10.05 19.7 12.5 15.4 14.95Z" />
      </g>
    </svg>
  );
}
