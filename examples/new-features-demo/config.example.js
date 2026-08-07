// Copy this file to `config.js` in the same folder and fill in your own values.
// `config.js` is gitignored so real API keys are never committed.
//
// Use a DATA-scoped Application API Key and a Scene (Name / ID / Version) from the
// Cognitive3D dashboard. `networkHost` is `data.cognitive3d.com` for prod or
// `data.c3ddev.com` for the dev backend.
window.C3D_DEMO_CONFIG = {
  apiKey: 'YOUR_DATA_SCOPED_APPLICATION_API_KEY',
  networkHost: 'data.cognitive3d.com',
  // UUID the dashboard assigns to an uploaded dynamic object, per scene. The replay
  // matches a session's dynamic object against this id, so it must be updated whenever the
  // object is re-uploaded or the scene changes. Leave unset to fall back to a locally
  // derived id, which will not resolve on the dashboard.
  cubeObjectId: 'your-dynamic-object-uuid',

  scene: {
    sceneName: 'YourSceneName',
    sceneId: 'your-scene-id',
    versionNumber: '1',
  },
};
