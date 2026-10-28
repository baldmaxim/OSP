// Плитки шаблонов для «Документов» разделов (SectionTemplateCards): одно описание шаблона — на все разделы,
// где он показан. Иконку добавляет окно.
import { SECTION_TEMPLATE, SECTION_TEMPLATE_LINK_KEY } from '../services/sectionTemplates'

// «Понятийное соглашение» — в «Тендерах — Основное строительство» и «Договорах и ДС»: одна ссылка на оба раздела.
export const CONCEPT_AGREEMENT_TEMPLATE = {
  code: SECTION_TEMPLATE.conceptAgreement,
  linkKey: SECTION_TEMPLATE_LINK_KEY.conceptAgreement,
  title: 'Понятийное соглашение',
  desc: 'Шаблон понятийного соглашения — ссылка на документ; та же в тендерах и в договорах',
}

// «Шаблон ДП» — в «Договорах и ДС»: ссылка, как у «Понятийного соглашения». Код — строка прежнего файла
// «Шаблон ДГП»: если файл успели прикрепить, он виден под ссылкой, пока администратор его не удалит.
export const CONTRACTS_DP_TEMPLATE = {
  code: SECTION_TEMPLATE.contractsDgp,
  linkKey: SECTION_TEMPLATE_LINK_KEY.contractsDp,
  title: 'Шаблон ДП',
  desc: 'Шаблон договора подряда — ссылка на документ',
}
