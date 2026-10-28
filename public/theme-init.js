// Einmalige, idempotente Migration aller Legacy-„oikos"-Storage-Keys → „yuvomi".
// Läuft als ALLERERSTES (im <head>, vor jeder Seite/Komponente), damit
// migrierte Werte (Theme, Locale, Ansichten …) ohne Flackern verfügbar sind.
// Benennt jeden Key, der mit `oikos-`, `oikos:` oder `oikos.` beginnt, auf das
// gleiche Suffix mit `yuvomi`-Präfix um (z. B. `oikos-theme` → `yuvomi-theme`).
(function migrateLegacyStorage() {
  // Kein gemeinsames Flag: sessionStorage ist pro Tab. Würde ein localStorage-Flag
  // die Migration kurzschließen, verlöre ein zweiter, vor dem Update geöffneter Tab
  // seine eigenen sessionStorage-Keys. Der Scan ist idempotent und günstig (wenige
  // Keys), daher laufen wir ihn bei jedem Load über BEIDE Stores.
  try {
    var stores = [localStorage, sessionStorage];
    for (var s = 0; s < stores.length; s++) {
      var store = stores[s];
      var keys = [];
      for (var i = 0; i < store.length; i++) {
        var k = store.key(i);
        if (k && /^oikos[-:.]/.test(k)) keys.push(k);
      }
      for (var j = 0; j < keys.length; j++) {
        var oldKey = keys[j];
        var newKey = 'yuvomi' + oldKey.slice('oikos'.length);
        if (store.getItem(newKey) === null) {
          store.setItem(newKey, store.getItem(oldKey));
        }
        store.removeItem(oldKey);
      }
    }
  } catch (e) { /* Storage nicht verfügbar (Privatmodus) → ignorieren */ }
})();

(function() {
  var stored = localStorage.getItem('yuvomi-theme');
  if (stored === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (stored === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }

  // DIE STATUSBAR GEHOERT ZUR THEME-ENTSCHEIDUNG, ALSO HIERHER.
  //
  // Beide `<meta name="theme-color">` tragen ein `media="(prefers-color-scheme:
  // …)"`: welche gilt, entscheidet das SYSTEM - waehrend die Zeilen darueber es
  // gerade ueber `data-theme` entschieden haben. Wer auf einem hellen Geraet
  // ausdruecklich Dunkel waehlt, bekam eine helle Statusbar ueber einer dunklen
  // Seite. Bei ausdruecklicher Wahl tragen deshalb beide Metas die AKTIVE
  // Farbe; dann ist gleichgueltig, welche der Browser nimmt. Im
  // Automatik-Modus bleibt das Paar ein Paar - dort ist das System die richtige
  // Quelle.
  //
  // HIER UND NICHT NUR IM ROUTER: dieses Skript laeuft in index.html UND in
  // offline.html, und die Offline-Huelle hat keinen Router, der es nachholen
  // koennte. Der Router korrigiert weiter beim Theme- und Routenwechsel; das
  // ist die Bewegung, das hier der Anfangszustand.
  //
  // Die Werte kommen aus den Metas selbst, nicht als Literale: eine vierte
  // Kopie von #F5F3ED/#191816 waere eine vierte Stelle, an der die Farbe der
  // Seite und die ihrer Statusbar auseinanderlaufen koennen.
  try {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    if (metas.length >= 2 && (stored === 'dark' || stored === 'light')) {
      var active = metas[stored === 'dark' ? 1 : 0].getAttribute('content');
      metas[0].setAttribute('content', active);
      metas[1].setAttribute('content', active);
    }
  } catch (e) { /* ohne Metas bleibt es beim Systemverhalten */ }
})();

// DIE LEINWAND VOR DEM CSS FOLGT DER WAHL.
//
// `<meta name="color-scheme" content="light dark">` laesst das System
// entscheiden, bis tokens.css mit `color-scheme` auf :root uebernimmt. Wer
// ausdruecklich hell oder dunkel gewaehlt hat (oder die Wand nachts dunkel
// schaltet, Block darueber), bekam bis dahin die Leinwand des Systems - einen
// Blitz in der falschen Farbe. Deshalb steht dieser Block NACH dem Wand-Modus
// und liest das fertige `data-theme`.
(function () {
  try {
    var theme = document.documentElement.getAttribute('data-theme');
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta && (theme === 'light' || theme === 'dark')) meta.setAttribute('content', theme);
  } catch (e) { /* ohne Meta bleibt es beim System */ }
})();
