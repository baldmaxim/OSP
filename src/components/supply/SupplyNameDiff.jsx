import { useMemo } from 'react'
import { nameDiff } from '../../utils/supplyNameDiff'

// Наименование с подсвеченными отличиями от другой стороны (utils/supplyNameDiff): слова и числа, которых у другой стороны нет, —
// жёлтым. Окно «Счета и КП» (позиция ВОР и строка счёта) и окно «Строки счетов без позиции ВОР» (подсказки против строки счёта).
export default function SupplyNameDiff({ text, other, strong = false }) {
  const parts = useMemo(() => nameDiff(text, other), [text, other])
  const Tag = strong ? 'b' : 'span'
  return <Tag className="sp-td-name">{parts.map((p, i) => (p.differs ? <mark key={i} className="sp-td-diff">{p.text}</mark> : <span key={i}>{p.text}</span>))}</Tag>
}
