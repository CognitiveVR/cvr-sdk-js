// Example config for examples/validation-app/ — mirrors the shape that
// generate-config.mjs produces at config.js (gitignored, never commit it).
//
// To produce a real, working config.js:
//   1. cp examples/validation-app/.env.example examples/validation-app/.env
//   2. Fill in .env with your Cognitive3D Application API Key(s) (DATA-scoped)
//      and scene name/id/version from the Cognitive3D dashboard.
//   3. node examples/validation-app/generate-config.mjs
//
// The values below are obviously fake placeholders — this file is committed
// purely as documentation of the expected shape, and is never loaded by the
// validation-app pages (they load the generated config.js instead).
window.C3D_VALIDATION_CONFIG = {
  dev: {
    apiKey: 'YOUR_DEV_APPLICATION_API_KEY',
    networkHost: 'data.c3ddev.com',
    scene: {
      sceneName: 'YourSceneName',
      sceneId: '00000000-0000-0000-0000-000000000000',
      versionNumber: '1'
    }
  },
  prod: {
    apiKey: 'YOUR_PROD_APPLICATION_API_KEY',
    networkHost: 'data.cognitive3d.com',
    scene: {
      sceneName: 'YourSceneName',
      sceneId: '00000000-0000-0000-0000-000000000000',
      versionNumber: '1'
    }
  }
};
