/**
 * C3DOverlay — shared, on-page status panel for the validation-app pages.
 *
 * Renders a fixed, scrollable panel showing exactly what the REAL SDK
 * captured (read from `c3d.core.sessionProperties`) next to what the raw
 * browser reports directly, so a human can eyeball whether they match on the
 * device/browser under test. Never invents or recomputes a signal — every
 * value either comes straight off `c3d.core.sessionProperties` or straight
 * off `navigator`/`matchMedia`.
 *
 * Classic script, no bundler, no ES modules. Exposes `window.C3DOverlay`.
 */
(function () {
  'use strict';

  // The raw device-signal keys this validation app exists to check. Flagged
  // visually wherever they show up in the captured table below.
  var RAW_SIGNAL_KEYS = [
    'c3d.device.user_agent',
    'c3d.device.ua_brands',
    'c3d.device.ua_mobile',
    'c3d.device.max_touch_points',
    'c3d.device.pointer_coarse',
    'c3d.device.hover_hover',
    'c3d.device.memoryInGB',
    'c3d.device.xr.input_profiles'
  ];

  var STYLE_ID = 'c3d-overlay-style';
  var ROOT_ID = 'c3d-overlay-root';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#' + ROOT_ID + '{position:fixed;top:0;right:0;width:min(480px,100vw);max-height:100vh;' +
      'overflow-y:auto;background:rgba(10,12,16,0.94);color:#e8e8e8;' +
      'font:14px/1.4 -apple-system,Menlo,Consolas,monospace;padding:12px 14px 28px;' +
      'z-index:999999;box-sizing:border-box;border-left:2px solid #3a7;}' +
      '#' + ROOT_ID + ' h2{font-size:15px;margin:14px 0 6px;color:#7fd0ff;' +
      'border-bottom:1px solid #333;padding-bottom:3px;}' +
      '#' + ROOT_ID + ' h2:first-child{margin-top:0;}' +
      '#' + ROOT_ID + ' table{width:100%;border-collapse:collapse;font-size:12px;}' +
      '#' + ROOT_ID + ' td,#' + ROOT_ID + ' th{border-bottom:1px solid #2a2a2a;padding:3px 4px;' +
      'text-align:left;vertical-align:top;word-break:break-all;}' +
      '#' + ROOT_ID + ' tr.flagged{background:rgba(255,210,0,0.12);}' +
      '#' + ROOT_ID + ' tr.flagged td:first-child{color:#ffd200;font-weight:bold;}' +
      '#' + ROOT_ID + ' .badge{display:inline-block;font-size:10px;padding:1px 5px;' +
      'border-radius:3px;margin-left:6px;}' +
      '#' + ROOT_ID + ' .badge-ok{background:#1f6b3a;color:#c8ffdd;}' +
      '#' + ROOT_ID + ' .badge-warn{background:#7a4d00;color:#ffe2b0;}' +
      '#' + ROOT_ID + ' .badge-err{background:#7a1f1f;color:#ffd0d0;}' +
      '#' + ROOT_ID + ' button{font:12px monospace;padding:5px 10px;margin:4px 0;cursor:pointer;}' +
      '#' + ROOT_ID + ' p{margin:6px 0;}' +
      '#' + ROOT_ID + ' code{background:#1c1c1c;padding:1px 4px;border-radius:3px;}';
    document.head.appendChild(style);
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function formatValue(value) {
    if (value === undefined) return '(not captured)';
    if (value === null) return 'null';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch (e) {
        return String(value);
      }
    }
    return String(value);
  }

  /** Pulls just the device/session properties out of the SDK's flat sessionProperties bag. */
  function getSdkProps(c3d) {
    if (!c3d || !c3d.core || !c3d.core.sessionProperties) return {};
    var all = c3d.core.sessionProperties;
    var out = {};
    Object.keys(all).forEach(function (key) {
      if (key.indexOf('c3d.device.') === 0 || key.indexOf('c3d.session.') === 0) {
        out[key] = all[key];
      }
    });
    return out;
  }

  function renderSdkTable(props) {
    var keys = Object.keys(props).sort();
    var rows = keys.map(function (key) {
      var flagged = RAW_SIGNAL_KEYS.indexOf(key) !== -1;
      return (
        '<tr class="' + (flagged ? 'flagged' : '') + '"><td>' +
        esc(key) +
        (flagged ? ' <span class="badge badge-warn">raw signal</span>' : '') +
        '</td><td>' + esc(formatValue(props[key])) + '</td></tr>'
      );
    });

    // Also surface any raw-signal key that wasn't captured at all on this page/session
    // (e.g. c3d.device.xr.input_profiles will be missing until an XR session starts).
    RAW_SIGNAL_KEYS.forEach(function (key) {
      if (!(key in props)) {
        rows.push(
          '<tr class="flagged"><td>' + esc(key) + ' <span class="badge badge-warn">raw signal</span></td>' +
            '<td><em>(not captured on this page/session)</em></td></tr>'
        );
      }
    });

    if (rows.length === 0) {
      return '<p><em>No device/session properties captured yet.</em></p>';
    }
    return '<table><tr><th>key</th><th>value</th></tr>' + rows.join('') + '</table>';
  }

  function renderBrowserTruth() {
    var uaData = navigator.userAgentData;
    var pointerCoarse = 'unknown (matchMedia unavailable)';
    var hoverHover = 'unknown (matchMedia unavailable)';
    try {
      pointerCoarse = window.matchMedia('(pointer: coarse)').matches;
    } catch (e) {
      /* matchMedia not available on this browser */
    }
    try {
      hoverHover = window.matchMedia('(hover: hover)').matches;
    } catch (e) {
      /* matchMedia not available on this browser */
    }

    var rows = [
      ['navigator.userAgent', navigator.userAgent],
      ['navigator.userAgentData.brands', uaData ? JSON.stringify(uaData.brands) : '(not supported by this browser)'],
      ['navigator.userAgentData.mobile', uaData ? uaData.mobile : '(not supported by this browser)'],
      ['navigator.deviceMemory', navigator.deviceMemory !== undefined ? navigator.deviceMemory : '(not supported by this browser)'],
      ['navigator.maxTouchPoints', navigator.maxTouchPoints],
      ["matchMedia('(pointer: coarse)').matches", pointerCoarse],
      ["matchMedia('(hover: hover)').matches", hoverHover],
      ['navigator.xr', navigator.xr ? 'available' : 'not available']
    ];

    var body = rows
      .map(function (r) {
        return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(formatValue(r[1])) + '</td></tr>';
      })
      .join('');

    return (
      '<table><tr><th>signal</th><th>raw browser value</th></tr>' + body + '</table>' +
      '<p style="opacity:.7;font-size:11px;">Compare each row above against the matching ' +
      '<code>c3d.device.*</code> row above it — they should agree on this device/browser.</p>'
    );
  }

  function renderXrSection(xrSession, capturedProfiles) {
    if (!xrSession) {
      return '<p><em>Not an XR session on this page — see immersive-vr.html / immersive-ar.html.</em></p>';
    }

    var sources = [];
    try {
      sources = Array.prototype.slice.call(xrSession.inputSources || []);
    } catch (e) {
      sources = [];
    }

    var liveRows;
    if (sources.length === 0) {
      liveRows = '<p><em>No input sources reported yet (controllers/hands may still be initializing).</em></p>';
    } else {
      liveRows =
        '<table><tr><th>handedness</th><th>targetRayMode</th><th>live profiles</th></tr>' +
        sources
          .map(function (src) {
            return (
              '<tr><td>' + esc(src.handedness || 'n/a') + '</td>' +
              '<td>' + esc(src.targetRayMode || 'n/a') + '</td>' +
              '<td>' + esc(JSON.stringify(src.profiles || [])) + '</td></tr>'
            );
          })
          .join('') +
        '</table>';
    }

    return (
      '<p><strong>Live xrSession.inputSources[].profiles:</strong></p>' + liveRows +
      '<p><strong>Captured c3d.device.xr.input_profiles:</strong> ' + esc(formatValue(capturedProfiles)) + '</p>'
    );
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for non-secure contexts / browsers without the async Clipboard API.
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) {
          resolve();
        } else {
          reject(new Error('execCommand("copy") failed'));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Renders/re-renders the overlay panel. Safe to call repeatedly (e.g. on a
   * 1s interval, or on `inputsourceschange`) — it rebuilds in place and
   * preserves scroll position.
   *
   * @param {InstanceType<typeof window.C3D> | null} c3d
   * @param {{ xr?: false | XRSession }} [opts] - pass the live XRSession on
   *   immersive pages so the input-profiles section has something to read;
   *   pass false (or omit) on non-XR pages.
   */
  function render(c3d, opts) {
    opts = opts || {};
    injectStyle();

    var root = document.getElementById(ROOT_ID);
    var scrollTop = root ? root.scrollTop : 0;
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }

    var validation = window.C3DValidation;
    var config = validation ? validation.getConfig() : null;
    var env = validation ? validation.getEnvParam() : 'dev';
    var sessionActive = !!(c3d && c3d.core && c3d.core.isSessionActive);
    var sdkProps = getSdkProps(c3d);

    var statusBadge = sessionActive
      ? '<span class="badge badge-ok">session active</span>'
      : c3d
        ? '<span class="badge badge-warn">session not active</span>'
        : '<span class="badge badge-err">SDK not initialized</span>';

    var html = '';

    html += '<h2>Session status ' + statusBadge + '</h2>';
    html +=
      '<table>' +
      '<tr><td>env</td><td>' + esc(env) + '</td></tr>' +
      '<tr><td>networkHost</td><td>' + esc(config ? config.networkHost : '(no config for this env)') + '</td></tr>' +
      '<tr><td>scene</td><td>' +
      esc(
        config
          ? config.scene.sceneName + ' / ' + config.scene.sceneId + ' v' + config.scene.versionNumber
          : '(no config for this env)'
      ) +
      '</td></tr>' +
      '</table>';

    html += '<h2>SDK-captured signals (c3d.core.sessionProperties)</h2>';
    html += renderSdkTable(sdkProps);

    html += '<h2>Browser truth (cross-check)</h2>';
    html += renderBrowserTruth();

    html += '<h2>XR input profiles</h2>';
    html += renderXrSection(opts.xr, sdkProps['c3d.device.xr.input_profiles']);

    html += '<h2>Export</h2>';
    html +=
      '<button id="c3d-overlay-copy" type="button">Copy captured properties as JSON</button>' +
      '<span id="c3d-overlay-copy-status" style="margin-left:8px;font-size:11px;"></span>';

    root.innerHTML = html;
    root.scrollTop = scrollTop;

    var copyBtn = document.getElementById('c3d-overlay-copy');
    var copyStatus = document.getElementById('c3d-overlay-copy-status');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        copyToClipboard(JSON.stringify(sdkProps, null, 2))
          .then(function () {
            copyStatus.textContent = 'copied!';
          })
          .catch(function (err) {
            copyStatus.textContent = 'copy failed: ' + err;
          });
      });
    }

    return root;
  }

  window.C3DOverlay = {
    render: render
  };
})();
