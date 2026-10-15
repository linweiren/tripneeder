-- Store the user's usual transportation preference for trip planning.
alter table public.profiles
add column if not exists persona_transport_mode text;

alter table public.profiles
drop constraint if exists profiles_persona_transport_mode_check;

alter table public.profiles
add constraint profiles_persona_transport_mode_check
check (
  persona_transport_mode is null
  or persona_transport_mode in ('scooter', 'car', 'public_transit')
);
