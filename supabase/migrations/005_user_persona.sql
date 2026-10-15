-- Phase 9B-1: 新增人設相關欄位至 profiles 表
alter table public.profiles 
add column if not exists persona_companion text,
add column if not exists persona_budget text,
add column if not exists persona_stamina text,
add column if not exists persona_diet text;

-- 確保使用者可以更新自己的 Profile (包含人設資訊)
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
