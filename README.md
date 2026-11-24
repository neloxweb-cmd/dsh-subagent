# DeepSeek Subagent (`ds-subagent`)

Laat **Claude Code** en **Antigravity** samenwerken met **DeepSeek Harness** als echte achtergrond-subagent — met eigen sessies, automatische wakeup als DeepSeek klaar is of een vraag heeft, en bescherming tegen vastlopen.

---

## Wat je eerst nodig hebt (2 dingen)

1. **Node.js 20 of hoger** → [nodejs.org](https://nodejs.org/) (kies LTS).
2. **DeepSeek Harness** → [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — geïnstalleerd en 1× ingelogd (met je DeepSeek-account of eigen API-key/provider).

---

## Installeren (1 minuut)

### Op Windows
1. Pak deze zip-map uit.
2. Dubbelklik op **`INSTALL.cmd`**.
3. Wacht tot je **`INSTALLATIE GESLAAGD!`** ziet en druk op een toets.
4. **Sluit Claude Code en/of Antigravity even af en open opnieuw.**

*(Je mag de uitgepakte zip-map daarna gewoon verwijderen — alles is netjes gekopieerd naar `~/.dsh-subagent/app`.)*

### Op macOS / Linux
```bash
node install.mjs
```
Zorg dat `~/bin` in je `PATH` staat (`export PATH="$HOME/bin:$PATH"`), en herstart Claude Code / Antigravity.

---

## Direct testen in Claude Code of Antigravity

Open een **nieuwe** sessie in Claude Code (of Antigravity) en typ:

> Gebruik de `deepseek-subagent` skill (`ds-subagent`) om op de achtergrond aan DeepSeek te vragen of hij bereikbaar is en kort "Hallo vanuit DeepSeek!" terug te sturen.

Claude zet DeepSeek automatisch op de achtergrond aan het werk en wordt vanzelf wakker zodra het antwoord er is.

---

## Wat de installer voor je regelt

- Maakt een apart DeepSeek Harness-profiel `subagent` aan (je gewone DeepSeek Harness Desktop-profiel blijft onaangeroerd; je model/provider-instellingen worden automatisch overgenomen).
- Installeert het `ds-subagent`-commando in `~/bin` en voegt dit toe aan je Windows `PATH`.
- Installeert de `deepseek-subagent` skill voor zowel **Claude Code** (`~/.claude/skills/`) als **Antigravity** (`~/.gemini/config/skills/`).

---

## Updaten naar een nieuwe versie

Zodra er een fix of nieuwe versie is, typ in je terminal (of vraag het aan Claude):

```bash
ds-subagent update
```

Hij stopt dan automatisch de oude achtergrond-service, downloadt de nieuwste versie, werkt de code én Claude/Antigravity-skill bij, en laat al je sessies en eigen DeepSeek-instellingen intact.

---

## Verwijderen

Dubbelklik op **`UNINSTALL.cmd`** (of draai `node install.mjs --uninstall`).

---

## Hulp bij problemen

- **`ds-subagent` niet herkend?** Sluit je terminal / Claude Code volledig af en open een nieuwe zodat het vernieuwde `PATH` actief wordt.
- **Check of alles werkt:** open PowerShell of terminal en typ `ds-subagent doctor`.
- **Live meekijken:** terwijl DeepSeek werkt kun je `http://127.0.0.1:45721` openen in je browser.
