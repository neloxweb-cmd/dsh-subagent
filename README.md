# DeepSeek Subagent (`ds-subagent` v2.1)

Laat **Claude Code** en **Antigravity** samenwerken met **DeepSeek Harness** als echte achtergrond-subagent — met:
- **Strakke live statusbalk in Claude Code** (lichtgewicht Claude Mod boven je invoerbalk, uitklapbaar met `[▾]`, wegklikbaar met `[×]`, ~1–5 MB RAM)
- **Automatische wakeup** als DeepSeek klaar is, een vraag heeft of vastloopt
- **Harde readonly-beveiliging vóór uitvoering:** `--readonly` zet DeepSeek Harness zelf op `read-only` (sandbox + approval fail-closed), blokkeert `ssh`/`scp`/`rsync`/shells in `--allow-cmd`, en redacteert secrets (o.a. Amazon LWA/refresh tokens en `.env`-regels) automatisch uit alle uitvoer
- **1-commando Linux-server installatie (`host install`):** installeert DSH + `ds-subagent` op je Ubuntu/Linux-server via `systemd --user` + `linger` (loopt door als je pc uit staat), luistert uitsluitend op `127.0.0.1` met token, en stuurt API-keys veilig via stdin (`chmod 600`)
- **Wijzigingen bijhouden met én zonder git** (ook op remote `--host`), plus **tokens + geschatte kosten in euro's (`~€`)** en autostart standaard aan

---

## Wat je eerst nodig hebt (2 dingen)

1. **Node.js 20 of hoger** → [nodejs.org](https://nodejs.org/) (kies LTS).
2. **DeepSeek Harness** → [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — geïnstalleerd en 1× ingelogd (met je DeepSeek-account of eigen API-key/provider).

---

## Installeren (1 minuut)

### Op Windows
1. Pak deze zip-map **eerst volledig uit** (rechtermuisknop → *Alles uitpakken*).
2. Dubbelklik op **`INSTALL.cmd`** (zet autostart direct standaard aan).
3. Wacht tot je **`INSTALLATIE GESLAAGD!`** ziet en druk op een toets.
4. **Sluit Claude Code en/of Antigravity even af en open opnieuw.**

### Op een Linux-server (vanaf je eigen pc)
```bash
# Installeert dsh + ds-subagent, systemd + linger, 127.0.0.1 bridge met token, en koppelt de host:
cat mijn-api-key.txt | ds-subagent host install prod --ssh gebruiker@server --provider mistral --api-key-stdin

# Daarna controleren en gebruiken:
ds-subagent doctor --host prod
ds-subagent start check --host prod --cwd /srv/app --readonly "Check de logs"
```
*(De API-sleutel gaat uitsluitend via stdin naar `~/.dsh-subagent/env` met rechten `600`, nooit via commando-argumenten of logs.)*

### Lokaal op macOS / Linux
```bash
node install.mjs
```

---

## Direct testen in Claude Code of Antigravity

Open een **nieuwe** sessie in Claude Code (of Antigravity) en typ:

> Gebruik de `deepseek-subagent` skill (`ds-subagent`) om op de achtergrond aan DeepSeek te vragen of hij bereikbaar is en kort "Hallo vanuit DeepSeek!" terug te sturen.

---

## Handige commando's

```bash
# Veilig alleen-lezen op een project of server
ds-subagent start audit --cwd /pad/naar/app --readonly --allow-cmd "git status" "Controleer de config"

# Remote Linux-server automatisch installeren of handmatig koppelen
ds-subagent host install prod --ssh gebruiker@server --api-key-file ./key.txt
ds-subagent host add prod --ssh gebruiker@server
ds-subagent start check --host prod --cwd /srv/app --readonly "Check de logs"

# Status, gewijzigde bestanden en logs later ophalen (ook nadat je pc uit stond)
ds-subagent status check --host prod
ds-subagent log check --host prod

# Live takenlijst in de terminal
ds-subagent watch

# Status checken en direct herstellen als daemon uit staat
ds-subagent doctor --fix

# Updaten naar de nieuwste versie
ds-subagent update

# Veilig foutrapport maken (wist automatisch keys, tokens en gebruikersnamen)
ds-subagent report
```

---

## Verwijderen

Dubbelklik op **`UNINSTALL.cmd`** (of draai `node install.mjs --uninstall`).
