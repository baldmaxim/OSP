-- Адреса обложек объектов (load.sh --covers <журнал>, та же транзакция загрузки, после данных копии).
-- Единственная правка данных при загрузке, и она объявлена явно: обложка, скопированная в cloud.ru и
-- сверенная обратным скачиванием (журнал covers-copy), получает адрес /api/covers/<имя> на сайте
-- портала. Меняется только objects.cover_image_url, только при точном совпадении прежнего адреса.
--   • Число заменённых строк обязано равняться числу строк, чей адрес оканчивается на
--     /object-photos/<имя сверенного файла>: адрес другого вида — отмена всей загрузки, а не пропуск.
--   • Триггеры objects на время замены выключены: иначе у объектов сменилась бы дата изменения.
--     Включаются ровно в прежнем состоянии.
--   • При окончательном переносе (final) ни одна обложка не может остаться в хранилище Supabase.
-- Та же замена делается на эталоне сверки (verify.sh --covers), поэтому сверка остаётся «строка в строку».
-- Переменные psql: covers_data_file (osp_meta.cover_moves, lib/extras.mjs), status.
\i :covers_data_file
SELECT pg_catalog.set_config('osp.load_status', :'status', true);

DO $covers$
DECLARE
  v_expected bigint;
  v_updated bigint;
  v_left bigint;
  r record;
  v_triggers text[][] := '{}';
BEGIN
  -- Таблицы объектов нет (синтетическая копия) — менять нечего.
  IF pg_catalog.to_regclass('public.objects') IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_catalog.count(*) INTO v_expected
  FROM public.objects o
  JOIN osp_meta.cover_moves m ON pg_catalog.right(o.cover_image_url, pg_catalog.length(m.name) + 15) = '/object-photos/' || m.name;

  FOR r IN
    SELECT t.tgname, t.tgenabled FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.objects'::pg_catalog.regclass AND NOT t.tgisinternal AND t.tgenabled <> 'D'
    ORDER BY t.tgname
  LOOP
    v_triggers := v_triggers || ARRAY[[r.tgname::text, r.tgenabled::text]];
    EXECUTE pg_catalog.format('ALTER TABLE public.objects DISABLE TRIGGER %I', r.tgname);
  END LOOP;

  UPDATE public.objects o SET cover_image_url = m.new_url
  FROM osp_meta.cover_moves m
  WHERE o.cover_image_url = m.old_url;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  FOR i IN 1 .. coalesce(pg_catalog.array_length(v_triggers, 1), 0) LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.objects ENABLE %sTRIGGER %I',
      CASE v_triggers[i][2] WHEN 'A' THEN 'ALWAYS ' WHEN 'R' THEN 'REPLICA ' ELSE '' END, v_triggers[i][1]);
  END LOOP;

  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'OSP_COVERS_MISMATCH: заменено адресов %, ожидалось %: адрес обложки другого вида', v_updated, v_expected;
  END IF;
  UPDATE osp_meta.cover_moves m
  SET objects_updated = (SELECT pg_catalog.count(*) FROM public.objects o WHERE o.cover_image_url = m.new_url);

  SELECT pg_catalog.count(*) INTO v_left FROM public.objects
  WHERE cover_image_url ~ '/storage/v1/object/public/object-photos/';
  IF pg_catalog.current_setting('osp.load_status') = 'final' AND v_left > 0 THEN
    RAISE EXCEPTION 'OSP_COVERS_LEFT: обложек в хранилище Supabase осталось %', v_left;
  END IF;
END
$covers$;
