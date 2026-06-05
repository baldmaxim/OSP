// Аккуратная векторная иконка-скрепка (feather-style). Наследует цвет текста
// через `currentColor` и размер через проп `size`. Используем вместо эмодзи 📎,
// которое на части систем рендерится цветным/«улыбающимся».
export default function PaperclipIcon({ size = 14, className, style }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'text-bottom', ...style }}
      aria-hidden="true"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}
