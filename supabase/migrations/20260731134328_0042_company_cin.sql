-- legal_name, legal_form, pan, gstin, state_code already existed but had no
-- screen to fill them in. CIN (Corporate Identity Number) was missing
-- entirely — it is what the MCA issues on incorporation, distinct from PAN.
alter table public.companies add column if not exists cin text;
