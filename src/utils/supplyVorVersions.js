// Версии ВОР в расценке снабжением (миграция 20261029): сметный отдел обновил ВОР — что спросить у снабжения и что
// подсветить. Только решения «что показать» — без запросов; выполняет SupplyPricingPanel.
//
// Правило пользователя (21.10): цена переходит в новую версию сама только при полном совпадении наименования (тот же
// ключ normName = supply_norm_name — это делает база: строка цены та же). Всё остальное — спросить:
//  • файл ВОР с другим именем — новая версия прежнего ВОР или отдельный ВОР (versionQuestions);
//  • цена убранной позиции — перенести на похожую новую или нет (carrySuggestions);
//  • у позиции другая ед. изм. — цена за прежнюю единицу верна или нет (unitMismatch).
// Что изменилось с последнего просмотра — composeChanges (по непросмотренным версиям из базы).
import { nameParts, scoreParts, normUnit, unitsCompatible, MATCH_MIN, MATCH_WORDS_MIN } from './supplySimilarity.js'

const keysOf = (s) => new Set((s.positions || []).map((p) => p.k).filter(Boolean))

// Файл ВОР, который мог прийти новой версией прежнего ВОР (а завёлся отдельным: имя файла другое). Спрашиваем про
// список из живого файла, на который ещё не ответили «отдельный ВОР», если есть прежний ВОР постарше с ценами или
// документами (valuable — имена таких ВОР), и:
//  • прежний устарел — его файл удалён из «ВОРов и РД» (или позиции из вкладки «ВОР», а файлы уже есть), и хоть один
//    материал совпадает;
//  • или оба файла на месте, но материалы совпадают не меньше чем наполовину с обеих сторон (так похожи версии одного
//    ВОР, а соседние ВОР — корпуса, системы — обычно нет; если всё же да — человек ответит «отдельный ВОР» один раз).
// Ответ: [{ name, fileName, docId, candidates: [{ name, common, oldCount, newCount, stale, fileName, source }] }],
// кандидаты — сначала устаревшие, затем по числу совпавших материалов.
export function versionQuestions(sources, files, valuable) {
  const fileIds = new Set(files.map((f) => f.id))
  const live = (s) => s.source === 'vor_file' && !!s.s3_document_id && fileIds.has(s.s3_document_id)
  const anyFile = sources.some(live)
  const out = []
  for (const n of sources) {
    if (!live(n) || n.separate_at) continue
    const nk = keysOf(n)
    if (!nk.size) continue
    const candidates = []
    for (const o of sources) {
      if (o === n || !valuable.has(o.estimate_name)) continue
      // Прежний — строго старше: списки одного прохода разбора друг про друга не спрашивают.
      if (!(String(o.created_at || '') < String(n.created_at || ''))) continue
      const ok = keysOf(o)
      if (!ok.size) continue
      let common = 0
      for (const k of nk) if (ok.has(k)) common += 1
      const stale = o.source === 'vor_file' ? !live(o) : anyFile
      if (stale ? common > 0 : common * 2 >= ok.size && common * 2 >= nk.size) {
        candidates.push({ name: o.estimate_name, common, oldCount: ok.size, newCount: nk.size, stale, fileName: o.file_name || null, source: o.source })
      }
    }
    if (!candidates.length) continue
    candidates.sort((a, b) => Number(b.stale) - Number(a.stale) || b.common - a.common || a.name.localeCompare(b.name, 'ru'))
    out.push({ name: n.estimate_name, fileName: n.file_name || null, docId: n.s3_document_id, candidates })
  }
  return out
}

