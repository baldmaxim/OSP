import crypto from 'node:crypto'
import fs from 'node:fs'

// Схемы Supabase вне public для синтетического «прода»: вход (auth — колонки как у Supabase Auth),
// хранилище (storage), расписания (cron), онлайн-обновления (realtime). Нужны выгрузке учёток, списку
// обложек и описи (migration/backup/extras.sql). Одноразовые коды и отпечатки паролей — заметные строки:
// тесты проверяют, что ни то ни другое не выгружается и не попадает в вывод.
export const PLATFORM_USERS = [
  { id: 'a0000000-0000-4000-8000-000000000001', email: 'admin@example.ru' },
  { id: 'a0000000-0000-4000-8000-000000000002', email: 'anna@example.ru' },
  { id: 'a0000000-0000-4000-8000-000000000003', email: 'boris@example.ru' },
]
export const HASH_MARK = 'HASH-zz9-'
export const TOKEN_MARK = 'TOKEN-zz9-'
export const COVERS = [
  { name: '11111111-aaaa-4aaa-8aaa-111111111111.jpg', mimetype: 'image/jpeg' },
  { name: '22222222-bbbb-4bbb-8bbb-222222222222.png', mimetype: 'image/png' },
  { name: '33333333-cccc-4ccc-8ccc-333333333333.webp', mimetype: 'image/webp' },
]

export const PLATFORM_SQL = `
create schema if not exists auth; create schema storage; create schema cron; create schema realtime;
create table auth.users (
  instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255),
  encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz,
  confirmation_token varchar(255), confirmation_sent_at timestamptz, recovery_token varchar(255), recovery_sent_at timestamptz,
  email_change_token_new varchar(255), email_change varchar(255), email_change_sent_at timestamptz,
  last_sign_in_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
  created_at timestamptz, updated_at timestamptz, phone text unique default null, phone_confirmed_at timestamptz,
  phone_change text default '', phone_change_token varchar(255) default '', phone_change_sent_at timestamptz,
  confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  email_change_token_current varchar(255) default '', email_change_confirm_status smallint default 0,
  banned_until timestamptz, reauthentication_token varchar(255) default '', reauthentication_sent_at timestamptz,
  is_sso_user boolean not null default false, deleted_at timestamptz, is_anonymous boolean not null default false);
create table auth.identities (
  provider_id text not null, user_id uuid not null references auth.users(id) on delete cascade, identity_data jsonb not null,
  provider text not null, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
  email text generated always as (lower(identity_data ->> 'email')) stored, id uuid primary key default gen_random_uuid());
create table auth.sessions (id uuid primary key, user_id uuid, created_at timestamptz);
create table auth.refresh_tokens (id bigserial primary key, token varchar(255), user_id varchar(255), session_id uuid);
create table auth.audit_log_entries (id uuid primary key, payload json, created_at timestamptz);
create table auth.mfa_factors (id uuid primary key, user_id uuid not null, factor_type text);
create table storage.buckets (id text primary key, name text not null, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), metadata jsonb);
alter table storage.objects enable row level security;
create table cron.job (jobid bigserial primary key, schedule text, command text, jobname text);
create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text);
create table realtime.subscription (id bigserial primary key, created_at timestamptz default now());

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, recovery_token, confirmation_token,
                        last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ${PLATFORM_USERS.map((u, i) => `('${u.id}', 'authenticated', 'authenticated', '${u.email}', '$2a$10$${HASH_MARK}${i}',
        '2026-09-0${i + 1} 10:00:00+00', '${TOKEN_MARK}recovery-${i}', '${TOKEN_MARK}confirm-${i}', '2026-10-0${i + 1} 08:30:15.123456+00',
        '{"provider": "email", "providers": ["email"]}', '{"full_name": "Пользователь ${i}", "note": "строка с \\"кавычками\\", запятой"}',
        '2026-08-0${i + 1} 09:00:00+00', '2026-10-0${i + 1} 08:30:15.123456+00')`).join(',\n       ')};
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
select id::text, id, jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true), 'email', created_at, updated_at from auth.users;
insert into auth.sessions select gen_random_uuid(), id, now() from auth.users;
insert into auth.refresh_tokens (token, user_id, session_id) select '${TOKEN_MARK}refresh', user_id::text, id from auth.sessions;
insert into auth.audit_log_entries select gen_random_uuid(), '{}'::json, now() from generate_series(1, 5);
insert into storage.buckets values ('object-photos', 'object-photos', true);
insert into storage.objects (bucket_id, name, metadata)
values ${COVERS.map((c, i) => `('object-photos', '${c.name}', '{"size": ${1000 + i}, "mimetype": "${c.mimetype}"}')`).join(', ')};
insert into cron.job (schedule, command, jobname) values ('*/10 * * * *', 'select public.refresh_rates_registry()', 'refresh-rates-registry');
insert into cron.job_run_details (jobid, status) select 1, 'succeeded' from generate_series(1, 4);
`

// Журнал covers-copy, как после успешного копирования всех обложек списка копии (без самого копирования).
export function coversJournal(dump, file, sourceBase = 'https://test-ref.supabase.co/storage/v1/object/public/object-photos/') {
  const text = fs.readFileSync(dump.replace(/\.dump$/, '.covers.csv'), 'utf8')
  const names = text.split('\n').filter(Boolean).slice(1).map((l) => l.split(',')[0])
  fs.writeFileSync(file, JSON.stringify({
    tool: 'covers-copy', version: 1, list_sha256: crypto.createHash('sha256').update(text).digest('hex'),
    source_base: sourceBase, target_prefix: 'covers/', finished_at: new Date().toISOString(),
    files: names.map((name, i) => ({ name, size: 1000 + i, sha256: String(i).repeat(64), status: 'verified' })),
  }))
  return file
}
