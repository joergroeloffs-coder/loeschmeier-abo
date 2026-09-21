-- Verkaufsplattform Föhr: Verträge, Erklärungen, E-Mail-Warteschlange und
-- parallelitätssichere Rechnungsnummern.
-- Vor dem Livegang einmalig im Supabase SQL-Editor ausführen.

alter table tariffs add column if not exists slug text unique;
alter table tariffs add column if not exists beschreibung text;
alter table tariffs add column if not exists zielgruppe text not null default 'verbraucher';
alter table tariffs add column if not exists max_geraete integer not null default 2;
alter table tariffs add column if not exists oeffentlich boolean not null default false;

alter table subscriptions add column if not exists vertragsnummer text unique;
alter table subscriptions add column if not exists sofortiger_beginn boolean not null default false;
alter table subscriptions add column if not exists leistungsbeginn_am timestamptz;
alter table subscriptions add column if not exists mindestlaufzeit_bis timestamptz;
alter table subscriptions add column if not exists kuendigungswirksam_am timestamptz;
alter table subscriptions add column if not exists agb_version text;
alter table subscriptions add column if not exists widerruf_version text;
alter table subscriptions add column if not exists datenschutz_version text;

alter table payments add column if not exists erstattet_cent integer not null default 0;
alter table payments add column if not exists erstattet_am timestamptz;

create table if not exists legal_declarations (
  id uuid primary key default uuid_generate_v4(),
  typ text not null check (typ in ('kuendigung', 'widerruf')),
  subscription_id uuid references subscriptions(id) on delete set null,
  name text not null,
  email text not null,
  vertragsreferenz text not null,
  vertragsbezeichnung text not null,
  erklaerungsart text,
  grund text,
  gewuenschtes_ende timestamptz,
  wirksam_zum timestamptz,
  erklaerungstext text not null,
  eingegangen_am timestamptz not null default now(),
  zugeordnet boolean not null default false,
  verarbeitungsstatus text not null default 'eingegangen',
  bestaetigt_am timestamptz
);
create index if not exists legal_declarations_email_idx on legal_declarations (lower(email));
create index if not exists legal_declarations_reference_idx on legal_declarations (vertragsreferenz);

create table if not exists legal_acceptances (
  id uuid primary key default uuid_generate_v4(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  agb_version text not null,
  widerruf_version text not null,
  datenschutz_version text not null,
  agb_akzeptiert boolean not null,
  sofortiger_beginn boolean not null,
  akzeptiert_am timestamptz not null default now()
);

create table if not exists outbound_messages (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references customer_profiles(id) on delete set null,
  legal_declaration_id uuid references legal_declarations(id) on delete set null,
  empfaenger text not null,
  betreff text not null,
  inhalt text not null,
  status text not null default 'ausstehend',
  versuche integer not null default 0,
  letzter_fehler text,
  erstellt_am timestamptz not null default now(),
  gesendet_am timestamptz
);
create index if not exists outbound_messages_pending_idx
  on outbound_messages (status, erstellt_am);

create sequence if not exists invoice_number_2026_seq;

create or replace function next_invoice_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  current_year text := to_char(current_date, 'YYYY');
  existing_max bigint;
  sequence_last bigint;
  next_number bigint;
begin
  perform pg_advisory_xact_lock(hashtext('invoice-number-' || current_year));
  -- Für Folgejahre wird automatisch eine eigene Sequenz angelegt.
  execute format('create sequence if not exists invoice_number_%s_seq', current_year);
  select coalesce(max(split_part(rechnungsnummer, '-', 2)::bigint), 0)
    into existing_max
    from invoices
    where rechnungsnummer like current_year || '-%'
      and split_part(rechnungsnummer, '-', 2) ~ '^[0-9]+$';
  execute format('select last_value from invoice_number_%s_seq', current_year) into sequence_last;
  if existing_max >= sequence_last then
    execute format(
      'select setval(''invoice_number_%s_seq'', %s, true)',
      current_year,
      existing_max
    );
  end if;
  execute format('select nextval(''invoice_number_%s_seq'')', current_year) into next_number;
  return current_year || '-' || lpad(next_number::text, 4, '0');
end;
$$;

revoke all on function next_invoice_number() from public, anon, authenticated;
grant execute on function next_invoice_number() to service_role;

alter table legal_declarations enable row level security;
alter table legal_acceptances enable row level security;
alter table outbound_messages enable row level security;

create policy "eigene_rechtserklaerungen" on legal_declarations
  for select using (
    subscription_id in (
      select s.id from subscriptions s
      join customer_profiles c on c.id = s.customer_id
      where c.auth_user_id = auth.uid()
    )
  );

update tariffs
set code = 'foehr-jahr',
    slug = 'loeschbaert-foehr-privat',
    bezeichnung = 'Löschbärt Föhr – Jahreszugang',
    beschreibung = 'Digitale Wasserentnahmestellen- und Defibrillatorenkarte für Föhr',
    preis_cent = 1200,
    waehrung = 'EUR',
    intervall = '12_monate',
    zielgruppe = 'verbraucher',
    max_geraete = 2,
    oeffentlich = true,
    paypal_plan_id = null
where code = 'monat';

insert into tariffs (
  code, slug, bezeichnung, beschreibung, preis_cent, waehrung, intervall,
  zielgruppe, max_geraete, aktiv, oeffentlich
)
select
  'gemeinde-vorlage', 'loeschbaert-gemeinde', 'Löschbärt – Gemeindeversion',
  'Deaktivierte Vorlage für künftige Gemeinde- und Feuerwehrverträge',
  0, 'EUR', 'individuell', 'organisation', 0, false, false
where not exists (select 1 from tariffs where code = 'gemeinde-vorlage');
