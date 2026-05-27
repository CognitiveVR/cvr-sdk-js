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

const scene1 = settings.config.allSceneData[0].sceneName;

function createXRSessionMock({ mode, supportedSpaces, inputSources = [] }) {
    const spaceMap = new Map(Object.entries(supportedSpaces));
    return {
        mode,
        inputSources,
        requestReferenceSpace: jest.fn((type) => {
            const space = spaceMap.get(type);
            if (space) {
                return Promise.resolve(space);
            }
            return Promise.reject(new Error(`Unsupported reference space: ${type}`));
        }),
        requestAnimationFrame: jest.fn(() => 1),
        cancelAnimationFrame: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    };
}

let c3d;

beforeEach(async () => {
    c3d = new C3DAnalytics(settings);
    c3d.setScene(scene1);
    c3d.core.resetNewUserDeviceProperties();
    c3d.sendData = jest.fn().mockResolvedValue(200);

    if (c3d.isSessionActive()) {
        await expect(c3d.endSession()).resolves.toEqual(200);
    }
});

test('Prefer local reference space for immersive-ar sessions and disable VR-only flags', async () => {
    const xrSession = createXRSessionMock({
        mode: 'immersive-ar',
        supportedSpaces: {
            local: { kind: 'local' },
        },
    });

    await expect(c3d.startSession(xrSession)).resolves.toBe(true);

    expect(xrSession.requestReferenceSpace.mock.calls.map(([type]) => type)).toEqual(['local']);
    expect(c3d.getXRSessionMode()).toEqual('immersive-ar');
    expect(c3d.getXRReferenceSpaceType()).toEqual('local');
    expect(c3d.isARSession()).toBe(true);
    expect(c3d.isVRSession()).toBe(false);
    expect(c3d.core.sessionProperties['c3d.session.xr.mode']).toEqual('immersive-ar');
    expect(c3d.core.sessionProperties['c3d.session.xr.reference_space']).toEqual('local');
    expect(c3d.core.sessionProperties['c3d.session.xr.boundary_available']).toBe(false);
    expect(c3d.core.sessionProperties['c3d.device.controllerinputs.enabled']).toBe(false);

    await expect(c3d.endSession()).resolves.toEqual(200);
});

test('Keep local-floor and tracked controller behavior for immersive-vr sessions', async () => {
    const xrSession = createXRSessionMock({
        mode: 'immersive-vr',
        supportedSpaces: {
            'local-floor': { kind: 'local-floor' },
            'bounded-floor': { kind: 'bounded-floor', boundsGeometry: [] },
        },
        inputSources: [
            {
                handedness: 'right',
                targetRayMode: 'tracked-pointer',
                gripSpace: { kind: 'controller-grip' },
                profiles: ['oculus-touch-v3'],
            },
        ],
    });

    await expect(c3d.startSession(xrSession)).resolves.toBe(true);

    expect(xrSession.requestReferenceSpace.mock.calls.map(([type]) => type)).toEqual(['local-floor', 'bounded-floor']);
    expect(c3d.getXRSessionMode()).toEqual('immersive-vr');
    expect(c3d.getXRReferenceSpaceType()).toEqual('local-floor');
    expect(c3d.isARSession()).toBe(false);
    expect(c3d.isVRSession()).toBe(true);
    expect(c3d.core.sessionProperties['c3d.session.xr.mode']).toEqual('immersive-vr');
    expect(c3d.core.sessionProperties['c3d.session.xr.reference_space']).toEqual('local-floor');
    expect(c3d.core.sessionProperties['c3d.session.xr.boundary_available']).toBe(true);
    expect(c3d.core.sessionProperties['c3d.device.controllerinputs.enabled']).toBe(true);
    expect(c3d.getDeviceProperties()['c3d.device.hmd.type']).toEqual('Quest 2');

    await expect(c3d.endSession()).resolves.toEqual(200);
});

test('Allow gaze raycasting to be attached after session start for mobile AR integrations', async () => {
    const xrSession = createXRSessionMock({
        mode: 'immersive-ar',
        supportedSpaces: {
            local: { kind: 'local' },
        },
    });

    await expect(c3d.startSession(xrSession)).resolves.toBe(true);

    const lateBoundRaycaster = jest.fn(() => ({
        objectId: 'late-bound-object',
        point: [1, 2, 3],
    }));
    const gazeSpy = jest.spyOn(c3d.gaze, 'recordGaze');

    c3d.gazeRaycaster = lateBoundRaycaster;

    c3d.xrSessionManager.onXRFrame(200, {
        getViewerPose: jest.fn(() => ({
            transform: {
                position: { x: 4, y: 5, z: 6 },
                orientation: { x: 0, y: 0, z: 0, w: 1 },
            },
        })),
    });

    expect(lateBoundRaycaster).toHaveBeenCalledTimes(1);
    expect(gazeSpy).toHaveBeenCalledTimes(1);
    expect(gazeSpy.mock.calls[0][2]).toEqual({
        objectId: 'late-bound-object',
        point: [1, 2, 3],
    });

    await expect(c3d.endSession()).resolves.toEqual(200);
});
