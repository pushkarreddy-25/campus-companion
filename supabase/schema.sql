create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz default now()
);

alter table public.user_data enable row level security;

-- Users may read only the row belonging to their authenticated account.
create policy "Users can select their own data"
  on public.user_data for select using (auth.uid() = user_id);
-- Users may create only their own row.
create policy "Users can insert their own data"
  on public.user_data for insert with check (auth.uid() = user_id);
-- Users may update only their own row.
create policy "Users can update their own data"
  on public.user_data for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
