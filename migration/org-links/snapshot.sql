-- Снимок контрагентов для подсказок «организация СУ-10 → контрагент» (migration/org-links/build.mjs). ТОЛЬКО ЧТЕНИЕ:
-- транзакция READ ONLY (запись в ней невозможна), отметка служебной операции — чтобы правила по строкам (FORCE RLS) не
-- скрыли строки, затем ROLLBACK. Почты контактов из базы не выходят — только часть после «@».
--
-- Запуск (одно подключение; вывод — одна строка JSON; каталог вне git, права 0700/0600):
--   install -d -m 700 migration/target/reports/org-links-<дата>
--   ( umask 077; source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--       && target_pin_check ~/.osp-secrets/target.env \
--       && PGAPPNAME=osp-check-readonly psql -X -q -At -v ON_ERROR_STOP=1 -f migration/org-links/snapshot.sql \
--       > migration/target/reports/org-links-<дата>/counterparties.json )
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_catalog.set_config('application_name', 'osp:internal', true) \gset ignored_

WITH cp AS (
  SELECT c.id, c.name, c.inn, c.status::text AS status, (to_jsonb(c) ->> 'counterparty_number')::int AS number
  FROM public.counterparties c
  WHERE c.deleted_at IS NULL
),
contracts AS (
  SELECT x.cp, count(*)::int AS n FROM (
    SELECT counterparty_id AS cp FROM public.contracts WHERE counterparty_id IS NOT NULL
    UNION ALL
    SELECT counterparty_id FROM public.contract_counterparties
  ) x GROUP BY x.cp
),
tenders AS (
  SELECT counterparty_id AS cp, count(*)::int AS n FROM public.tender_counterparties GROUP BY counterparty_id
),
relations AS (
  SELECT x.cp, count(*)::int AS n FROM (
    SELECT counterparty_id AS cp FROM public.counterparty_relations
    UNION ALL
    SELECT related_counterparty_id FROM public.counterparty_relations
  ) x GROUP BY x.cp
),
domains AS (
  SELECT counterparty_id AS cp, array_agg(DISTINCT lower(btrim(split_part(email, '@', 2)))) AS d
  FROM public.counterparty_contacts
  WHERE email LIKE '%_@_%.%'
  GROUP BY counterparty_id
)
SELECT json_build_object(
  'taken_at', now(),
  'counterparties', coalesce((
    SELECT json_agg(json_build_object(
      'id', cp.id, 'number', cp.number, 'name', cp.name, 'inn', cp.inn, 'status', cp.status,
      'contracts', coalesce(contracts.n, 0), 'tenders', coalesce(tenders.n, 0), 'relations', coalesce(relations.n, 0),
      'domains', coalesce(domains.d, '{}')) ORDER BY cp.number NULLS LAST, cp.id)
    FROM cp
    LEFT JOIN contracts ON contracts.cp = cp.id
    LEFT JOIN tenders ON tenders.cp = cp.id
    LEFT JOIN relations ON relations.cp = cp.id
    LEFT JOIN domains ON domains.cp = cp.id), '[]'::json),
  'deleted', (SELECT count(*) FROM public.counterparties WHERE deleted_at IS NOT NULL),
  'contractor_accounts', (SELECT count(*) FROM public.user_roles WHERE counterparty_id IS NOT NULL OR role = 'contractor')
);

ROLLBACK;
