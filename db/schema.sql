-- Löschmeier Test — Datenmodell (Supabase/Postgres)
-- Wird im Supabase SQL-Editor einmalig ausgeführt, nachdem das Projekt
-- angelegt ist. auth.users wird automatisch von Supabase Auth verwaltet
-- (E-Mail-Link-Login) und hier nur referenziert.

create extension if not exists "uuid-ossp";

-- ---------- Kundenprofile ----------
create table customer_profiles (
  id uuid primary key default uuid_generate_v4(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  email text not null,
  name text,
  erstellt_am timestamptz not null default now(),
  geloescht_am timestamptz
);

-- ---------- Tarife ----------
create table tariffs (
  id uuid primary key default uuid_generate_v4(),
  code text unique not null,                 -- z.B. 'monat', 'jahr'
  bezeichnung text not null,
  preis_cent integer not null,
  waehrung text not null default 'EUR',
  intervall text not null,                    -- 'monatlich' | 'jaehrlich'
  paypal_plan_id text,                        -- wird nach Anlage in PayPal eingetragen
  aktiv boolean not null default true
);

-- ---------- Abonnements ----------
create table subscriptions (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid not null references customer_profiles(id) on delete cascade,
  tariff_id uuid not null references tariffs(id),
  status text not null default 'unbezahlt',
  -- Status-Werte: unbezahlt, wird_geprueft, aktiv, ueberfaellig, kulanzzeit,
  --   gekuendigt_zum_ende, gesperrt, abgelaufen, erstattet, manuell_gesperrt
  paypal_subscription_id text unique,
  paypal_payer_id text,
  beginn timestamptz,
  naechste_zahlung timestamptz,
  bezahlt_bis timestamptz,
  gekuendigt_am timestamptz,
  kulanz_bis timestamptz,
  manuell_gesperrt boolean not null default false,
  notiz text,
  erstellt_am timestamptz not null default now(),
  aktualisiert_am timestamptz not null default now()
);
create index on subscriptions (customer_id);
create index on subscriptions (status);

-- ---------- Zahlungen ----------
create table payments (
  id uuid primary key default uuid_generate_v4(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  paypal_capture_id text unique,
  betrag_cent integer not null,
  waehrung text not null default 'EUR',
  status text not null,                        -- erfolgreich, fehlgeschlagen, erstattet
  zeitpunkt timestamptz not null default now()
);
create index on payments (subscription_id);

-- ---------- Rechnungen ----------
create table invoices (
  id uuid primary key default uuid_generate_v4(),
  subscription_id uuid not null references subscriptions(id),
  payment_id uuid references payments(id),
  rechnungsnummer text unique not null,
  betrag_cent integer not null,
  ausgestellt_am timestamptz not null default now(),
  pdf_pfad text
);

-- ---------- Geräte ----------
create table devices (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid not null references customer_profiles(id) on delete cascade,
  geraet_name text,
  erstmals_gesehen timestamptz not null default now(),
  zuletzt_aktiv timestamptz not null default now(),
  bestaetigt boolean not null default false
);
create index on devices (customer_id);

-- ---------- Sitzungen ----------
create table sessions (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid not null references customer_profiles(id) on delete cascade,
  device_id uuid references devices(id),
  token_hash text not null,
  erstellt_am timestamptz not null default now(),
  laeuft_ab timestamptz not null,
  beendet_am timestamptz
);
create index on sessions (customer_id);

-- ---------- PayPal-Webhook-Ereignisse (Idempotenz) ----------
create table webhook_events (
  id uuid primary key default uuid_generate_v4(),
  paypal_event_id text unique not null,
  event_type text not null,
  paypal_subscription_id text,
  verarbeitet_am timestamptz not null default now(),
  ergebnis text not null,                       -- ok, fehler, ignoriert
  fehlermeldung text
);

-- ---------- Benachrichtigungen (Protokoll, nicht der Versand selbst) ----------
create table notifications (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references customer_profiles(id),
  typ text not null,
  gesendet_am timestamptz not null default now(),
  erfolgreich boolean not null default true
);

-- ---------- Admin-Aktionen (Protokoll) ----------
create table admin_actions (
  id uuid primary key default uuid_generate_v4(),
  admin_name text not null,
  aktion text not null,
  subscription_id uuid references subscriptions(id),
  customer_id uuid references customer_profiles(id),
  zeitpunkt timestamptz not null default now(),
  details text
);

-- ---------- Sicherheitsereignisse ----------
create table security_events (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references customer_profiles(id),
  typ text not null,                            -- z.B. 'zu_viele_geraete', 'login_fehlgeschlagen'
  zeitpunkt timestamptz not null default now(),
  details text
);

-- ---------- Kündigungen ----------
create table cancellations (
  id uuid primary key default uuid_generate_v4(),
  subscription_id uuid not null references subscriptions(id),
  angefordert_am timestamptz not null default now(),
  wirksam_zum timestamptz not null,
  bestaetigungstext text
);

-- ---------- Row Level Security ----------
alter table customer_profiles enable row level security;
alter table subscriptions enable row level security;
alter table payments enable row level security;
alter table invoices enable row level security;
alter table devices enable row level security;
alter table sessions enable row level security;
alter table cancellations enable row level security;

-- Jeder Kunde sieht nur eigene Daten
create policy "eigenes_profil" on customer_profiles
  for select using (auth.uid() = auth_user_id);

create policy "eigene_abos" on subscriptions
  for select using (
    customer_id in (select id from customer_profiles where auth_user_id = auth.uid())
  );

create policy "eigene_zahlungen" on payments
  for select using (
    subscription_id in (
      select s.id from subscriptions s
      join customer_profiles c on c.id = s.customer_id
      where c.auth_user_id = auth.uid()
    )
  );

create policy "eigene_rechnungen" on invoices
  for select using (
    subscription_id in (
      select s.id from subscriptions s
      join customer_profiles c on c.id = s.customer_id
      where c.auth_user_id = auth.uid()
    )
  );

create policy "eigene_geraete" on devices
  for select using (
    customer_id in (select id from customer_profiles where auth_user_id = auth.uid())
  );

create policy "eigene_sitzungen" on sessions
  for select using (
    customer_id in (select id from customer_profiles where auth_user_id = auth.uid())
  );

create policy "eigene_kuendigungen" on cancellations
  for select using (
    subscription_id in (
      select s.id from subscriptions s
      join customer_profiles c on c.id = s.customer_id
      where c.auth_user_id = auth.uid()
    )
  );

-- Schreibender Zugriff (insert/update/delete) läuft ausschließlich über den
-- Cloudflare Worker mit dem Supabase Service-Role-Key (umgeht RLS
-- bewusst, da alle Schreibvorgänge serverseitig geprüft werden). Der
-- Service-Role-Key wird NIE im Browser verwendet.

-- ---------- Start-Tarif ----------
insert into tariffs (code, bezeichnung, preis_cent, intervall)
values ('monat', 'Löschmeier Test – Monatsabo', 100, 'monatlich');
