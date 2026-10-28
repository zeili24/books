# 📚 Leseliste

Eine kleine Lese-App fürs iPhone: gelesene Bücher festhalten (per Foto vom Cover oder von Hand) und dir von einer KI neue Bücher vorschlagen lassen.

Die App ist eine **Web-App (PWA)**. Sie läuft kostenlos über **GitHub Pages** und wird auf dem iPhone über „Zum Home-Bildschirm“ wie eine normale App installiert, ganz ohne App Store und ohne Mac.

## Funktionen

- **Bibliothek**: alle gelesenen Bücher mit Mini-Cover, wahlweise **monatlich** oder **jährlich** gruppiert, dazu Zähler (gesamt / dieses Jahr / diesen Monat) und eine Suche.
- **Buch hinzufügen**
  - 📷 **Foto vom Cover**: Die KI erkennt Titel und Autor:in, das Cover wird automatisch online gesucht.
  - ✍️ **Manuell**: Titel tippen, Treffer aus Google Books bzw. Open Library antippen, fertig. Alternativ alles von Hand eintragen.
  - **Daten**: „Beendet“ ist Pflicht (danach wird gruppiert), „Begonnen“ ist optional. Dazu kommen eine Bewertung (1–5 ★) und eine Notiz.
- **✨ Entdecken**: Lieblingsbücher antippen, optional Wünsche eingeben („eher kurz“, „kein Fantasy“ …), und die KI schlägt **3–5 neue Bücher** vor, jeweils mit Begründung, Cover und Links zu **Amazon** und **Thalia**. Vorschläge kannst du auf eine **Merkliste** setzen.
- **Backup**: Export/Import als JSON-Datei, auf dem iPhone über das Teilen-Menü, z. B. in „Dateien“ sichern.
- Die Bücherliste funktioniert auch **offline**.

## 1. Auf GitHub veröffentlichen

1. Auf [github.com](https://github.com) ein neues **öffentliches** Repository anlegen, z. B. `leseliste`.
2. Auf der Repo-Seite **„Add file“ → „Upload files“** wählen und den **gesamten Inhalt dieses Ordners** hineinziehen (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest` und den Ordner `icons`). Danach **„Commit changes“** klicken.
3. **Settings → Pages** öffnen, bei *Source* „Deploy from a branch“ wählen, dann Branch `main` und Ordner `/ (root)`, und **Save** klicken.
4. Nach ca. 1 Minute ist die App erreichbar unter
   `https://<dein-github-name>.github.io/leseliste/`

## 2. Auf dem iPhone installieren

1. Die Adresse oben in **Safari** öffnen.
2. Auf **Teilen** (Quadrat mit Pfeil) und dann **„Zum Home-Bildschirm“** tippen.
3. Die App startet jetzt im Vollbild wie eine normale App.

## 3. KI einrichten (für Foto-Erkennung & Vorschläge)

Du kannst wählen zwischen **Claude (Anthropic)** und **ChatGPT (OpenAI)**. Ein normales Abo (Claude Pro / ChatGPT Plus) reicht nicht, du brauchst einen **API-Schlüssel**:

- Claude: [console.anthropic.com](https://console.anthropic.com)
- ChatGPT: [platform.openai.com](https://platform.openai.com/api-keys)

1. Dort ein Konto anlegen, etwas Guthaben aufladen (z. B. 5 €) und einen API-Schlüssel erstellen.
2. In der App unter **⚙️ Einstellungen** den Anbieter wählen, den Schlüssel eintragen und speichern.

**Kosten**: Eine Vorschlagsrunde kostet grob 1–5 Cent, eine Cover-Erkennung weniger als 1 Cent. Mit den günstigeren Modellen (Sonnet/Haiku bzw. GPT-5 mini) ist es noch billiger.

**Sicherheit**: Der Schlüssel wird nur lokal auf deinem iPhone gespeichert und direkt an den jeweiligen Anbieter geschickt, nie ins GitHub-Repo. Gib die App-Adresse trotzdem nicht mit eingetragenem Schlüssel an andere Geräte weiter, und setze bei Anthropic am besten ein monatliches Ausgabenlimit.

## Hinweise

- Die Daten liegen **nur auf diesem Gerät** (im Speicher der Home-Bildschirm-App). Mach ab und zu ein Backup über den Export.
- Cover stammen von Google Books bzw. Open Library. Wird keins gefunden, bleibt dein Foto als Cover.
- Updates: Geänderte Dateien einfach erneut auf GitHub hochladen. Die App holt sich die neue Version beim nächsten Start.
