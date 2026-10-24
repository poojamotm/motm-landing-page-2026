# MOTM lead endpoint (Node.js + Express)

The landing page form posts JSON to `/api/lead`. `lead-server.js` (Node 20+, Express 5, Nodemailer):

1. validates the submission (same required fields as the form), rate-limits per IP and drops bots caught by the hidden `company_fax` field,
2. appends the lead to `LEADS_FILE` (so nothing is lost if email or CRM is down),
3. emails it to `hello@motm.tech` (Reply-To = the lead's email),
4. pushes it to B2Botix CRM.

It returns `200` if the lead was saved and at least one of email/CRM succeeded, otherwise an error, which makes the form show its existing "something went wrong" message. The meeting-slot request after submit goes to the same endpoint (`type: "meeting_request"`) and triggers a second email/CRM push.

## Deploy on the VPS (Ubuntu/Debian with nginx)

```bash
# 0. Node 20+ system-wide (skip if `node -v` already shows v20+ and `command -v node` is outside /home)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 1. Backend code, outside the web root
sudo mkdir -p /opt/motm-lead
sudo cp server/lead-server.js server/package.json server/package-lock.json /opt/motm-lead/
cd /opt/motm-lead && sudo npm ci --omit=dev

# 2. Config (holds secrets)
sudo cp server/.env.example /etc/motm-lead.env
sudo chmod 600 /etc/motm-lead.env
sudo nano /etc/motm-lead.env          # fill SMTP_* and B2BOTIX_*

# 3. Service (edit ExecStart if `command -v node` is not /usr/bin/node)
sudo cp server/motm-lead.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now motm-lead
curl -s http://127.0.0.1:8787/api/health   # {"ok":true}

# 4. nginx: paste the blocks from server/nginx-motm.conf into the site's server { }
sudo nginx -t && sudo systemctl reload nginx
```

Upload the site itself (`index.html`, `images/`, `insights/`, logos) to the nginx web root as before. Do not upload `server/`; the nginx config blocks it anyway.

Using PM2 instead of systemd: `pm2 start lead-server.js --name motm-lead` with the variables from `.env.example` exported, or `node --env-file=/etc/motm-lead.env lead-server.js`.

## Operate

- Logs: `journalctl -u motm-lead -f` (email/CRM failures are logged with the lead's email)
- All leads: `sudo cat /var/lib/motm-lead/leads.jsonl`
- After editing `/etc/motm-lead.env`: `sudo systemctl restart motm-lead`
- Tests (dev machine): `cd server && npm install && npm test`

## Security

- Secrets live only in `/etc/motm-lead.env` (root-only, `chmod 600`), never in the repo or web root.
- The service listens on `127.0.0.1` only; nginx is the sole public entry and overwrites `X-Forwarded-For`, so the per-IP rate limit can't be spoofed.
- systemd runs it as a throwaway user with a read-only filesystem except `/var/lib/motm-lead`. Because of `ProtectHome=yes`, Node must be installed system-wide (not via nvm in a home directory).
- Inputs are length-limited, line breaks are rejected (no email header injection), bodies over 20 KB are refused.

## Notes

- **B2Botix field mapping** is in `makeCrm()`. It sends generic JSON with `Authorization: Bearer <B2BOTIX_API_KEY>`. Check it against the B2Botix API docs and adjust the field names/auth there if they differ.
- Some VPS providers block outbound SMTP ports by default. If emails fail with a timeout, use your mail provider's port 465/587 relay or ask the host to unblock it.
- The site must be served over the same domain as `/api/` (no CORS is configured).
