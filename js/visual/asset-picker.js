/* Shared asset picker component.
 *
 * Renders a single Asset dropdown ("choose existing or create new") plus
 * a lazy-revealed new-asset sub-form when the user picks "+ New asset…".
 * Used by both the Add Transaction and Closed Position forms so the UX is
 * consistent and we only maintain one implementation.
 *
 * Usage:
 *   const picker = createAssetPicker({
 *     assets,              // Array of existing asset records
 *     preselectedId,       // Optional asset ID to preselect (for edit mode)
 *     defaultType,         // Default asset type for new-asset form ('equity')
 *     restrictToTypes,     // Optional array of types to limit the picker to
 *                          // (e.g. only equity + etf + crypto for Closed Position)
 *   });
 *
 *   // Append picker.element to your form
 *   form.append(picker.element);
 *
 *   // On submit, call picker.resolve() → returns { assetId, created?: boolean }
 *   // or throws if nothing is selected or new-asset validation fails.
 *   const { assetId } = await picker.resolve();
 */

import { el } from '../ui.js';
import { put, uuid } from '../storage/indexeddb.js';
import { listAssetTypes, getHandler } from '../assets/registry.js';

export function createAssetPicker(options = {}) {
  const {
    assets = [],
    preselectedId = null,
    defaultType = 'equity',
    restrictToTypes = null,
    label = 'Asset',
  } = options;

  // Build main select — placeholder first, then existing assets,
  // then "+ New asset…" at the bottom.
  const selectOptions = [];

  // Placeholder — shown as default if nothing is preselected and user hasn't
  // picked yet. disabled + hidden=false so it's visible in closed dropdown
  // but can't be re-selected after the user picks something else.
  if (!preselectedId) {
    selectOptions.push(el('option', {
      value: '',
      disabled: true,
      selected: true,
    }, 'Choose asset or create new…'));
  }

  // Sort existing assets by ticker for consistent ordering
  const sortedAssets = [...assets].sort((a, b) =>
    (a.ticker || '').localeCompare(b.ticker || ''));

  for (const asset of sortedAssets) {
    selectOptions.push(el('option', {
      value: asset.id,
      ...(asset.id === preselectedId ? { selected: true } : {}),
    }, `${asset.ticker || '?'}  —  ${asset.name || 'Unnamed'}`));
  }

  // New asset option at the bottom (separator + action)
  selectOptions.push(
    el('option', { value: '', disabled: true }, '──────'),
    el('option', { value: '__new__' }, '+ New asset…'),
  );

  const select = el('select', {
    class: 'select', id: 'asset-picker',
    required: true,
  }, ...selectOptions);

  // New-asset sub-form — hidden until the user picks __new__
  const newAssetWrap = el('div', {
    id: 'new-asset-wrap',
    style: { display: 'none', marginTop: 'var(--space-3)' },
  });

  let currentTypeSelect = null;
  let currentFieldsWrap = null;

  function renderNewAssetForm() {
    newAssetWrap.innerHTML = '';
    newAssetWrap.style.display = 'block';

    // Limit types if caller wants to (Closed Position shouldn't offer bonds etc)
    const allTypes = listAssetTypes();
    const availableTypes = restrictToTypes
      ? allTypes.filter((t) => restrictToTypes.includes(t.key))
      : allTypes;

    currentTypeSelect = el('select', {
      id: 'new-asset-type', class: 'select',
    }, ...availableTypes.map((t) =>
      el('option', {
        value: t.key,
        ...(t.key === defaultType ? { selected: true } : {}),
      }, t.label)
    ));

    currentFieldsWrap = el('div', { id: 'new-asset-fields' });

    const renderFields = () => {
      currentFieldsWrap.innerHTML = '';
      const type = currentTypeSelect.value;
      const handler = getHandler(type);
      for (const f of handler.formFields()) {
        const input = f.type === 'select'
          ? el('select', {
              id: `asset-${f.name}`, class: 'select',
              ...(f.required ? { required: true } : {}),
            },
              ...(f.options || []).map((o) => {
                if (typeof o === 'string') return el('option', { value: o }, o);
                return el('option', { value: o.value }, o.label);
              }))
          : el('input', {
              type: f.type || 'text',
              id: `asset-${f.name}`,
              class: 'input',
              ...(f.required ? { required: true } : {}),
              ...(f.type === 'number' ? { step: 'any' } : {}),
              ...(f.placeholder ? { placeholder: f.placeholder } : {}),
            });
        if (handler.defaults?.[f.name] != null) {
          input.value = handler.defaults[f.name];
        }
        currentFieldsWrap.append(
          el('div', { class: 'form-group' },
            el('label', { for: `asset-${f.name}` }, f.label),
            input,
            f.hint ? el('p', { class: 'form-group__hint' }, f.hint) : null,
          ),
        );
      }
    };

    currentTypeSelect.addEventListener('change', renderFields);

    newAssetWrap.append(
      el('p', { class: 'form-group__hint', style: { fontStyle: 'italic', marginTop: 0 } },
        'Creating a new asset record. It will be available in this dropdown next time.'),
      el('div', { class: 'form-group' },
        el('label', { for: 'new-asset-type' }, 'Asset type'),
        currentTypeSelect,
      ),
      currentFieldsWrap,
    );
    renderFields();
  }

  select.addEventListener('change', () => {
    if (select.value === '__new__') {
      renderNewAssetForm();
    } else {
      newAssetWrap.style.display = 'none';
      newAssetWrap.innerHTML = '';
      currentTypeSelect = null;
      currentFieldsWrap = null;
    }
  });

  const element = el('div', { class: 'form-group' },
    el('label', { for: 'asset-picker' }, label),
    select,
    newAssetWrap,
  );

  /**
   * Resolve the picker to a concrete assetId. If the user picked an existing
   * asset, returns that ID. If they chose "+ New asset…", persists the new
   * asset and returns its ID. Throws if nothing selected or new-asset fields
   * are invalid.
   */
  async function resolve() {
    const value = select.value;
    if (!value) throw new Error('Select an asset');

    if (value !== '__new__') {
      // Existing asset
      return { assetId: value, created: false };
    }

    // Creating a new asset
    if (!currentTypeSelect || !currentFieldsWrap) {
      throw new Error('New asset form not ready');
    }

    const type = currentTypeSelect.value;
    const handler = getHandler(type);
    const meta = {};
    const asset = {
      id: uuid(),
      type,
      meta,
    };

    for (const f of handler.formFields()) {
      const input = currentFieldsWrap.querySelector(`#asset-${f.name}`);
      const val = input?.value?.trim() ?? '';
      if (f.required && !val) {
        input?.focus();
        throw new Error(`${f.label} is required`);
      }
      if (['ticker', 'name', 'exchange', 'baseCurrency'].includes(f.name)) {
        asset[f.name] = val;
      } else if (val !== '') {
        meta[f.name] = val;
      }
    }

    // Sensible fallback for ticker if the handler didn't require one
    if (!asset.ticker) {
      asset.ticker = (asset.name || 'ASSET').slice(0, 8).toUpperCase();
    }

    await put('assets', asset);
    return { assetId: asset.id, created: true, asset };
  }

  // If editing mode preselected an asset, the placeholder is omitted so the
  // preselected value is shown. No sub-form needed. Nothing else to do.

  return { element, resolve, selectEl: select };
}
