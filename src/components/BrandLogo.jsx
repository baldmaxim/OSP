import './BrandLogo.css'

// Текстовый логотип «СУ_10» в фирменном красном (блочный моноширинный стиль).
// Размер задаётся через font-size на родителе или классом-модификатором.
export default function BrandLogo({ className = '' }) {
  return (
    <span className={`brand-logo ${className}`.trim()} aria-label="СУ_10">СУ_10</span>
  )
}
