/**
 * Panel de headers dinámicos para Swagger UI.
 * Inyecta un panel encima de la UI donde el desarrollador puede agregar
 * cualquier header (x-user-id, x-order-id, etc.) y se aplican a todas
 * las peticiones mientras dure la sesión. Se persisten en localStorage.
 */

export const swaggerCustomCss = `
#dyn-headers-panel {
  font-family: sans-serif;
  border: 1px solid #d8d8d8;
  border-radius: 4px;
  margin: 0 0 20px;
  overflow: hidden;
}
.dh-title {
  background: #f5f5f5;
  border-bottom: 1px solid #d8d8d8;
  padding: 10px 16px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  user-select: none;
}
.dh-arrow { font-size: 10px; transition: transform .2s; }
#dyn-headers-panel.dh-open .dh-arrow { transform: rotate(90deg); }
.dh-badge {
  background: #49cc90; color: #fff; border-radius: 10px;
  padding: 1px 8px; font-size: 11px; font-weight: normal; margin-left: auto;
}
.dh-body { display: none; padding: 14px 16px; background: #fff; }
#dyn-headers-panel.dh-open .dh-body { display: block; }
.dh-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; }
.dh-key {
  flex: 0 0 220px; border: 1px solid #ccc; border-radius: 4px;
  padding: 6px 8px; font-size: 13px; font-family: monospace;
}
.dh-val {
  flex: 1; border: 1px solid #ccc; border-radius: 4px;
  padding: 6px 8px; font-size: 13px; font-family: monospace;
}
.dh-key:focus, .dh-val:focus { border-color: #49cc90; outline: none; box-shadow: 0 0 0 2px rgba(73,204,144,.2); }
.dh-del {
  border: none; background: #eee; border-radius: 4px;
  padding: 5px 10px; cursor: pointer; font-size: 13px; color: #666; line-height: 1;
}
.dh-del:hover { background: #ffd6d6; color: #c00; }
.dh-add-btn {
  margin-top: 4px; padding: 6px 14px; border: 1px dashed #aaa;
  background: none; border-radius: 4px; cursor: pointer; font-size: 13px; color: #555;
}
.dh-add-btn:hover { border-color: #49cc90; color: #49cc90; }
.dh-hint { font-size: 11px; color: #aaa; margin-top: 10px; }
`;

export const swaggerCustomJs = `
(function () {
  var STORAGE_KEY = 'swagger-dyn-headers';

  // Intercepta fetch para inyectar los headers en cada petición
  var _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      var extra = {};
      saved.forEach(function (h) { if (h.key && h.key.trim()) extra[h.key.trim()] = h.value || ''; });
      // Los headers propios del endpoint (p.ej. los del formulario de Swagger) tienen prioridad
      init.headers = Object.assign({}, extra, init.headers || {});
    } catch (e) {}
    return _fetch(input, init);
  };

  function getHeaders() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) { return []; }
  }

  function saveHeaders(rows) {
    var data = [];
    rows.forEach(function (row) {
      data.push({ key: row.querySelector('.dh-key').value.trim(), value: row.querySelector('.dh-val').value });
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    updateBadge();
  }

  function updateBadge() {
    var panel = document.getElementById('dyn-headers-panel');
    if (!panel) return;
    var count = getHeaders().filter(function (h) { return h.key; }).length;
    var badge = panel.querySelector('.dh-badge');
    badge.textContent = count > 0 ? count + ' activo' + (count > 1 ? 's' : '') : '';
    badge.style.display = count > 0 ? '' : 'none';
  }

  function addRow(panel, key, value) {
    var row = document.createElement('div');
    row.className = 'dh-row';
    row.innerHTML =
      '<input class="dh-key" placeholder="Header  (ej: x-user-id)" value="' + (key || '') + '" />' +
      '<input class="dh-val" placeholder="Value" value="' + (value || '') + '" />' +
      '<button class="dh-del" title="Eliminar">✕</button>';
    var container = panel.querySelector('.dh-rows');
    container.appendChild(row);

    row.querySelector('.dh-del').addEventListener('click', function () {
      row.remove();
      saveHeaders(container.querySelectorAll('.dh-row'));
    });
    row.querySelector('.dh-key').addEventListener('input', function () { saveHeaders(container.querySelectorAll('.dh-row')); });
    row.querySelector('.dh-val').addEventListener('input', function () { saveHeaders(container.querySelectorAll('.dh-row')); });
  }

  function inject() {
    var swaggerUi = document.querySelector('.swagger-ui');
    if (!swaggerUi || document.getElementById('dyn-headers-panel')) { return; }

    var panel = document.createElement('div');
    panel.id = 'dyn-headers-panel';
    panel.innerHTML =
      '<div class="dh-title">' +
        '<span class="dh-arrow">▶</span>' +
        'Custom Headers' +
        '<span class="dh-badge" style="display:none"></span>' +
      '</div>' +
      '<div class="dh-body">' +
        '<div class="dh-rows"></div>' +
        '<button class="dh-add-btn">+ Agregar header</button>' +
        '<p class="dh-hint">Los headers se aplican a todas las peticiones. Los del formulario del endpoint tienen prioridad.</p>' +
      '</div>';

    swaggerUi.prepend(panel);

    panel.querySelector('.dh-title').addEventListener('click', function () {
      panel.classList.toggle('dh-open');
    });

    panel.querySelector('.dh-add-btn').addEventListener('click', function () {
      addRow(panel, '', '');
      if (!panel.classList.contains('dh-open')) panel.classList.add('dh-open');
    });

    // Cargar headers guardados
    var saved = getHeaders();
    if (saved.length > 0) {
      saved.forEach(function (h) { addRow(panel, h.key, h.value); });
      panel.classList.add('dh-open');
    }

    updateBadge();
  }

  // Reintentar hasta que Swagger UI haya montado el DOM
  var attempts = 0;
  var interval = setInterval(function () {
    inject();
    if (document.getElementById('dyn-headers-panel') || ++attempts > 20) clearInterval(interval);
  }, 500);
})();
`;
