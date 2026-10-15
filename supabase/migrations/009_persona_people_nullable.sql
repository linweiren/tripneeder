-- Allow persona_people to distinguish "not set" from an explicit 2-person preference.
alter table public.profiles
alter column persona_people drop not null;

alter table public.profiles
alter column persona_people drop default;

alter table public.profiles
drop constraint if exists profiles_persona_people_check;

alter table public.profiles
add constraint profiles_persona_people_check
check (
  persona_people is null
  or persona_people between 1 and 10
);
