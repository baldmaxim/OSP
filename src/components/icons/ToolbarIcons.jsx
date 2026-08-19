// Иконки шапок и панелей фильтров — тот же outline-стиль, что у бокового меню
// (см. NavIcons.jsx): viewBox 24, fill none, stroke currentColor, скруглённые
// окончания. Цвет наследуется от контейнера, поэтому иконки одноцветные.
//
// Заменяют цветные эмодзи (📋 🏢 🏷 👤 ✉️ ⊞), которые выбивались из оформления.
function TbSvg({ size = 16, children }) {
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

// Объект — здание
export const IconObject = ({ size }) => (
  <TbSvg size={size}>
    <path d="M4 21V6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v15" />
    <path d="M12 10h7a1 1 0 0 1 1 1v10" />
    <path d="M7 9h2M7 13h2M15 14h2M15 17.5h2" />
    <path d="M2 21h20" />
  </TbSvg>
)

// Статус — ярлык
export const IconTag = ({ size }) => (
  <TbSvg size={size}>
    <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4.8A2 2 0 0 1 4.8 2.8H12a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8Z" />
    <circle cx="7.5" cy="7.5" r="1.2" />
  </TbSvg>
)

// Ответственный — пользователь
export const IconUser = ({ size }) => (
  <TbSvg size={size}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </TbSvg>
)

// Шаблон письма — конверт
export const IconMail = ({ size }) => (
  <TbSvg size={size}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="m3 7 8.4 5.6a1 1 0 0 0 1.2 0L21 7" />
  </TbSvg>
)

// Компактный вид — колонки таблицы
export const IconColumns = ({ size }) => (
  <TbSvg size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M15 4v16" />
  </TbSvg>
)

// Все столбцы — развернуть (стрелки в стороны)
export const IconColumnsWide = ({ size }) => (
  <TbSvg size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
    <path d="m8 10-2 2 2 2M16 10l2 2-2 2" />
  </TbSvg>
)

// Совместные тендеры — рукопожатие двух сторон
export const IconJoint = ({ size }) => (
  <TbSvg size={size}>
    <path d="M11 17a2 2 0 0 1-2 2 2 2 0 0 1-2-2" />
    <path d="M6.5 13.5 4 11a2 2 0 0 1 0-2.8l2.6-2.6a2 2 0 0 1 1.4-.6H11" />
    <path d="M13 5h3a2 2 0 0 1 1.4.6L20 8.2a2 2 0 0 1 0 2.8l-2.5 2.5" />
    <path d="m9 12 2.3 2.3a1.6 1.6 0 0 0 2.3 0l3.9-3.9" />
    <path d="M9.5 9.5 12 12" />
  </TbSvg>
)

// Тендеры (прочее) — коробка/прочие закупки
export const IconOther = ({ size }) => (
  <TbSvg size={size}>
    <path d="M21 8v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8" />
    <rect x="2" y="4" width="20" height="4" rx="1" />
    <path d="M10 12h4" />
  </TbSvg>
)
