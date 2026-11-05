-- «Заявка на ДП» (миграция 20261227). Справочно: источник истины — миграция.

CREATE TABLE IF NOT EXISTS public.dp_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number integer UNIQUE,                         -- постоянный номер: ставит база при подаче, у черновика пусто
  object_id uuid NOT NULL REFERENCES public.objects(id) ON DELETE CASCADE,
  contract_title text NOT NULL,                          -- договор текстом
  amount numeric(15, 2) NOT NULL,
  responsible_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  responsible_name text,                                 -- ФИО на момент назначения; у контакта ставит триггер
  responsible_role text,                                 -- economist | construction_manager
  reason text NOT NULL,                                  -- комментарий: причина создания ДП
  status text NOT NULL DEFAULT 'draft',                  -- draft → new → in_work → completed
  status_changed_at timestamptz,                         -- ставит триггер
  status_changed_by_name text,                           -- ставит триггер
  created_by uuid,                                       -- ставит триггер
  created_by_name text,                                  -- ставит триггер
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_name text                                   -- ставит триггер
);
-- Файлы — s3_documents: owner_type = 'dp_request', doc_category = 'dp_concept_agreement' и 'dp_contract_doc' (оба обязательны).

CREATE TABLE IF NOT EXISTS public.dp_request_alert_recipients (
  user_id uuid PRIMARY KEY,                              -- кому всплывает окно о новой заявке
  added_by uuid DEFAULT auth.uid(),
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dp_request_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.dp_requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,                                   -- ставит dp_request_alerts_ack, когда человек закрыл окно
  UNIQUE (request_id, user_id)
);
