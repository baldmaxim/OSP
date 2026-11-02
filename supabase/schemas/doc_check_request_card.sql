-- Карточка заявки на проверку ДП/ДС: обсуждение и шаги (миграция 20261124). Справочно: источник истины — миграция.
-- Там же колонки doc_check_requests: email_link (адрес http(s)) и manual_assignees (имена текстом, до 20).

CREATE TABLE IF NOT EXISTS public.doc_check_request_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.doc_check_requests(id) ON DELETE CASCADE,
  author_user_id uuid,                                  -- ставит триггер (auth.uid())
  author_name text,                                     -- ФИО (иначе почта) на момент сообщения, ставит триггер
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),        -- ставит триггер
  CONSTRAINT doc_check_request_comments_body_check CHECK (char_length(body) BETWEEN 1 AND 4000)
);

CREATE TABLE IF NOT EXISTS public.doc_check_request_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.doc_check_requests(id) ON DELETE CASCADE,
  title text NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doc_check_request_steps_title_check CHECK (char_length(title) BETWEEN 1 AND 500)
);
