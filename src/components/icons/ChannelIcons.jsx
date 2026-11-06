// Логотипы каналов СУ-10 на экране регистрации подрядчика. Рисунок — прямо в странице: чужие адреса политика содержимого
// сайта не пропускает, а подрядчик ещё не вошёл, и лишних запросов наружу быть не должно.

// Логотип мессенджера MAX: векторная копия max.ru/s/img/big-logo.png (Wikimedia Commons, «Логотип MAX.svg»).
// Значок «Max» из simple-icons и dashboard-icons — другой продукт, не брать.
export function MaxLogo({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1000 1000" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="osp-max-base" x1="117.847" x2="1000" y1="760.536" y2="500" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4cf" />
          <stop offset=".662" stopColor="#53e" />
          <stop offset="1" stopColor="#93d" />
        </linearGradient>
        <radialGradient
          id="osp-max-glow" cx="-87.392" cy="1166.116" r="500" fx="-87.392" fy="1166.116"
          gradientTransform="rotate(51.356 1551.478 559.3)scale(2.42703433 1)" gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#00f" />
          <stop offset="1" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1000" height="1000" fill="url(#osp-max-base)" ry="249.681" />
      <rect width="1000" height="1000" fill="url(#osp-max-glow)" ry="249.681" />
      <path
        fill="#fff" fillRule="evenodd" clipRule="evenodd"
        d="M508.211 878.328c-75.007 0-109.864-10.95-170.453-54.75-38.325 49.275-159.686 87.783-164.979 21.9 0-49.456-10.95-91.248-23.36-136.873-14.782-56.21-31.572-118.807-31.572-209.508 0-216.626 177.754-379.597 388.357-379.597 210.785 0 375.947 171.001 375.947 381.604.707 207.346-166.595 376.118-373.94 377.224m3.103-571.585c-102.564-5.292-182.499 65.7-200.201 177.024-14.6 92.162 11.315 204.398 33.397 210.238 10.585 2.555 37.23-18.98 53.837-35.587a189.8 189.8 0 0 0 92.71 33.032c106.273 5.112 197.08-75.794 204.215-181.95 4.154-106.382-77.67-196.486-183.958-202.574Z"
      />
    </svg>
  )
}

// Логотип Telegram (simple-icons), фирменный цвет.
export function TelegramLogo({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#26A5E4" aria-hidden="true" focusable="false">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  )
}

// Официальный сайт — значком сайта.
export function GlobeIcon({ size = 18 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}