// Ед. изм. позиции для сравнения: в едином виде (kp_norm_unit = normUnit), без повторов, по алфавиту. text — как в
// версии из базы («м, шт» — у позиции с несколькими единицами).
const sigOfText = (text) => [...new Set(String(text ?? '').split(',').map((u) => normUnit(u)).filter(Boolean))].sort().join('|')
const sigOfPosition = (p) => [...new Set((p.units ? p.units.map((u) => u.unit) : [p.unit]).map((u) => normUnit(u)).filter(Boolean))].sort().join('|')
const num = (v) => (v == null || v === '' ? null : Number(v))
const sameVolume = (a, b) => (a == null || b == null ? a == null && b == null : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)))

// Что изменилось в позициях ВОР с последнего просмотра: по ключу — состояние до первой непросмотренной версии
// (update) и текущие позиции (docViews: [{ name, positions }]). Несколько версий подряд складываются: добавили и
// убрали — ничего; объём 10 → 12 → 15 — «было 10»; вернули как было — ничего.
// Ответ: Map(ВОР → Map(ключ → { op: added | removed | unit | volume, name, oldUnit, oldVolume, price, at })).
export function composeChanges(revisions, docViews) {
  const first = new Map()
  const updates = revisions.filter((r) => r.kind === 'update' && !r.reviewed_at).sort((a, b) => a.id - b.id)
  for (const rev of updates) {
    let m = first.get(rev.estimate_name)
    if (!m) first.set(rev.estimate_name, (m = new Map()))
    for (const c of rev.changes || []) {
      if (!c.k || m.has(c.k)) continue
      m.set(c.k, c.op === 'added'
        ? { had: false, at: rev.created_at }
        : { had: true, name: c.name, unit: c.old_unit ?? null, volume: num(c.old_volume), price: num(c.price), op: c.op, at: rev.created_at })
    }
  }
  const out = new Map()
  for (const d of docViews) {
    const m = first.get(d.name)
    if (!m) continue
    const now = new Map(d.positions.map((p) => [p.k, p]))
    const res = new Map()
    for (const [k, was] of m) {
      const p = now.get(k)
      if (!p) {
        if (was.had) res.set(k, { op: 'removed', name: was.name, oldUnit: was.unit, oldVolume: was.volume, price: was.price, at: was.at })
        continue
      }
      if (!was.had) { res.set(k, { op: 'added', at: was.at }); continue }
      if (sigOfText(was.unit) !== sigOfPosition(p)) {
        res.set(k, { op: 'unit', oldUnit: was.unit, oldVolume: was.volume, at: was.at })
      } else if (p.units ? was.op === 'volume' : !sameVolume(num(p.volume), was.volume)) {
        res.set(k, { op: 'volume', oldVolume: p.units ? null : was.volume, at: was.at })
      }
    }
    if (res.size) out.set(d.name, res)
  }
  return out
}

// У цены другая ед. изм., чем у позиции сейчас (ВОР обновили, единицу сменили): цена за прежнюю единицу. Только у
// позиции с одной единицей и цены с известной единицей; «м» и «пог. м» — одно.
export function unitMismatch(rate, position) {
  if (!rate || !position || position.units) return false
  const a = String(rate.unit || '').trim()
  const b = String(position.unit || '').trim()
  return !!a && !!b && !unitsCompatible(a, b)
}

