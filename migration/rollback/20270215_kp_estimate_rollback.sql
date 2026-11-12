-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20270215_kp_estimate.sql (Supabase): блока «Смета КП / ПЗ» во вкладке «Смета» карточки
-- объекта больше нет (страница без прав на таблицы показывает подсказку про миграцию).
-- Данные НЕ удаляются: сметы, отметки, распределения и история остаются в таблицах (без прав у вошедших) — повторное
-- применение миграции продолжит с ними. Право раздела kp_estimate у ролей тоже остаётся. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS kp_estimate_marks_log ON public.kp_estimate_marks;
DROP TRIGGER IF EXISTS kp_estimate_allocations_log ON public.kp_estimate_allocations;
REVOKE ALL ON TABLE public.kp_estimates, public.kp_estimate_rows, public.kp_estimate_marks, public.kp_estimate_allocations,
  public.kp_estimate_log FROM authenticated;
REVOKE ALL ON FUNCTION public.kp_estimate_activate(uuid) FROM authenticated;

COMMIT;
