-- После 20261006: ровно одно ограничение user_roles.counterparty_id → counterparties,
-- и оно с ON DELETE RESTRICT. Строки «OK …» / «FAIL …»; только чтение.
select case when count(*) = 1 and bool_and(confdeltype = 'r') then 'OK' else 'FAIL' end
       || ' user_roles.counterparty_id → counterparties ON DELETE RESTRICT ('
       || coalesce(string_agg(conname || ': ' || case confdeltype
            when 'r' then 'RESTRICT' when 'n' then 'SET NULL' when 'c' then 'CASCADE'
            when 'a' then 'NO ACTION' when 'd' then 'SET DEFAULT' end, ', '), 'ограничения нет')
       || ')'
from pg_constraint
where conrelid = 'public.user_roles'::regclass and contype = 'f'
  and confrelid = 'public.counterparties'::regclass;
