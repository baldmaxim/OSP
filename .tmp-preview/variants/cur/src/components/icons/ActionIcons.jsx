// Иконки действий в строках таблиц — тот же outline-стиль, что у ToolbarIcons и
// бокового меню: viewBox 24, stroke currentColor. Заменяют эмодзи (✏️ 🗑️ ♻️ ↩️
// ✉️ 📋 🕒 📅 🔗), которые рисовались цветными картинками или квадратами.
// Иконка всегда декоративная (aria-hidden): подпись кнопки — aria-label.
function AiSvg({ size = 16, children }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      {children}
    </svg>
  )
}

export const IconPencil = ({ size }) => (
  <AiSvg size={size}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></AiSvg>
)
export const IconTrash = ({ size }) => (
  <AiSvg size={size}>
    <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" />
  </AiSvg>
)
export const IconRestore = ({ size }) => (
  <AiSvg size={size}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></AiSvg>
)
export const IconLetter = ({ size }) => (
  <AiSvg size={size}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></AiSvg>
)
export const IconChecklist = ({ size }) => (
  <AiSvg size={size}>
    <rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" />
    <path d="m9 12 2 2 4-4" />
  </AiSvg>
)
export const IconClock = ({ size }) => (
  <AiSvg size={size}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></AiSvg>
)
export const IconCalendar = ({ size }) => (
  <AiSvg size={size}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></AiSvg>
)
export const IconLink = ({ size }) => (
  <AiSvg size={size}>
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
  </AiSvg>
)
export const IconCheck = ({ size }) => (
  <AiSvg size={size}><path d="M20 6 9 17l-5-5" /></AiSvg>
)
export const IconHistory = ({ size }) => (
  <AiSvg size={size}><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l3 2" /></AiSvg>
)
