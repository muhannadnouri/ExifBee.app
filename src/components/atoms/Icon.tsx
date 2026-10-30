import './Icon.css';

/** Line icons drawn for ExifBee on a 24-unit grid; they inherit the text color and size. */
const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  settings: (
    <>
      <path d="M19.3 9.8 L21.9 10.3 L21.9 13.7 L19.3 14.2 L18.7 15.5 L20.2 17.8 L17.8 20.2 L15.5 18.7 L14.2 19.3 L13.7 21.9 L10.3 21.9 L9.8 19.3 L8.5 18.7 L6.2 20.2 L3.8 17.8 L5.3 15.5 L4.7 14.2 L2.1 13.7 L2.1 10.3 L4.7 9.8 L5.3 8.5 L3.8 6.2 L6.2 3.8 L8.5 5.3 L9.8 4.7 L10.3 2.1 L13.7 2.1 L14.2 4.7 L15.5 5.3 L17.8 3.8 L20.2 6.2 L18.7 8.5Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  monitor: (
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M9.5 9.2a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1.1.9-1.1 1.6v.6M12 17.2v.1" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

/** Decorative by default: the control that shows it carries the accessible name. */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
