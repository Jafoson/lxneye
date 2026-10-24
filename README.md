# lxnEye

[![CI](https://github.com/Jafoson/lxneye/actions/workflows/ci.yml/badge.svg)](https://github.com/Jafoson/lxneye/actions/workflows/ci.yml) [![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-blue.svg)](LICENSE)

Selbst gehostete Übersicht über veraltete Abhängigkeiten und Container-Images in deinen Git-Repositories, Servern und Kubernetes-Clustern. Updates per Knopfdruck als Pull Request oder Commit, mit Rollback.

## Funktionen

- **Konten verbinden (GitHub und GitLab)**: Du meldest dich mit einem Gerätecode an (oder fügst einen Token ein), lxnEye zeigt alle deine Repositories, und du wählst aus, welche beobachtet werden. Private Repositories brauchen keinen eigenen Token mehr.
- **Git-Repositories (GitHub und GitLab)**: erkennt `package.json`, Dockerfiles, Compose-Dateien, Helm-`values.yaml` und Kubernetes-YAML. Private Repos per Token.
- **Server und Kubernetes** über einen kleinen Agent, der nur ausgehend per HTTPS meldet, was läuft.
- **Updates**: ändert die Version in der Datei und erstellt einen Pull Request (Standard) oder einen Direkt-Commit. **Rollback** schließt den PR bzw. spielt die Gegen-Änderung ein.
- **Sicherheitslücken** für npm-Pakete über OSV.dev.
- **Zusammenfassung auf Deutsch**: automatisch aus Release Notes und CVE-Daten, optional per KI (OpenAI oder Gemini) auf Knopfdruck.
- **KI-Scan** als Fallback, wenn der Standard-Scan nichts findet.

## Schnellstart (Produktion)

```bash
cd deploy
cp .env.example .env     # ausfüllen
echo "PUBLIC_HOST=lxneye.example.com" >> .env
docker compose up -d
```

Caddy holt automatisch ein Zertifikat. Beim SSO-Anbieter als Redirect-URI eintragen: `https://lxneye.example.com/auth/callback`.

## Konten und Repository-Auswahl

Oben auf **Einstellungen** klicken. Dort steht **Konten** an erster Stelle: GitHub oder GitLab wählen und sich anmelden. Unter **Quellen** siehst du alles, was beobachtet wird, und fügst Server, Kubernetes oder einzelne Repositories von Hand hinzu. Dazu gehören auch KI und der Update-Modus. Danach erscheint die Liste aller erreichbaren Repositories (eigene, als Mitarbeiter und über Organisationen) mit Suche und Filtern. Mit den Haken legst du fest, welche lxnEye beobachtet. Abgewählte Repositories werden samt ihrer Einträge in lxnEye entfernt, das Repository selbst bleibt unberührt.

**Anmeldung per Gerätecode** (empfohlen): lxnEye zeigt einen Code, du bestätigst ihn auf github.com bzw. gitlab.com. Es gibt kein Passwort, keine Weiterleitung und kein Client-Secret. Dafür einmalig eine OAuth-App anlegen und die Client-ID in die `.env` eintragen (`GITHUB_CLIENT_ID`, `GITLAB_CLIENT_ID`, siehe `deploy/.env.example`). Bei GitHub muss "Enable Device Flow" aktiv sein, bei GitLab (ab 17.1) die App "nicht vertraulich".

**Oder per Token:** Ohne OAuth-App fügst du einen Token ein (GitHub: Fine-grained Token mit Contents, Pull requests und Checks, oder klassisch mit `repo`; GitLab: Scope `api`).

Selbst gehostetes GitLab: `GITLAB_URL=https://gitlab.example.com`. Die Zugangstokens liegen verschlüsselt in der Datenbank. GitLab-Tokens laufen nach zwei Stunden ab, lxnEye erneuert sie automatisch.

## Builds und Releases (GitHub Actions)

| Workflow | Wann | Was |
|---|---|---|
| **CI** (`.github/workflows/ci.yml`) | jeder Push und Pull Request | Typen prüfen, Tests, Build. Bei Pull Requests wird das Docker-Image nur gebaut. Beim Push auf `main` entsteht `ghcr.io/<name>/lxneye:edge` (amd64 und arm64). |
| **Release** (`.github/workflows/release.yml`) | Tag `vX.Y.Z` | prüft, dass der Tag zur Version in `package.json` passt, führt Tests aus, scannt das Image mit Trivy (hohe/kritische behebbare Lücken stoppen das Release), veröffentlicht das Multi-Arch-Image mit SBOM und Provenance und erstellt das GitHub-Release mit Notes, Agent, Deploy-Dateien und Prüfsummen. |

Neues Release:

```bash
# 1. Version in package.json erhöhen (z. B. 0.2.0) und committen
# 2. Taggen und pushen
git tag v0.2.0 && git push origin v0.2.0
```

Vorabversionen wie `v0.2.0-rc.1` werden als Pre-release markiert und bekommen kein `latest`.
Es werden nur das Standard-Token `GITHUB_TOKEN` und minimale Rechte pro Job genutzt (in den Workflows festgelegt), es sind keine eigenen Secrets nötig. Das Paket auf GHCR ist nach dem ersten Push evtl. privat: unter *Packages → lxneye → Package settings* die Sichtbarkeit auf Public stellen, wenn jeder das Image ziehen können soll.

## Sicherheit

| Maßnahme | Umsetzung |
|---|---|
| **Nur HTTPS** | In Produktion wird jede Anfrage ohne HTTPS mit `426` abgelehnt (keine Weiterleitung). Start nur mit `https://`-`PUBLIC_URL` und entweder eigenem TLS oder `TRUST_PROXY`. In der Entwicklung ist HTTP erlaubt. |
| **Nur SSO** | Es gibt kein Passwort-Login. OpenID Connect mit PKCE, State und Nonce. Pflicht-Zugriffsregel (`OIDC_ALLOWED_EMAILS`, `_DOMAINS` oder `_GROUPS`), sonst startet der Server nicht. |
| **Sitzungen** | Zufällige IDs, nur der Hash in der DB. Cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`. Absolute und Leerlauf-Laufzeit. |
| **CSRF** | Schreibende Anfragen brauchen ein sitzungsgebundenes Token und eine passende `Origin`. |
| **Host-Prüfung** | Der Host-Header muss zu `PUBLIC_URL` passen. |
| **Header** | CSP ohne Inline-Skripte, HSTS, `frame-ancestors 'none'`, `nosniff`, `no-referrer`. |
| **Geheimnisse** | Git-Tokens und KI-Keys liegen mit AES-256-GCM verschlüsselt in der DB (Schlüssel aus `SECRET_KEY`). Agent-Token nur als Hash. Nichts davon geht je wieder an den Browser. |
| **Ausgehende Anfragen** | Nur HTTPS und nur an eine feste Liste bekannter Hosts (Schutz vor SSRF). Weitere Registries per `EXTRA_REGISTRY_HOSTS`. |
| **Rate-Limits** | Global und strenger für Login, Updates und KI. |
| **Eingaben** | Alle Eingaben werden mit Zod geprüft, unbekannte Felder abgelehnt. |
| **KI** | Fremde Texte (Release Notes) werden als unvertrauenswürdige Daten markiert, Ausgaben auf Struktur geprüft und nur als Text angezeigt. |
| **Container** | Läuft als Nutzer `node`, Dateisystem schreibgeschützt, alle Capabilities entfernt. |

## Agent

In lxnEye eine Quelle vom Typ **Server** oder **Kubernetes** anlegen, der Token wird einmalig angezeigt.

```bash
curl -fsSLO https://lxneye.example.com/agent.mjs
LXNEYE_URL=https://lxneye.example.com LXNEYE_TOKEN=lxe_... node agent.mjs
```

Der Agent liest nur die Container-Liste über den Docker-Socket. Für Kubernetes siehe `deploy/k8s-agent.yaml`. Damit Updates für Server/Cluster-Einträge möglich sind, verknüpfe die Quelle mit dem Git-Repository, das ihre Konfiguration enthält (GitOps).

## Entwicklung

Benötigt Node 24 (nutzt das eingebaute `node:sqlite`).

```bash
npm install
# Server (Port 3000), HTTP ist erlaubt. Für den Login ist ein OIDC-Anbieter nötig.
OIDC_ISSUER=... OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=... OIDC_ALLOWED_EMAILS=du@example.com npm run dev:server
npm run dev:web          # Oberfläche auf http://localhost:5173 (Proxy zu :3000)
npm test                 # Server-Tests
```

Ohne lokales Node 24: `docker run --rm -v "$PWD":/app -w /app/server node:24-bookworm-slim npx vitest run`

## Bekannte Grenzen dieser Version

- Git-Anbieter sind **GitHub** (github.com) und **GitLab** (gitlab.com oder selbst gehostet). GitLab ist gegen die API-Dokumentation und mit nachgebauten Antworten getestet, aber noch nicht gegen eine echte Instanz. Gitea, Forgejo und Bitbucket fehlen.
- CVE-Daten nur für **npm**. Für Container-Images ist ein Trivy-Scan geplant.
- Private Container-Registries brauchen noch hinterlegte Zugangsdaten (nicht umgesetzt).
- Release Notes werden für npm-Pakete und `ghcr.io`-Images gefunden. Bei anderen Images fehlt die Zuordnung zum Quell-Repository.
- Helm-Chart-Abhängigkeiten (`Chart.yaml`) werden noch nicht geprüft, nur Images in YAML.
- Kein Mehrbenutzer-Rollenmodell: Wer durch die Zugriffsregel kommt, darf alles.

## Lizenz

[MIT](LICENSE). Du darfst lxnEye frei nutzen, ändern und weitergeben, auch kommerziell, solange der Lizenzhinweis erhalten bleibt. Es gibt keine Gewährleistung.
