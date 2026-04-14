# Ekaralu WhatsApp Agent — Deployment Guide

The agent and the Ekaralu backend run on **separate servers**. This guide covers deploying the agent on its own VPS.

---

## Architecture Overview

```
[ User's WhatsApp ]
       │
       ▼
[ VPS A — WhatsApp Agent ]   ←──── This repo
   • whatsapp-web.js + Claude AI
   • Calls api.ekaralu.com over HTTPS
       │
       ├─── POST https://api.ekaralu.com/api/properties/bot-upload    (image upload)
       └─── POST https://api.ekaralu.com/api/properties/bot-listing   (insert property)
                        │
                        ▼
              [ VPS B — Ekaralu Backend ]          (ekaralu_backend/)
                   api.ekaralu.com
                        │
                        ▼
              [ Hostinger MySQL DB ]
```

---

## Pre-Deployment Checklist

Before running the agent on a new server, complete every step:

### 1. Hostinger MySQL — Whitelist the Agent's VPS IP

> ⚠️ **This is the #1 cause of DB connection failures on a new server.**

1. Log in to [Hostinger hPanel](https://hpanel.hostinger.com)
2. Go to **Databases → MySQL Databases → Remote MySQL**
3. Add the **public IP of your Agent VPS** (run `curl ifconfig.me` on the VPS to get it)
4. Save — takes ~1 minute to apply

### 2. Install Node.js 18+ on the Agent VPS

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v18.x.x or higher
```

### 3. Install Google Chrome (required by whatsapp-web.js)

```bash
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update
sudo apt-get install -y google-chrome-stable

# Or use Puppeteer's bundled Chrome:
npx puppeteer browsers install chrome
```

### 4. Install PM2 globally

```bash
sudo npm install -g pm2
```

---

## Deployment Steps

### Step 1 — Clone / copy files to the VPS

```bash
# Using git
git clone <your-repo-url> /home/ubuntu/ekaralu-agent
cd /home/ubuntu/ekaralu-agent

# Or scp from local machine
scp -r ./AGENT ubuntu@<VPS_IP>:/home/ubuntu/ekaralu-agent
```

### Step 2 — Install dependencies

```bash
cd /home/ubuntu/ekaralu-agent
npm install --production
```

### Step 3 — Configure environment variables

```bash
cp .env.example .env
nano .env
```

Fill in every value in `.env`:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Claude API key |
| `ADMIN_WHATSAPP_NUMBER` | Admin phone (country code + number, no +) |
| `VERIFIER_WHATSAPP_NUMBER` | Verifier phone (can be same as admin) |
| `BACKEND_API_URL` | `https://api.ekaralu.com` |
| `FRONTEND_URL` | `https://ekaralu.com` |
| `BOT_UPLOAD_TOKEN` | Token for backend authentication |
| `DB_HOST` | Hostinger DB host |
| `DB_PORT` | `3306` |
| `DB_USER` | Hostinger DB username |
| `DB_PASSWORD` | Hostinger DB password |
| `DB_NAME` | Hostinger DB name |
| `PORT` | Agent dashboard port (e.g. `5010`) |

### Step 4 — Create logs directory

```bash
mkdir -p logs
```

### Step 5 — Start with PM2

```bash
pm2 start ecosystem.config.js
pm2 save                        # Persist across reboots
pm2 startup                     # Auto-start on server reboot (follow printed command)
```

### Step 6 — Scan the WhatsApp QR code

```bash
pm2 logs ekaralu-agent          # Watch logs live
```

Open the agent dashboard in your browser:
```
http://<VPS_IP>:5010
```
Scan the QR code with WhatsApp → Settings → Linked Devices → Link a Device.

After scanning, the session is saved in `.wwebjs_auth/`. **Do not delete this folder.**

---

## Useful PM2 Commands

```bash
pm2 status                      # Check if agent is running
pm2 logs ekaralu-agent          # Live log stream
pm2 restart ekaralu-agent       # Restart after code changes
pm2 stop ekaralu-agent          # Stop the agent
pm2 delete ekaralu-agent        # Remove from PM2
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `❌ Missing required environment variables` | Check your `.env` — all listed vars must be set |
| `DB connection failed` | Whitelist the VPS IP in Hostinger Remote MySQL |
| `Chrome not found` | Run `npx puppeteer browsers install chrome` |
| `403 Forbidden` from API | Check `BOT_UPLOAD_TOKEN` matches `upload.php` |
| QR code not showing | Visit `http://<VPS_IP>:5010` and refresh |
| Session expired / QR again | Delete `.wwebjs_auth/` folder and restart |
| Port 5010 blocked | Open it: `sudo ufw allow 5010` |
| Images not showing on website | Check `BACKEND_API_URL` is set correctly |

---

## Important Notes

1. **Single instance only** — Run exactly one instance of the agent. Multiple instances will conflict on the WhatsApp session.
2. **Keep `.wwebjs_auth/`** — This folder stores your WhatsApp login session. Back it up. If deleted, you must scan QR again.
3. **Never commit `.env`** — It is in `.gitignore`. Keep it secret.
4. **Token must match** — `BOT_UPLOAD_TOKEN` in `.env` must exactly match `$SECRET_TOKEN` in `upload.php` on the backend server.
