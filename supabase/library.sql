-- Campus Companion academic library schema.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text,
  role text not null default 'student' check (role in ('student', 'moderator', 'admin'))
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role in ('moderator', 'admin')
  );
$$;

create or replace function public.prevent_profile_role_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role and not public.is_moderator() then
    raise exception 'Only moderators can change profile roles';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_profile_role_change on public.profiles;
create trigger prevent_profile_role_change
  before update on public.profiles
  for each row execute procedure public.prevent_profile_role_change();

create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  branch text not null,
  year text not null,
  semester text not null,
  subject text not null,
  resource_type text not null check (resource_type in ('syllabus', 'pyq', 'lab_manual', 'notes', 'assignment')),
  academic_year text not null,
  file_path text not null,
  file_size int not null check (file_size > 0 and file_size <= 10485760),
  uploader_id uuid not null references auth.users(id),
  uploader_name text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reject_reason text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.resources enable row level security;

drop policy if exists "Profiles can read own row" on public.profiles;
create policy "Profiles can read own row"
  on public.profiles for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Moderators can read all profiles" on public.profiles;
create policy "Moderators can read all profiles"
  on public.profiles for select
  to authenticated
  using (public.is_moderator());

drop policy if exists "Users can update their profile name" on public.profiles;
create policy "Users can update their profile name"
  on public.profiles for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Moderators can update profiles" on public.profiles;
create policy "Moderators can update profiles"
  on public.profiles for update
  to authenticated
  using (public.is_moderator())
  with check (public.is_moderator());

drop policy if exists "Users can read approved resources or own uploads" on public.resources;
create policy "Users can read approved resources or own uploads"
  on public.resources for select
  to authenticated
  using (status = 'approved' or uploader_id = auth.uid() or public.is_moderator());

drop policy if exists "Users can insert pending own uploads" on public.resources;
create policy "Users can insert pending own uploads"
  on public.resources for insert
  to authenticated
  with check (uploader_id = auth.uid() and status = 'pending');

drop policy if exists "Moderators can review resources" on public.resources;
create policy "Moderators can review resources"
  on public.resources for update
  to authenticated
  using (public.is_moderator())
  with check (public.is_moderator());

drop policy if exists "Users can delete own pending uploads" on public.resources;
create policy "Users can delete own pending uploads"
  on public.resources for delete
  to authenticated
  using (uploader_id = auth.uid() and status = 'pending');

-- Run this manually after reviewing a user's account:
-- update public.profiles set role = 'moderator' where user_id = '00000000-0000-0000-0000-000000000000';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resources', 'resources', false, 10485760, array['application/pdf'])
on conflict (id) do update
set public = false, file_size_limit = 10485760, allowed_mime_types = array['application/pdf'];

-- Uploads must be PDFs in a folder named with the authenticated user's UUID.
drop policy if exists "Users upload PDFs to their own folder" on storage.objects;
create policy "Users upload PDFs to their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'resources'
    and storage.extension(name) = 'pdf'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );

-- Users may remove only files in their own folder; resource rows remain protected by RLS.
drop policy if exists "Users delete files in their own folder" on storage.objects;
create policy "Users delete files in their own folder"
  on storage.objects for delete to authenticated
  using (bucket_id = 'resources' and (storage.foldername(name))[1] = (auth.uid())::text);

-- Downloads are private and allowed only for approved resources, their uploader, or moderators.
drop policy if exists "Users read permitted resource files" on storage.objects;
create policy "Users read permitted resource files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'resources'
    and (
      public.is_moderator()
      or exists (
        select 1 from public.resources r
        where r.file_path = name
          and (r.status = 'approved' or r.uploader_id = auth.uid())
      )
    )
  );
