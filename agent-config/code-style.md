# Code-Stil und Verifikation

Aus den allgemeinen Prinzipien von RISE Italia Dashboard `agent-config/code-style.md` abgeleitet und an dieses Repository angepasst. Java-, Quarkus-, React-, TypeScript- und Maven-Regeln werden nicht uebernommen. Fuer unveraenderten Bestand entsteht kein Umbauauftrag.

## JavaScript und Struktur

- Bestehende Einrueckung, einfache Anfuehrungszeichen und Semikolons erhalten. Neue Dateien folgen dem vergleichbaren Nachbarmodul. Sprechende englische Symbole und ES-Module verwenden.
- Module klein und fachlich zusammenhaengend halten. Vorhandene Helfer verwenden; keine allgemeine Abstraktion ohne konkreten Wiederverwendungsbedarf.
- API-Grenzen und nicht offensichtliche Datenformen mit JSDoc dokumentieren. Externe Eingaben validieren; Fehler nicht durch ungepruefte Typannahmen verdecken.
- Routen und HTTP-Fehlerabbildung in `server/routes/`, wiederverwendbare Fach-/Integrationslogik in `server/services/`, kleine technische Helfer in `server/utils/` nach bestehendem Muster.
- Autorisierung und Sichtbarkeit im Backend durchsetzen. Versteckte UI-Aktionen ersetzen keine Zugriffskontrolle. Bestehende Session-, CSRF- und Restore-Schutzmechanismen weiterverwenden.
- SQL parametrisieren. Schemaaenderungen nur als neue Migration in `server/db.js`; Testschema `server/db-schema-test.js` entsprechend pflegen. Ausgelieferte Migrationen nicht nachtraeglich umschreiben. Transaktionen kurz halten und Remote-Aufrufe ausserhalb ausfuehren.
- Fuer externe Speicher bestehende Storage-Services nutzen. Fehlgeschlagene oder unvollstaendige Listings duerfen keine lokalen Daten als geloescht markieren; Wiederholbarkeit und bestehende Zugriffskontrollen erhalten.

## Frontend und Fehler

- Bestehenden `public/api.js`-Client fuer fachliche API-Zugriffe verwenden; Session-, CSRF- und Fehlerbehandlung nicht in Seiten duplizieren. Bestehende begruendete Sonderfaelle beibehalten.
- Seiten, Komponenten und Helfer nach dem vorhandenen Muster in `public/pages/`, `public/components/` und `public/utils/` einordnen. Keine React-/Dashboard-Komponenten kopieren.
- Benutzertexte ueber `public/i18n.js` und `public/locales/` pflegen. Neue Keys konsistent in allen unterstuetzten Sprachen ergaenzen; JSON-Formatierung erhalten.
- Untrusted Text vor HTML-Interpolation mit dem bestehenden HTML-Helfer escapen oder per `textContent` setzen.
- Asynchrone Aktionen behandeln Fehler und zeigen Laden, Erfolg, leere Ergebnisse und deaktivierte Zustaende nachvollziehbar. Doppelte Ausfuehrung bei laufenden Schreibaktionen verhindern.

## Logging und Checks

- Bestehendes `server/logger.js` verwenden. Relevante Ergebnisse, technische IDs, Status und Zaehler protokollieren; keine Passwoerter, Tokens, Cookies, privaten Inhalte oder ungefilterten Providerantworten.
- Fehler dort einmal protokollieren, wo sie abschliessend behandelt werden. Ein Log vor dem Commit beweist keinen erfolgreichen Abschluss.
- Vorhandene Node-Testmuster unter `test/` verwenden. Sinnvolle Verhaltens-, Berechtigungs- und Fehlerfaelle testen; keine Tests nur zum Nachbauen trivialer Implementierung.
- Befehle aus `package.json` waehlen. Fuer Migrationen mindestens Schema-Mirror und Append-only pruefen; fuer API-Aenderungen passende Routen-/OpenAPI-Tests, fuer Texte i18n-Tests, fuer Branding Auth-/PWA-Tests.
- Abschliessend `git diff --check` und den fachlichen Diff pruefen. Erfolgreiche unveraenderte Checks nicht ohne Anlass wiederholen. Offene Browser-/Integrationspruefungen explizit nennen.