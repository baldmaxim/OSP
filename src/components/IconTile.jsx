import './IconTile.css'

// Плитка-подложка под иконку — тот же приём, что у пунктов бокового меню
// (.nav-ic в Sidebar.css): скруглённый квадрат, тонированные фон и рамка,
// иконка внутри наследует цвет тона.
//
// Собственные тона, а не .tone-* из Sidebar.css: страница не должна зависеть
// от того, отрендерено ли меню, и от чужого файла стилей.
//
// tone: sky | green | violet | slate | rose | amber | teal | sand
// size: сторона плитки в px (иконку передаём нужного размера сами).
export default function IconTile({ tone = 'slate', size = 28, className = '', children }) {
  return (
    <span
      className={`ic-tile ic-tile--${tone} ${className}`.trim()}
      style={size === 28 ? undefined : { width: size, height: size }}
      aria-hidden
    >
      {children}
    </span>
  )
}
