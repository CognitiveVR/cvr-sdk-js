/**
 * C3DValidation — shared init helper for the validation-app pages.
 *
 * This wraps the REAL @cognitive3d/analytics SDK, loaded on each page as the
 * classic global `window.C3D` (built via `npm run build` from the repo root,
 * see ../../lib/c3d.umd.js). It never reimplements any signal-capture logic —
 * it only calls the SDK's public API and hands back the instance so the
 * overlay can read what the SDK itself captured.
 *
 * Classic script, no bundler, no ES modules. Exposes `window.C3DValidation`.
 */
(function () {
  'use strict';

  /**
   * Reads the `?env=` query param. Defaults to 'dev'. Anything other than the
   * literal string 'prod' is treated as 'dev', so a missing/typo'd param
   * fails toward the safer (non-production) environment.
   */
  function getEnvParam() {
    var params = new URLSearchParams(window.location.search);
    return params.get('env') === 'prod' ? 'prod' : 'dev';
  }

  /**
   * Returns the config block for the currently selected environment (as
   * produced by generate-config.mjs into window.C3D_VALIDATION_CONFIG), or
   * null if config.js hasn't been generated yet, or that environment isn't
   * filled in.
   */
  function getConfig() {
    var env = getEnvParam();
    if (!window.C3D_VALIDATION_CONFIG) return null;
    return window.C3D_VALIDATION_CONFIG[env] || null;
  }

  // Cognitive3D dashboard "project sessions" views, one per environment. Backs the
  // "See Sessions" link so a tester can jump straight to the sessions this app records.
  var DASHBOARD_SESSIONS_URLS = {
    dev: 'https://app.c3ddev.com/v3/projects/691/projectsessions/all',
    prod: 'https://app.cognitive3d.com/v3/projects/5163/projectsessions/all'
  };

  /** A "See Sessions" link to the dashboard for the currently selected environment. */
  function getSeeSessionsHtml() {
    var link = document.createElement('a');
    link.setAttribute('href', DASHBOARD_SESSIONS_URLS[getEnvParam()]);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
    link.textContent = 'See Sessions ↗';
    return link.outerHTML;
  }

  /**
   * Small HTML snippet: a dev/prod toggle link pair that preserves the
   * current path and any other query params. Pages drop this into a
   * container element so switching environments is one click.
   *
   * Built with DOM APIs (createElement / setAttribute / textContent) and
   * serialized via outerHTML, so the browser owns all escaping. `env` is
   * always the literal 'dev'/'prod' and the href is a same-origin relative
   * path, but going through the DOM keeps this injection-safe by construction
   * rather than relying on hand-rolled escaping of a string assigned via
   * innerHTML.
   */
  function getEnvToggleHtml() {
    var current = getEnvParam();
    var params = new URLSearchParams(window.location.search);

    function linkFor(env) {
      params.set('env', env);
      if (env === current) {
        var label = document.createElement('strong');
        label.textContent = '[' + env + ']';
        return label.outerHTML;
      }
      var link = document.createElement('a');
      link.setAttribute('href', window.location.pathname + '?' + params.toString());
      link.textContent = env;
      return link.outerHTML;
    }

    return 'Environment: ' + linkFor('dev') + ' &nbsp;|&nbsp; ' + linkFor('prod') +
           ' &nbsp;&middot;&nbsp; ' + getSeeSessionsHtml();
  }

  // Human-readable "OS · Browser" label for the running environment (e.g. "macOS · Chrome",
  // "Android · Quest Browser"). Used only to build a scannable participant name — this is a
  // display label, NOT a device signal (the SDK sends raw signals for the pipeline to classify).
  function getEnvironmentLabel() {
    var ua = navigator.userAgent || '';
    var os = 'Unknown OS';
    if (/Windows NT/.test(ua)) os = 'Windows';
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Linux/.test(ua)) os = 'Linux';

    var browser = 'Unknown Browser';
    if (/OculusBrowser/.test(ua)) browser = 'Quest Browser';
    else if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
    else if (/OPR\//.test(ua)) browser = 'Opera';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua)) browser = 'Safari';

    return os + ' · ' + browser;
  }

  // Short experience tag for the participant name. Prefers the caller's explicit hint
  // ('2D' | 'VR' | 'AR'); falls back to the XRSession mode, then to 2D/XR.
  function getExperienceLabel(experience, xrSession) {
    if (experience === '2D' || experience === 'VR' || experience === 'AR') return experience;
    var mode = xrSession && xrSession.mode;
    if (mode === 'immersive-vr') return 'VR';
    if (mode === 'immersive-ar') return 'AR';
    return xrSession ? 'XR' : '2D';
  }

  var UNHANDLED_REJECTION_FLAG = '__c3dValidationUnhandledRejectionHooked';

  /**
   * The SDK batches gaze/event/sensor/dynamic-object data and flushes it over
   * the network without the caller awaiting every send (see
   * CustomEvent.send() -> sendData() in src/customevent.ts, called
   * fire-and-forget from startSession's "Session Start" event). That means a
   * bad/placeholder API key, or an unreachable networkHost, surfaces as a
   * rejected promise nobody in this app is holding a reference to — an
   * "unhandledrejection" event, not an exception init() can catch with
   * try/catch. We log and swallow it here so it doesn't look like a crash and
   * doesn't stop the overlay: the overlay only needs the device signals
   * captured at construction time, not a successful network round-trip.
   */
  function hookUnhandledRejections() {
    if (window[UNHANDLED_REJECTION_FLAG]) return;
    window[UNHANDLED_REJECTION_FLAG] = true;
    window.addEventListener('unhandledrejection', function (event) {
      console.warn(
        '[C3DValidation] Ignoring an async SDK network/session rejection ' +
          '(expected if using a placeholder API key or an unreachable host): ',
        event.reason
      );
      event.preventDefault();
    });
  }

  /**
   * Constructs the real SDK, sets the scene + required app version, and
   * starts a session. Pass an XRSession to also capture XR device signals
   * (input profiles, session mode, reference space); pass null (default) for
   * a non-XR page.
   *
   * Throws synchronously for setup mistakes the caller should surface
   * directly: no config for the current ?env, or c3d.umd.js not built/loaded.
   *
   * Does NOT throw for network failures during startSession (bad key,
   * unreachable host, ...) — those are caught and logged instead, because
   * device signals are already captured by the time the constructor returns,
   * and the overlay should render them regardless of whether the session
   * made it to the server.
   *
   * @param {{ xrSession?: XRSession | null, experience?: '2D' | 'VR' | 'AR' }} [options]
   * @returns {Promise<InstanceType<typeof window.C3D>>}
   */
  async function init(options) {
    var xrSession = options && 'xrSession' in options ? options.xrSession : null;

    var config = getConfig();
    if (!config) {
      throw new Error(
        'C3DValidation.init: no config for env "' + getEnvParam() + '". ' +
          'Copy examples/validation-app/.env.example to .env, fill it in, then run ' +
          '`node examples/validation-app/generate-config.mjs`.'
      );
    }
    if (typeof window.C3D === 'undefined') {
      throw new Error(
        'C3DValidation.init: window.C3D is not defined. Run `npm run build` from the ' +
          'repo root, then make sure this page loads ../../lib/c3d.umd.js.'
      );
    }

    hookUnhandledRejections();

    // Constructing C3D captures every non-XR device signal (user agent, UA
    // brands/mobile, touch/pointer/hover media queries, device memory, GPU,
    // screen size, CPU threads, ...) synchronously, before any network call —
    // so it survives whatever happens below.
    var c3d = new window.C3D({
      config: {
        APIKey: config.apiKey,
        networkHost: config.networkHost,
        allSceneData: [config.scene]
      }
    });

    try {
      c3d.setScene(config.scene.sceneName);
      c3d.setUserProperty('c3d.app.version', '1.0'); // docs mark this required
      // App/engine metadata normally supplied by an engine adapter (e.g. the Three.js
      // adapter sets AppEngine='Three.js', AppEngineVersion=THREE.REVISION). This app uses
      // the plain core SDK with NO adapter, so we set them explicitly: the enrichment
      // pipeline (melder) treats c3d.app.engine as a required core prop and drops sessions
      // that omit it (InvalidSessionException: "session missing the following core props:
      // c3d.app.engine"). Without this the session ingests (HTTP 200) but never reaches the
      // query layer.
      c3d.setDeviceProperty('AppName', 'C3D WebXR Validation App');
      c3d.setDeviceProperty('AppEngine', 'WebXR');
      c3d.setDeviceProperty('AppEngineVersion', (c3d.core && c3d.core.config && c3d.core.config.SDKVersion) || 'unknown');
      // Participant name = experience + environment, e.g. "VR — macOS · Chrome", so session
      // types are easy to scan in the dashboard's Participant column. Deliberately NO dev/prod —
      // the dashboard already scopes by environment, so it would be redundant.
      c3d.setParticipantFullName(
        getExperienceLabel(options && options.experience, xrSession) + ' — ' + getEnvironmentLabel()
      );
      await c3d.startSession(xrSession);
    } catch (err) {
      console.error(
        '[C3DValidation] startSession did not complete cleanly — device signals ' +
          'captured above are still valid, but no session may have reached the server:',
        err
      );
    }

    // Stashed on window so pages (and this page's own buttons) can reach the
    // live instance without threading it through every event handler.
    window.__c3d = c3d;
    return c3d;
  }

  window.C3DValidation = {
    getEnvParam: getEnvParam,
    getConfig: getConfig,
    getEnvToggleHtml: getEnvToggleHtml,
    init: init
  };
})();
