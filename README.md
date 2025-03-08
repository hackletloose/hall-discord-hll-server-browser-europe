# Hall Discord HLL Server Browser Europe

A Discord bot that fetches and displays German "Hell Let Loose" server information in Discord channels.
It queries server data from Steam and updates channels with server details, including player lists.
This repository is maintained under the MIT License.

## English

### Description
This project is a Discord bot designed to query and display information from "Hell Let Loose" game servers in Europe.
It fetches server data either from a local `servers.json` file or from the Steam API,
filters German servers, and posts updates to specified Discord channels.

### Installation
1. Clone the repository.
2. Install dependencies with `npm install`.
3. Create a `.env` file with your Discord token, Steam API key, channel IDs, and other required variables.
4. Run the bot using `node main.mjs` and update the server list using `node update.mjs` if needed.

### Usage
- The bot automatically updates the server status at defined intervals.
- The server list is updated using the Steam API if the local file is not found or outdated.
- Logs are managed using Winston with daily rotation.

### License
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Deutsch

### Beschreibung
Dieses Projekt ist ein Discord-Bot, der Informationen von "Hell Let Loose"-Servern in Europa abruft und anzeigt.
Er lädt Serverdaten entweder aus einer lokalen `servers.json` Datei oder über die Steam API,
filtert deutsche Server heraus und postet Updates in definierten Discord-Kanälen.

### Installation
1. Klone das Repository.
2. Installiere die Abhängigkeiten mit `npm install`.
3. Erstelle eine `.env` Datei mit deinem Discord-Token, Steam API Schlüssel, Channel IDs und weiteren benötigten Variablen.
4. Starte den Bot mit `node main.mjs` und aktualisiere die Serverliste ggf. mit `node update.mjs`.

### Nutzung
- Der Bot aktualisiert den Serverstatus in festgelegten Intervallen automatisch.
- Die Serverliste wird über die Steam API aktualisiert, falls die lokale Datei nicht vorhanden oder veraltet ist.
- Logs werden mit Winston verwaltet und täglich rotiert.

### Lizenz
Dieses Projekt steht unter der MIT License. Details findest du in der [LICENSE](LICENSE) Datei.
