import { Fragment } from 'react'

// Длинные имена файлов и адреса почты переносятся после разделителей (_ - . @ / \), а не
// посреди числа или слова («…com_2|026-10-15»). <wbr> — точка переноса, которая не попадает в
// копируемый текст (в отличие от невидимого пробела, который испортил бы скопированный адрес).
const SEPARATORS = /([_\-.@/\\])/

export default function SoftBreaks({ text }) {
  return String(text ?? '').split(SEPARATORS).map((part, i) => (
    i % 2 === 1 ? <Fragment key={i}>{part}<wbr /></Fragment> : part
  ))
}