// Цены убранных позиций (orphans — расценки, наименования которых нет в позициях своего ВОР), которые похожи на
// позиции того же ВОР без своей цены: перенести ли — решает человек. Своя цена — не цена из другого тендера (их база
// подставит заново); позиция-цель — с одной ед. изм., без своей цены (подставленная из другого тендера уступит), та
// же или совместимая единица; похожесть — как у сопоставления документа поставщика (каждую пару проверяет человек).
// Пара — одна на цену и одна на позицию, лучшие первыми. skip(rate, key) — человек уже ответил «не то».
// Ответ: { byTarget: Map(«ВОР∣ключ» → { rate, score }), byRate: Map(id цены → { key, doc, position, score }) }.
export function carrySuggestions(docViews, orphans, ownRateAt, skip = () => false) {
  const byTarget = new Map()
  const byRate = new Map()
  const views = new Map(docViews.map((d) => [d.name, d]))
  const byDoc = new Map()
  for (const r of orphans) {
    if (r.source_kind === 'auto' || !views.has(r.estimate_name)) continue
    if (!byDoc.has(r.estimate_name)) byDoc.set(r.estimate_name, [])
    byDoc.get(r.estimate_name).push(r)
  }
  for (const [doc, rates] of byDoc) {
    const targets = views.get(doc).positions.filter((p) => !p.units && p.k && !ownRateAt(doc, p.k))
    if (!targets.length) continue
    const tParts = targets.map((p) => nameParts(p.name))
    const pairs = []
    for (const r of rates) {
      const rParts = nameParts(r.material_name)
      targets.forEach((p, i) => {
        if (r.unit && p.unit && !unitsCompatible(r.unit, p.unit)) return
        const key = `${doc}∣${p.k}`
        if (skip(r, key)) return
        const s = scoreParts(rParts, tParts[i])
        if (s.score >= MATCH_MIN && s.words >= MATCH_WORDS_MIN) pairs.push({ r, p, key, score: s.score })
      })
    }
    pairs.sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name, 'ru'))
    for (const { r, p, key, score } of pairs) {
      if (byRate.has(r.id) || byTarget.has(key)) continue
      byRate.set(r.id, { key, doc, position: p, score })
      byTarget.set(key, { rate: r, score })
    }
  }
  return { byTarget, byRate }
}

// Позиции ВОР без своей цены — куда можно перенести цену вручную (меню у цены убранной позиции): сначала похожие.
export function carryTargets(docView, rate, ownRateAt, limit = 12) {
  if (!docView) return []
  const rParts = nameParts(rate.material_name)
  return docView.positions
    .filter((p) => !p.units && p.k && !ownRateAt(docView.name, p.k))
    .map((p) => ({ position: p, score: scoreParts(rParts, nameParts(p.name)).score, sameUnit: !rate.unit || !p.unit || unitsCompatible(rate.unit, p.unit) }))
    .sort((a, b) => Number(b.sameUnit) - Number(a.sameUnit) || b.score - a.score || a.position.name.localeCompare(b.position.name, 'ru'))
    .slice(0, limit)
}

// Коротко, что изменилось в версии: «новых 3 · убрано 2 (с ценой 1) · объём 5 · ед. изм. 1».
export function revisionCounts(rev) {
  const parts = []
  if (rev.added) parts.push(`новых ${rev.added}`)
  if (rev.removed) parts.push(`убрано ${rev.removed}${rev.priced_removed ? ` (с ценой ${rev.priced_removed})` : ''}`)
  if (rev.volume_changed) parts.push(`объём ${rev.volume_changed}`)
  if (rev.unit_changed) parts.push(`ед. изм. ${rev.unit_changed}`)
  return parts.join(' · ')
}

// Что случилось с ВОР одной фразой — для шапки ВОР, уведомления и реестра.
export function revisionTitle(rev) {
  if (rev.kind === 'removed') return `файл «${rev.old_file_name || 'ВОР'}» удалён из «ВОРов и РД» — позиции и цены остались`
  if (rev.kind === 'added') return `добавлен ВОР${rev.new_file_name ? ` из файла «${rev.new_file_name}»` : ' из вкладки «ВОР»'}: позиций ${rev.positions_after}`
  const what = !rev.new_file_name ? 'вкладка «ВОР» перезагружена'
    : !rev.old_file_name ? `позиции — из файла «${rev.new_file_name}» (были из вкладки «ВОР»)`
      : rev.old_file_name !== rev.new_file_name ? `новый файл «${rev.new_file_name}» вместо «${rev.old_file_name}»`
        : `файл «${rev.new_file_name}» заменён новым`
  const counts = revisionCounts(rev)
  return counts ? `${what}: ${counts}` : `${what}, материалы те же`
}
