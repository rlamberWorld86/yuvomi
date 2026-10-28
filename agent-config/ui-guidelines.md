# UI-Leitlinien

Uebertragene allgemeine Prinzipien aus RISE Italia Dashboard, umgesetzt mit den vorhandenen nativen Komponenten dieses Projekts. `DESIGN.md` und `public/styles/tokens.css` bleiben die gestalterischen Quellen.

- Vorhandene Komponenten, Dialoge, Formularfelder, Typografie, Abstaende und Farbtokens wiederverwenden. Keine lokalen Parallelstile fuer dieselbe Funktion einfuehren.
- Tabellen fuer spaltenweise vergleichbare Daten, Listen/Karten fuer Objekte mit variablen Details einsetzen. Bestehende responsive Muster beibehalten; keine neuen Framework-Komponenten importieren.
- Seitenruecknavigation am Anfang des Inhalts unterhalb des App-Headers anbieten und Filter-/Zeitraumkontext erhalten. Auch Fehler- und Ladezustaende sollen einen Rueckweg haben.
- Sichtbare Labels fuer Eingaben, zugaengliche Namen fuer Icon-Aktionen, Tastaturbedienung, sichtbaren Fokus und die vorhandenen Dialog-Fokusregeln erhalten. Status nicht allein durch Farbe vermitteln.
- Neue oder geaenderte Ansichten bei schmaler Breite sowie im hellen und dunklen Erscheinungsbild pruefen. Lange Uebersetzungen und leere Inhalte beruecksichtigen.
- Datum, Uhrzeit, Zahlen und Geldwerte ueber vorhandene Formatierungshelfer und Gebietsschema behandeln. Anzeigerundung darf die gespeicherten Werte nicht veraendern.
- Aenderungen der visuellen Regeln hier dokumentieren; keine Regeln oder Komponenten des Dashboard-Stacks voraussetzen, die in diesem Projekt nicht existieren.