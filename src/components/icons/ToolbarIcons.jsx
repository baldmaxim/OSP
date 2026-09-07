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

// Планы затрат — монеты (вместо эмодзи 💰 в шапке раздела)
export const IconCoins = ({ size }) => (
  <TbSvg size={size}>
    <ellipse cx="9" cy="6" rx="6" ry="2.5" />
    <path d="M3 6v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6" />
    <path d="M3 11v5c0 1.4 2.7 2.5 6 2.5 1 0 2-.1 2.8-.3" />
    <ellipse cx="17" cy="15" rx="5" ry="2.2" />
    <path d="M12 15v4c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2v-4" />
  </TbSvg>
)

// Обзвон объектов — телефонная трубка
export const IconPhone = ({ size }) => (
  <TbSvg size={size}>
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" />
  </TbSvg>
)

// Общая папка раздела — папка в сетевом хранилище
export const IconFolder = ({ size }) => (
  <TbSvg size={size}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </TbSvg>
)

// Структура хранения — дерево папок
export const IconFolderTree = ({ size }) => (
  <TbSvg size={size}>
    <path d="M2 3h5l1.5 2H13a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
    <path d="M6 10v8M6 14h4M6 18h4" />
    <rect x="10" y="12" width="12" height="4" rx="1" />
    <rect x="10" y="17" width="12" height="4" rx="1" />
  </TbSvg>
)

// Приложения объектов — стопка документов (вместо скрепки: речь о наборе
// стандартных приложений к договору, а не о прикреплённом файле)
export const IconDocsStack = ({ size }) => (
  <TbSvg size={size}>
    <path d="M15 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V6Z" />
    <path d="M15 2v4a1 1 0 0 0 1 1h3" />
    <path d="M6 6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2" />
    <path d="M9 11h5M9 14h5" />
  </TbSvg>
)
