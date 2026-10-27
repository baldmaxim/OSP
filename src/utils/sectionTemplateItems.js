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

export const CONTRACTS_DGP_TEMPLATE = {
  code: SECTION_TEMPLATE.contractsDgp,
  title: 'Шаблон ДГП',
  desc: 'Шаблон договора генподряда — скачать и заполнить',
  migration: '20261109_contracts_dc_requests',
}
