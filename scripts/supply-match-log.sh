#!/usr/bin/env bash
# Журнал ручных сопоставлений строк счетов и КП с позициями ВОР — выгрузка из базы Яндекса. ТОЛЬКО ЧТЕНИЕ: транзакция read only,
# в конце rollback; база не меняется.
#
# Что такое журнал. Каждый выбор человека в окне «Счета и КП тендера» записывается при файле (s3_documents.notes, utils/supplyOffers):
# k / ka — строку счёта сопоставили с позицией вручную («другая строка», «Строки счетов без позиции ВОР»), kn — «нет в счетах, не
# предлагать», pm — сколько единиц позиции в единице строки. Выгрузка берёт все такие файлы с позициями ВОР их тендеров; разбор —
# scripts/supply-match-review.mjs: что человек сопоставил и что предложил бы алгоритм (utils/supplyDocMatch). Порядок разбора —
# docs/claude-reference/supply-pricing.md, «Журнал ручных сопоставлений».
#
#   scripts/supply-match-log.sh [файл]   — по умолчанию ~/osp-match-log/export-ГГГГ-ММ-ДД.json (вне репозитория: в выгрузке
#                                           наименования и цены поставщиков, в git её не класть)
# Подключение — migration/target/lib/conn.sh и файл учётки (OSP_TARGET_ENV, по умолчанию ~/.osp-secrets/target.env) с проверкой
# отпечатка сервера.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-$HOME/osp-match-log/export-$(date +%F).json}
ENV_FILE=${OSP_TARGET_ENV:-$HOME/.osp-secrets/target.env}
mkdir -p "$(dirname "$OUT")"
# shellcheck source=../migration/target/lib/conn.sh
source migration/target/lib/conn.sh
target_conn "$ENV_FILE" >/dev/null
if ! target_pin_check "$ENV_FILE"; then echo "Отпечаток сервера базы не совпал — выгрузка не сделана." >&2; exit 3; fi
export PGAPPNAME=osp-match-log-readonly

psql -X -q -At -v ON_ERROR_STOP=1 -P pager=off > "$OUT.part" 2> >(target_mask >&2) <<'SQL'
begin transaction read only;
-- Служебное чтение (как у службы osp-api): иначе строки документов скрыты правилами доступа. Транзакция — только чтение.
select pg_catalog.set_config('application_name', 'osp:internal', true) \gset ignored_
with marked as (
  select d.id, d.owner_id as tender_id, d.file_name, d.created_at, d.notes
  from s3_documents d
  where d.owner_type = 'tender' and d.doc_category = 'supply_doc' and d.notes like '%supply_offer%'
    and (d.notes like '%"k":%' or d.notes like '%"ka":%' or d.notes like '%"kn":%')
)
select json_build_object('at', now(), 'tenders', coalesce((
  select json_agg(json_build_object(
    'id', t.id,
    'number', t.public_tender_number,
    'sources', (select coalesce(json_agg(json_build_object('name', s.estimate_name, 'positions', s.positions)), '[]')
                from tender_supply_sources s where s.tender_id = t.id),
    'docs', (select json_agg(json_build_object('id', m.id, 'file_name', m.file_name, 'created_at', m.created_at, 'notes', m.notes)
             order by m.created_at) from marked m where m.tender_id = t.id)
  ) order by t.public_tender_number)
  from tenders t where t.id in (select tender_id from marked)), '[]'));
rollback;
SQL
mv "$OUT.part" "$OUT"
echo "Выгрузка: $OUT"
