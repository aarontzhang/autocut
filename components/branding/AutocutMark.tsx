'use client';

export default function AutocutMark({
  size = 20,
  withTile = true,
}: {
  size?: number;
  withTile?: boolean;
}) {
  const gradientId = `autocut-mark-${size}-${withTile ? 'tile' : 'plain'}`;
  const glowId = `${gradientId}-glow`;
  const tileId = `${gradientId}-tile`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="6" y1="4" x2="18.5" y2="18.5" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F0F5FF" />
          <stop offset="0.22" stopColor="#AADBFF" />
          <stop offset="0.5" stopColor="#5A8CFF" />
          <stop offset="0.76" stopColor="#635BFF" />
          <stop offset="1" stopColor="#8DEBFF" />
        </linearGradient>
        <linearGradient id={tileId} x1="3" y1="2.5" x2="21" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#EEF2FB" />
        </linearGradient>
        <filter id={glowId} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1.2" stdDeviation="1.6" floodColor="#4C7CFF" floodOpacity="0.35" />
        </filter>
      </defs>
      {withTile && (
        <>
          <rect x="1" y="1" width="22" height="22" rx="6.5" fill={`url(#${tileId})`} />
          <rect x="1.4" y="1.4" width="21.2" height="21.2" rx="6.1" stroke="rgba(116, 137, 191, 0.22)" strokeWidth="0.8" />
        </>
      )}
      <g fill={`url(#${gradientId})`} filter={`url(#${glowId})`}>
        <path d="M6.8 6.25C6.8 5.45 7.68 4.96 8.36 5.4L12.82 8.28C13.46 8.69 13.46 9.63 12.82 10.04L8.36 12.92C7.68 13.36 6.8 12.87 6.8 12.07V6.25Z" />
        <path d="M9.15 10.65C9.15 9.85 10.03 9.36 10.71 9.8L15.18 12.68C15.81 13.09 15.81 14.03 15.18 14.44L10.71 17.32C10.03 17.76 9.15 17.27 9.15 16.47V10.65Z" />
        <path d="M11.55 5.75C11.55 4.95 12.43 4.46 13.11 4.9L17.58 7.78C18.21 8.19 18.21 9.13 17.58 9.54L13.11 12.42C12.43 12.86 11.55 12.37 11.55 11.57V5.75Z" />
      </g>
    </svg>
  );
}
