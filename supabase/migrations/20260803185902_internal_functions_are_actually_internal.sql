revoke all on function public.check_pin(text)                          from public, anon, authenticated;
revoke all on function public.snapshot_entry(uuid)                     from public, anon, authenticated;
revoke all on function public.company_alerts(uuid, uuid, boolean)      from public, anon, authenticated;
revoke all on function public.backup_alert(uuid)                       from public, anon, authenticated;
