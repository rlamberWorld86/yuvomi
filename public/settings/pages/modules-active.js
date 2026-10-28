import { t } from '/i18n.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { settingSwitchRowHtml } from '/settings/components.js';
import { BUILT_IN_MODULES } from '/settings/module-order.js';

/** Household-wide availability of the installed core modules. */
export async function render(container) {
  const preferences = await getPreferences();
  const disabled = new Set(preferences.disabled_modules ?? []);
  const modules = [
    ...BUILT_IN_MODULES.filter((module) => !module.locked),
  ];
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `<section class="settings-section">
    <div class="row-carrier settings-group">${modules.map((module) => settingSwitchRowHtml({
      label: t(module.labelKey),
      checked: !disabled.has(module.id),
      attrs: { 'data-module-toggle': module.id },
    })).join('')}</div>
  </section>`);
  container.querySelectorAll('[data-module-toggle]').forEach((input) => {
    input.addEventListener('change', async () => {
      const previous = new Set(disabled);
      if (input.checked) disabled.delete(input.dataset.moduleToggle);
      else disabled.add(input.dataset.moduleToggle);
      const inputs = container.querySelectorAll('[data-module-toggle]');
      inputs.forEach((control) => { control.disabled = true; });
      try {
        await savePreferences({ disabled_modules: [...disabled] });
        window.yuvomi?.setDisabledModules?.([...disabled]);
        window.yuvomi?.showToast(t('settings.thirdPartyModulesSaved'), 'success');
      } catch (error) {
        disabled.clear();
        previous.forEach((id) => disabled.add(id));
        input.checked = !input.checked;
        window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
      } finally {
        inputs.forEach((control) => { if (control.isConnected) control.disabled = false; });
      }
    });
  });
}
