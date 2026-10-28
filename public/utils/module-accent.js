

/** Der Sammelname der Gruppe: er taucht in der Navigation auf, nie im Routing. */


/**
 * Das Farb-Token eines Moduls.
 * @param {string} mod Modul-Id (`navItems().module`, `BUILT_IN_MODULES[].id`)
 * @returns {string} Name der Custom Property, '' fuer eine leere Id
 */
export function moduleAccentToken(mod) {
  if (!mod) return '';
  return `--module-${mod}`;
}

/**
 * Derselbe Ton als fertiger `var()`-Ausdruck fuer ein style-Attribut.
 * @param {string} mod Modul-Id
 * @returns {string} `var(--module-x)` oder ''
 */
export function moduleAccentVar(mod) {
  const token = moduleAccentToken(mod);
  return token ? `var(${token})` : '';
}
