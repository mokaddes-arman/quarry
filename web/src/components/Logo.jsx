// Quarry brand mark and wordmark. Source artwork lives in brand/ — keep the
// paths here in sync with brand/quarry-mark.svg.

export const BRAND_NAME = 'Quarry';

export function LogoMark({ size = 32, className = '', title = BRAND_NAME }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
      focusable="false"
    >
      <rect width="64" height="64" rx="14" fill="#172A3A" />
      {/* Hairline edge, shown only on dark surfaces so the navy tile does not
          vanish into a navy sidebar or page. */}
      <rect
        x="1"
        y="1"
        width="62"
        height="62"
        rx="13"
        fill="none"
        strokeWidth="2"
        className="stroke-transparent dark:stroke-[#3A5068]"
      />
      <path d="M11 27 20 14h24l9 13z" fill="#C49A5A" />
      <path d="M20 14h8l-4 13H11z" fill="#D4B381" />
      <path d="M11 27h42L26 52z" fill="#F5F3ED" />
      <path d="M31 27h22L26 52z" fill="#D9D3C5" />
    </svg>
  );
}

export function Wordmark({ className = '' }) {
  return (
    <span className={`font-semibold lowercase tracking-tight ${className}`}>{BRAND_NAME.toLowerCase()}</span>
  );
}
