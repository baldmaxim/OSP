// Две миграции расценки снабжением — для прежнего портала (Supabase) и для базы Яндекса — должны создавать
// одно и то же: те же функции с теми же телами, те же колонки, таблицы и триггеры. Отличаются только права
// (роли Supabase против одной учётки) и отметка osp:internal у служебных функций Яндекса.
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')
// Пары миграций: расценка (20261020), ссылки на документы к позициям (20261022, переопределяет перенос ВОР), цены
// из других тендеров (20261023, переопределяет расчёт и пересобирает реестр СУ-10 — у Яндекса он в osp_private) и
// состояние разбора позиций службой osp-api (20261024).
const PAIRS = [
  { name: '20261020_supply_pricing', functions: 8, revoke: /REVOKE ALL ON TABLE public\.tender_supply_sources, public\.tender_supply_rate_log, public\.tender_supply_progress\s+FROM PUBLIC, anon, authenticated;/ },
  { name: '20261022_supply_links', functions: 2, revoke: /REVOKE ALL ON TABLE public\.tender_supply_links FROM PUBLIC, anon, authenticated;/ },
  { name: '20261023_supply_rate_reuse', functions: 8, revoke: /REVOKE ALL ON TABLE public\.supply_rates_registry_mv FROM PUBLIC, anon, authenticated;/, privateSchema: true },
  { name: '20261024_supply_import_state', functions: 0, revoke: /REVOKE ALL ON TABLE public\.tender_supply_import_state FROM PUBLIC, anon, authenticated;/ },
  // Файл документа к позиции и новая похожесть: триггер ссылок, 9 функций похожести и 3 функции подбора.
  { name: '20261025_supply_docs_similarity', functions: 13, revoke: /REVOKE ALL ON FUNCTION public\.supply_name_score\(text\[\], text\[\], text\[\], text\[\], numeric\) FROM PUBLIC, anon;/ },
  // Версии ВОР: расчёт списка и закрытие (переопределены), позиции по ключу, запись версии, новая версия под другим
  // именем, перенос цены, «просмотрено».
  { name: '20261029_supply_vor_versions', functions: 7, revoke: /REVOKE ALL ON TABLE public\.tender_supply_revisions FROM PUBLIC, anon, authenticated;/ },
]

// Без комментариев и с одинаковыми пробелами — сравниваются только сами команды.
const plain = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim()

function functions(sql) {
  const out = {}
  for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)) {
    out[m[1]] = { args: m[2], body: plain(m[3]), header: m[0].slice(0, m[0].indexOf('AS $$')) }
  }
  return out
}

function statements(sql, re) {
  return [...plain(sql).matchAll(re)].map((m) => m[0])
}

for (const pair of PAIRS) {
  const SUPABASE = read('supabase', 'migrations', `${pair.name}.sql`)
  const YANDEX = read('migration', 'yandex', `${pair.name}.sql`)
  // Закрытые объекты Яндекса (реестр) лежат в osp_private, в Supabase — в public: для сравнения схема одна.
  const YANDEX_SAME = pair.privateSchema ? YANDEX.replace(/osp_private\./g, 'public.') : YANDEX

  it(`${pair.name}: функции те же и с теми же телами; отметка osp:internal — только у служебных функций Яндекса`, () => {
    const a = functions(SUPABASE)
    const b = functions(YANDEX)
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort())
    assert.equal(Object.keys(a).length, pair.functions)
    for (const name of Object.keys(a)) {
      assert.equal(b[name].args, a[name].args, name)
      assert.equal(b[name].body, a[name].body, `тело ${name}`)
      const definer = /SECURITY DEFINER/.test(a[name].header)
      assert.equal(/SECURITY DEFINER/.test(b[name].header), definer, name)
      assert.equal(/application_name = 'osp:internal'/.test(b[name].header), definer, `отметка ${name}`)
      assert.ok(!/application_name/.test(a[name].header), `в Supabase без отметки: ${name}`)
    }
  })

  it(`${pair.name}: колонки, таблицы, представления, индексы и триггеры совпадают`, () => {
    for (const re of [
      /ALTER TABLE public\.tender_vor_supply_rates ADD COLUMN[^;]*;/g,
      /ALTER TABLE public\.tender_supply_sources ADD COLUMN[^;]*;/g,
      /CREATE TABLE IF NOT EXISTS public\.\w+ \([^;]*;/g,
      /CREATE OR REPLACE VIEW[^;]*;/g,
      /CREATE (UNIQUE )?INDEX[^;]*;/g,
      /CREATE TRIGGER[^;]*;/g,
      /ADD CONSTRAINT[^;]*;/g,
      /CREATE MATERIALIZED VIEW[^;]*;/g,
      /ALTER (MATERIALIZED VIEW|INDEX)[^;]*;/g,
      /(DISABLE|ENABLE) TRIGGER[^;]*;/g,
    ]) assert.deepEqual(statements(YANDEX_SAME, re), statements(SUPABASE, re), String(re))
  })

  it(`${pair.name}: в миграции Яндекса нет ролей Supabase и транзакции; в Supabase — есть транзакция и снятие прав у гостя`, () => {
    // Как migrate.sh: запреты — по тексту без комментариев «--».
    const code = YANDEX.replace(/--.*$/gm, '')
    assert.doesNotMatch(code, /\b(to|from)\s+(public\s*,\s*)?(anon|authenticated|service_role)\b/i)
    assert.doesNotMatch(code, /^\s*(begin|commit|rollback)\s*;/im)
    assert.match(SUPABASE, /^BEGIN;/m)
    assert.match(SUPABASE, /^COMMIT;/m)
    assert.match(SUPABASE, pair.revoke)
  })
}
