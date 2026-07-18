// Строгий outline-набор иконок для страницы «Анализ ВОР/КП».
// Единый стиль (как Lucide): viewBox 24, fill none, stroke currentColor, толщина 1.7,
// скруглённые концы. Цвет наследуется от родителя, размер — через prop size.
function Base({ size = 24, children }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      {children}
    </svg>
  )
}

// Раздел «Анализ ВОР/КП» — столбчатая аналитика
export const IconBarChart = (props) => (
  <Base {...props}>
    <path d="M3 3v18h18" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-3" />
  </Base>
)

// Загрузка
export const IconUpload = (props) => (
  <Base {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m17 8-5-5-5 5" />
    <path d="M12 3v12" />
  </Base>
)

// Скачивание
export const IconDownload = (props) => (
  <Base {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </Base>
)

// Пустое состояние — Excel-файл / таблица
export const IconFileSpreadsheet = (props) => (
  <Base {...props}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M8 13h2" />
    <path d="M14 13h2" />
    <path d="M8 17h2" />
    <path d="M14 17h2" />
  </Base>
)

// Сопоставление колонок — таблица/сетка
export const IconColumns = (props) => (
  <Base {...props}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M3 9h18" />
    <path d="M3 15h18" />
    <path d="M12 3v18" />
  </Base>
)
