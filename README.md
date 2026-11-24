# DeepSeek Subagent (`ds-subagent` v2.0)

Laat **Claude Code** en **Antigravity** samenwerken met **DeepSeek Harness** als echte achtergrond-subagent — met:
- **Live takenlijst in Claude Code** (lichtgewicht Claude Mod boven je invoerbalk, ~1–5 MB RAM, geen drukke zijpanelen — verdwijnt vanzelf als hij klaar is)
- **Automatische wakeup** als DeepSeek klaar is, een vraag heeft of vastloopt
- **Technische veiligheid:** `--readonly` / `--mode workspace`, command-allowlist (`--allow-cmd`) en automatische secret-redactie op alle uitvoer
- **Linux-server modus (`--host`):** draai de daemon via `systemd` op je server (SSH-tunnel of Tailscale), zodat taken doorlopen als je pc slaapt of uitgaat
- **Wijzigingen bijhouden met én zonder git**, plus token-weergave per taak

---

## Wat je eerst nodig hebt (2 dingen)

1. **Node.js 20 of hoger** → [nodejs.org](https://nodejs.org/) (kies LTS).
2. **DeepSeek Harness** → [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — geïnstalleerd en 1× ingelogd (met je DeepSeek-account of eigen API-key/provider).

---

## Installeren (1 minuut)

### Op Windows
1. Pak deze zip-map **eerst volledig uit** (rechtermuisknop → *Alles uitpakken*).
2. Dubbelklik op **`INSTALL.cmd`**.
3. Wacht tot je **`INSTALLATIE GESLAAGD!`** ziet en druk op een toets.
4. **Sluit Claude Code en/of Antigravity even af en open opnieuw.**

### Op macOS / Linux (ook voor een Linux-server)
```bash
node install.mjs
ds-subagent daemon autostart on
```
*(Op een Linux-server maakt `daemon autostart on` direct een `systemd --user` service aan die automatisch blijft draaien.)*

---

## Direct testen in Claude Code of Antigravity

Open een **nieuwe** sessie in Claude Code (of Antigravity) en typ:

> Gebruik de `deepseek-subagent` skill (`ds-subagent`) om op de achtergrond aan DeepSeek te vragen of hij bereikbaar is en kort "Hallo vanuit DeepSeek!" terug te sturen.

---

## Handige commando's

```bash
# Veilig alleen-lezen op een project of server
ds-subagent start audit --cwd /pad/naar/app --readonly --allow-cmd "git status" "Controleer de config"

# Remote Linux-server koppelen (SSH-tunnel wordt automatisch beheerd)
ds-subagent host add prod --ssh gebruiker@server
ds-subagent start check --host prod --cwd /srv/app --readonly "Check de logs"

# Live takenlijst in de terminal
ds-subagent watch

# Daemon automatisch starten met Windows of Linux
ds-subagent daemon autostart on

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
