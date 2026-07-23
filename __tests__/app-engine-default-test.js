/**
 * @jest-environment jsdom
 *
 * Adapter-less ("plain core") usage must still carry c3d.app.engine (and c3d.sdk.type) so the
 * pipeline's enrichment layer — which treats c3d.app.engine as a required core prop — does not
 * drop the session. Engine adapters overwrite c3d.app.engine in their startTracking(); this
 * verifies the core-provided default when no adapter is used.
 */
import C3DAnalytics from '../lib/cjs/index.cjs.js';

const settings = {
    config: {
        APIKey: 'test-api-key',
        networkHost: 'data.cognitive3d.com',
        allSceneData: [
            {
                sceneName: 'BasicScene',
                sceneId: '93f486e4-0e22-4650-946a-e64ce527f915',
                versionNumber: '1',
            },
        ],
    },
};

test('core sets a default c3d.app.engine and c3d.sdk.type for adapter-less usage', () => {
    const c3d = new C3DAnalytics(settings);
    expect(c3d.core.sessionProperties['c3d.app.engine']).toBe('WebXR');
    expect(c3d.core.sessionProperties['c3d.sdk.type']).toBe('WebXR');
});

test('an engine adapter value overrides the default c3d.app.engine', () => {
    const c3d = new C3DAnalytics(settings);
    // Adapters call setDeviceProperty('AppEngine', ...) in startTracking() — simulate that here.
    c3d.setDeviceProperty('AppEngine', 'Three.js');
    expect(c3d.core.sessionProperties['c3d.app.engine']).toBe('Three.js');
});
