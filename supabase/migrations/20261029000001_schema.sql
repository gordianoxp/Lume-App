-- Organizador Escolar — esquema do banco (PostgreSQL / Supabase)
-- Rode os 4 arquivos desta pasta, em ordem, no SQL Editor do Supabase (ou com `supabase db push`).

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- utilitários
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- perfis
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

-- cria o perfil automaticamente quando uma conta é criada
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
                  nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
                  'Aluno'), 60)
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- turmas
create table public.classes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique check (invite_code ~ '^[A-Z0-9]{8}$'),
  created_by  uuid references auth.users(id) on delete set null,
  settings    jsonb not null default '{"members_can_post": true}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger classes_updated before update on public.classes
  for each row execute function public.set_updated_at();

-- hash da senha de entrada: tabela separada, sem nenhuma política (inacessível pelo app)
create table public.class_secrets (
  class_id      uuid primary key references public.classes(id) on delete cascade,
  password_hash text not null
);

create table public.class_members (
  class_id  uuid not null references public.classes(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'member' check (role in ('admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (class_id, user_id)
);
create index class_members_user_idx on public.class_members (user_id);

-- tentativas de entrada (limite contra força bruta); sem políticas
create table public.join_attempts (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  code         text not null,
  attempted_at timestamptz not null default now()
);
create index join_attempts_user_idx on public.join_attempts (user_id, attempted_at);
create index join_attempts_code_idx on public.join_attempts (code, attempted_at);

-- ---------------------------------------------------------------- mural
create table public.posts (
  id            uuid primary key default gen_random_uuid(),
  class_id      uuid not null references public.classes(id) on delete cascade,
  author_id     uuid not null references auth.users(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 120),
  subject_name  text not null default '' check (char_length(subject_name) <= 40),
  subject_color text not null default '#64748b' check (subject_color ~ '^#[0-9a-fA-F]{6}$'),
  descr         text not null default '' check (char_length(descr) <= 5000),
  due           timestamp not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index posts_class_due_idx on public.posts (class_id, due);

create table public.post_files (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.posts(id) on delete cascade,
  class_id     uuid not null references public.classes(id) on delete cascade,
  uploader_id  uuid not null references auth.users(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 255),
  mime         text not null default '',
  size         bigint not null check (size >= 0 and size <= 52428800),
  storage_path text not null unique,
  created_at   timestamptz not null default now(),
  -- o caminho no Storage segue sempre este padrão (usado também pelas políticas do Storage)
  constraint post_files_path_ck check (
    storage_path = 'c/' || class_id::text || '/' || post_id::text || '/' || uploader_id::text || '/' || id::text)
);
create index post_files_post_idx on public.post_files (post_id);

-- ---------------------------------------------------------------- dados pessoais
create table public.subjects (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 40),
  color      text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  icon       text not null default '' check (char_length(icon) <= 16),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subjects_user_idx on public.subjects (user_id);
create trigger subjects_updated before update on public.subjects
  for each row execute function public.set_updated_at();

create table public.activities (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  subject_id    uuid references public.subjects(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 120),
  descr         text not null default '' check (char_length(descr) <= 5000),
  notes         text not null default '' check (char_length(notes) <= 2000),
  type          text not null default 'Atividade' check (char_length(type) <= 40),
  due           timestamp not null,
  priority      text not null default 'mid' check (priority in ('low', 'mid', 'high')),
  status        text not null default 'pending' check (status in ('pending', 'doing', 'done')),
  checklist     jsonb not null default '[]'::jsonb,
  rem           jsonb not null default '{}'::jsonb,
  focus_min     integer not null default 0 check (focus_min >= 0),
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- vínculo com uma publicação do mural (a conclusão é SEMPRE individual: cada usuário tem a sua linha)
  post_id       uuid references public.posts(id) on delete set null,
  post_removed  boolean not null default false,
  post_snapshot jsonb
);
create index activities_user_due_idx on public.activities (user_id, due);
create index activities_subject_idx on public.activities (subject_id);
create index activities_post_idx on public.activities (post_id);
-- impede adicionar duas vezes a mesma publicação à agenda
create unique index activities_user_post_uq on public.activities (user_id, post_id) where post_id is not null;
create trigger activities_updated before update on public.activities
  for each row execute function public.set_updated_at();

create table public.files (
  id           uuid primary key,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  subject_id   uuid references public.subjects(id) on delete set null,
  activity_id  uuid references public.activities(id) on delete set null,
  name         text not null check (char_length(name) between 1 and 255),
  mime         text not null default '',
  size         bigint not null check (size >= 0 and size <= 52428800),
  storage_path text not null unique,
  added_at     timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint files_path_ck check (storage_path = 'u/' || user_id::text || '/' || id::text)
);
create index files_user_idx on public.files (user_id);
create index files_activity_idx on public.files (activity_id);
create trigger files_updated before update on public.files
  for each row execute function public.set_updated_at();

create table public.user_settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
