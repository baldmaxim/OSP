// Вход: фаза A — Supabase Auth (методы и ответы как у supabase.auth), фаза B — Keycloak su10
// через BFF osp-api. Пользуются только RoleContext и сервисы, которым нужен текущий пользователь.
import { supabase } from './supabaseClient'

export const auth = supabase.auth
