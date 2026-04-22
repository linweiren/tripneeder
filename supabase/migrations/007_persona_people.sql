-- Store the user's usual travel party size.
alter table public.profiles
add column if not exists persona_people integer not null default 2;

alter table public.profiles
drop constraint if exists profiles_persona_people_check;

alter table public.profiles
add constraint profiles_persona_people_check
check (persona_people between 1 and 10);
