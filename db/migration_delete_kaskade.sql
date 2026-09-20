-- Migration: behebt fehlende ON DELETE-Regeln, die das Löschen von Kunden
-- mit bestehenden Rechnungen/Kündigungen blockiert haben.
-- Einmalig im Supabase SQL-Editor ausführen.

alter table invoices drop constraint invoices_subscription_id_fkey;
alter table invoices add constraint invoices_subscription_id_fkey
  foreign key (subscription_id) references subscriptions(id) on delete cascade;

alter table cancellations drop constraint cancellations_subscription_id_fkey;
alter table cancellations add constraint cancellations_subscription_id_fkey
  foreign key (subscription_id) references subscriptions(id) on delete cascade;

alter table notifications drop constraint notifications_customer_id_fkey;
alter table notifications add constraint notifications_customer_id_fkey
  foreign key (customer_id) references customer_profiles(id) on delete set null;

alter table admin_actions drop constraint admin_actions_subscription_id_fkey;
alter table admin_actions add constraint admin_actions_subscription_id_fkey
  foreign key (subscription_id) references subscriptions(id) on delete set null;

alter table admin_actions drop constraint admin_actions_customer_id_fkey;
alter table admin_actions add constraint admin_actions_customer_id_fkey
  foreign key (customer_id) references customer_profiles(id) on delete set null;

alter table security_events drop constraint security_events_customer_id_fkey;
alter table security_events add constraint security_events_customer_id_fkey
  foreign key (customer_id) references customer_profiles(id) on delete set null;
