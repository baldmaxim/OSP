// Понятийное соглашение при завершении тендера основного строительства (решения пользователя 03.11.2026): при выборе
// «Завершен» шаблон сам попадает во вкладку «Документы» тендера, а завершить тендер можно только с победителем и
// подписанным соглашением. Остальные направления и тендеры на материалы завершаются как раньше.
//
// Соглашение — карточка tender_docs с файлами s3_documents; подписанный файл отличается категорией
// concept_agreement_signed, по ней же проверяет триггер базы tenders_concept_agreement_guard (миграция 20261210).
// Меняете категорию или условие — меняйте и триггер новой миграцией.

export const COMPLETED_STATUS = 'Завершен'
export const CONCEPT_CARD_TITLE = 'Понятийное соглашение'
export const CONCEPT_TEMPLATE_LINK_TITLE = 'Шаблон понятийного соглашения'
export const CONCEPT_TEMPLATE_FILE_NAME = 'Шаблон понятийного соглашения.docx'
export const CONCEPT_TEMPLATE_CATEGORY = 'concept_agreement_template'
export const CONCEPT_SIGNED_CATEGORY = 'concept_agreement_signed'

// Пустое направление — старые записи до tenders.department, это основное строительство (как utils/tenderStatuses.js).
export const conceptAgreementRequired = (tender) => (
  !!tender && tender.tender_type !== 'materials' && (tender.department || 'construction') === 'construction'
)

// Шаг нужен при переходе в «Завершен»: уже завершённый тендер (в том числе старые, без соглашения) не спрашиваем.
export const completionNeedsConcept = (tender) => conceptAgreementRequired(tender) && tender.status !== COMPLETED_STATUS

export const filesOfCategory = (card, category) => (card?.files || []).filter((f) => f.doc_category === category)
export const isConceptTitle = (title) => String(title || '').trim().toLowerCase() === CONCEPT_CARD_TITLE.toLowerCase()

const hasConceptFiles = (card) => (card?.files || []).some((f) => (
  f.doc_category === CONCEPT_SIGNED_CATEGORY || f.doc_category === CONCEPT_TEMPLATE_CATEGORY
))

// Карточку могли переименовать — файлы соглашения важнее названия.
export const isConceptCard = (card) => hasConceptFiles(card) || isConceptTitle(card?.title)
export const findConceptCard = (cards) => (cards || []).find(hasConceptFiles) || (cards || []).find((c) => isConceptTitle(c.title)) || null

// Что мешает завершить: пусто — можно.
export function completionBlockers({ winnersCount, signedCount }) {
  const out = []
  if (!winnersCount) out.push('выберите победителя')
  if (!signedCount) out.push('загрузите подписанное понятийное соглашение')
  return out
}

const SIGNED_EXTENSIONS = ['pdf', 'doc', 'docx', 'rtf', 'odt', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'heic', 'webp']
export const CONCEPT_SIGNED_ACCEPT = SIGNED_EXTENSIONS.map((ext) => `.${ext}`).join(',')
const SIGNED_MAX_MB = 50

// Подписанный файл: документ или скан. null — подходит, иначе причина.
export function signedFileProblem(file) {
  const ext = String(file?.name || '').split('.').pop().toLowerCase()
  if (!SIGNED_EXTENSIONS.includes(ext)) return 'нужен PDF, Word или скан'
  if (!file.size) return 'файл пустой'
  if (file.size > SIGNED_MAX_MB * 1024 * 1024) return `больше ${SIGNED_MAX_MB} МБ`
  return null
}

// ИНН в ручном добавлении необязателен; записанный — 10 или 12 цифр (ИНН, БИН). null — подходит.
export const innProblem = (inn) => (!inn || /^(\d{10}|\d{12})$/.test(inn) ? null : 'ИНН — 10 или 12 цифр')
