# S5b — Telephony ESL/admin localhost-rebind — Watched Window Runbook
**Prepared:** 2026-07-12 (Eve) | **Tracker:** ClickUp 86bahfwkw | **Est:** 5-10 min + a test call

## Why watched, not silent
8021 (FreeSWITCH ESL) and 9022 (drachtio admin) are already firewall-blocked from the internet (host UFW default-deny). This change is defense-in-depth: bind them to 127.0.0.1 so they never listen on the public interface even if the firewall changes. It requires recreating the drachtio + freeswitch containers, which briefly drops SIP registration — so do it while Adam can place a test call.

## Pre-staged (already done)
- `telephony-localhost-override/drachtio.conf.xml` — admin bound `127.0.0.1`
- `telephony-localhost-override/event_socket.conf.xml` — ESL `listen-ip` `127.0.0.1`
- `docker-compose.localhost-esl.yml` — mounts both (inert until applied)

## Steps (run in `/home/adam/pai/infrastructure/phone`)
1. Confirm no active call: `sudo docker exec freeswitch fs_cli -x "show calls count"` → expect `0 total`.
2. Apply: `sudo docker compose -f docker-compose.yml -f docker-compose.localhost-esl.yml up -d`
3. Verify binds moved off 0.0.0.0: `sudo ss -tlnp | grep -E ":8021|:9022"` → both `127.0.0.1:...`
4. Verify local wiring reconnected: `sudo ss -tnp | grep -E "127.0.0.1:8021|127.0.0.1:9022"` → node↔freeswitch + controller↔drachtio ESTAB present.
5. Confirm SIP re-registered: `sudo docker logs voice-app --tail 20` → registration success lines.
6. **Test call (Adam):** place an inbound call to the extension AND/or trigger an outbound alert call; confirm two-way audio + Claude responds.

## Rollback (if the call fails)
`sudo docker compose -f docker-compose.yml up -d --force-recreate`  (drops the overlay, back to 0.0.0.0 bind; still firewall-protected). Then investigate.

## After success
- `sudo ufw status | grep -E "8021|9022"` deny rules stay (belt-and-suspenders).
- Comment on ClickUp 86bahfwkw: S5b true-rebind complete.
