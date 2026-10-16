// Две миграции расценки снабжением — для прежнего портала (Supabase) и для базы Яндекса — должны создавать
// одно и то же: те же функции с теми же телами, те же колонки, таблицы и триггеры. Отличаются только права
// (роли Supabase против одной учётки) и отметка osp:internal у служебных функций Яндекса.
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SUPABASE = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261020_supply_pricing.sql'), 'utf8')
const YANDEX = fs.readFileSync(path.join(ROOT, 'migration', 'yandex', '20261020_supply_pricing.sql'), 'utf8')

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

it('функции те же и с теми же телами; отметка osp:internal — только у служебных функций Яндекса', () => {
  const a = functions(SUPABASE)
  const b = functions(YANDEX)
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort())
  assert.equal(Object.keys(a).length, 8)
  for (const name of Object.keys(a)) {
    assert.equal(b[name].args, a[name].args, name)
    assert.equal(b[name].body, a[name].body, `тело ${name}`)
    const definer = /SECURITY DEFINER/.test(a[name].header)
    assert.equal(/SECURITY DEFINER/.test(b[name].header), definer, name)
    assert.equal(/application_name = 'osp:internal'/.test(b[name].header), definer, `отметка ${name}`)
    assert.ok(!/application_name/.test(a[name].header), `в Supabase без отметки: ${name}`)
  }
})

it('колонки, таблицы, представление, индексы и триггеры совпадают', () => {
  for (const re of [
    /ALTER TABLE public\.tender_vor_supply_rates ADD COLUMN[^;]*;/g,
    /CREATE TABLE IF NOT EXISTS public\.\w+ \([^;]*;/g,
    /CREATE OR REPLACE VIEW[^;]*;/g,
    /CREATE (UNIQUE )?INDEX[^;]*;/g,
    /CREATE TRIGGER[^;]*;/g,
    /ADD CONSTRAINT[^;]*;/g,
  ]) assert.deepEqual(statements(YANDEX, re), statements(SUPABASE, re), String(re))
})

it('в миграции Яндекса нет ролей Supabase и транзакции; в Supabase — есть транзакция и снятие прав у гостя', () => {
  // Как migrate.sh: запреты — по тексту без комментариев «--».
  const code = YANDEX.replace(/--.*$/gm, '')
  assert.doesNotMatch(code, /\b(to|from)\s+(public\s*,\s*)?(anon|authenticated|service_role)\b/i)
  assert.doesNotMatch(code, /^\s*(begin|commit|rollback)\s*;/im)
  assert.match(SUPABASE, /^BEGIN;/m)
  assert.match(SUPABASE, /^COMMIT;/m)
  assert.match(SUPABASE, /REVOKE ALL ON TABLE public\.tender_supply_sources, public\.tender_supply_rate_log, public\.tender_supply_progress\s+FROM PUBLIC, anon, authenticated;/)
})
