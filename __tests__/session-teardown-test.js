/** @jest-environment jsdom */
import C3DAnalytics from '../lib/cjs/index.cjs.js';

const settings = {
    config: {
        APIKey: 'test-api-key',
        networkHost: 'data.cognitive3d.com',
        allSceneData: [
            { sceneName: 'BasicScene', sceneId: '93f486e4-0e22-4650-946a-e64ce527f915', versionNumber: '1' },
        ],
    },
};

function makeActiveC3D() {
    const c3d = new C3DAnalytics(settings);
    c3d.core.setSessionStatus = false;
    c3d.core.resetNewUserDeviceProperties();
    c3d.core.setDeviceId = 'test-device';
    c3d.core.setSessionTimestamp = 1000;
    c3d.setScene('BasicScene');
    c3d.core.setSessionStatus = true;
    c3d.core.setSessionId = '1000_test-device';
    return c3d;
}

function stubNetwork(c3d, failing) {
    for (const mod of ['customEvent', 'gaze', 'sensor', 'dynamicObject', 'fixation', 'roomCapture']) {
        c3d[mod].network = {
            networkCall: () => (failing.includes(mod) ? Promise.reject(404) : Promise.resolve(200)),
        };
    }
}

test('a non-200 from one endpoint still tears the session down', async () => {
    const c3d = makeActiveC3D();
    stubNetwork(c3d, ['roomCapture']);
    c3d.customEvent.send('probe', [0, 0, 0], {});
    c3d.roomCapture.processFrame(
        {
            detectedPlanes: new Set([{
                planeSpace: {},
                polygon: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }],
                semanticLabel: 'floor',
            }]),
            getPose: () => ({ transform: { position: { x: 0, y: 0, z: -2 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }),
        },
        {},
    );

    await expect(c3d.endSession()).resolves.toBeDefined();

    expect(c3d.isSessionActive()).toBe(false);
    expect(c3d.core.sessionId).toBe('');
    expect(c3d.core.sessionTimestamp).toBe(0);
});

test('every endpoint failing still tears the session down', async () => {
    const c3d = makeActiveC3D();
    stubNetwork(c3d, ['customEvent', 'gaze', 'sensor', 'dynamicObject', 'fixation', 'roomCapture']);
    c3d.customEvent.send('probe', [0, 0, 0], {});

    await expect(c3d.endSession()).resolves.toBeDefined();
    expect(c3d.isSessionActive()).toBe(false);
    expect(c3d.core.sessionId).toBe('');
});

test('sendData resolves rather than rejecting when one endpoint fails', async () => {
    const c3d = makeActiveC3D();
    stubNetwork(c3d, ['gaze']);
    c3d.customEvent.send('probe', [0, 0, 0], {});
    c3d.gaze.recordGaze([0, 0, 0], [0, 0, 0, 1]);

    await expect(c3d.sendData()).resolves.toBe(200);
    expect(c3d.isSessionActive()).toBe(true);
});