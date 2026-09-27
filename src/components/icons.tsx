type P = { size?: number; className?: string };

const svg = (size: number, className: string | undefined, children: React.ReactNode, fill = false) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill ? "currentColor" : "none"}
    stroke={fill ? "none" : "currentColor"}
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const PhoneIcon = ({ size = 20, className }: P) =>
  svg(
    size,
    className,
    <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />,
    true,
  );

export const HangupIcon = ({ size = 26, className }: P) =>
  svg(
    size,
    className,
    <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.4-.02L.29 13.08a1 1 0 0 1 0-1.41A16.9 16.9 0 0 1 12 7c4.54 0 8.66 1.8 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.48a1 1 0 0 1-1.4.02 11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1A15 15 0 0 0 12 9z" />,
    true,
  );

export const MicIcon = ({ size = 22, className }: P) =>
  svg(
    size,
    className,
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>,
  );

export const MicOffIcon = ({ size = 22, className }: P) =>
  svg(
    size,
    className,
    <>
      <path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5" />
      <path d="M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.4 2.3M12 18v3M3 3l18 18" />
    </>,
  );

export const SendIcon = ({ size = 18, className }: P) =>
  svg(
    size,
    className,
    <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" strokeWidth={2.4} />,
  );

export const MailIcon = ({ size = 22, className }: P) =>
  svg(
    size,
    className,
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m4 7 8 6 8-6" />
    </>,
  );

export const CheckIcon = ({ size = 14, className }: P) => svg(size, className, <path d="m5 12.5 4.5 4.5L19 7.5" strokeWidth={2.4} />);

export const LockIcon = ({ size = 14, className }: P) =>
  svg(
    size,
    className,
    <>
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>,
  );

export const ChevronIcon = ({ size = 16, className }: P) => svg(size, className, <path d="m6 9 6 6 6-6" />);
