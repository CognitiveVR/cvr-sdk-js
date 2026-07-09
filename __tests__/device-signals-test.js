/**
 * @jest-environment jsdom
 *
 * Raw device-signal coverage (C3D-1726). Verifies the SDK sends RAW signals and does no
 * in-SDK device classification: raw UA / UA-CH / touch / GPU-vendor / memory at construction,
 * and raw WebXR input profiles (not a classified HMD/controller identity) during a session.
 *
 * Hermetic: c3d.sendData (and customEvent.send for the session test) are mocked so no real
 * backend flush occurs — assertions read in-memory session/device properties only.
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

const scene1 = settings.config.allSceneData[0].sceneName;

// Fake WebGL param keys — arbitrary, matched by getParameter below.
const UNMASKED_VENDOR = 0x9245;
const UNMASKED_RENDERER = 0x9246;

function defineNav(prop, value) {
    Object.defineProperty(navigator, prop, { value, configurable: true });
}

// Stub the browser globals the SDK reads at construction, BEFORE constructing C3DAnalytics.
function stubEnvironment(opts = {}) {
    const { userAgent, uaData, deviceMemory, maxTouchPoints, pointerCoarse, hoverHover, gpuVendor, gpuRenderer } = opts;

    if (userAgent !== undefined) defineNav('userAgent', userAgent);
    if (uaData !== undefined) defineNav('userAgentData', uaData);
    if (deviceMemory !== undefined) defineNav('deviceMemory', deviceMemory);
    if (maxTouchPoints !== undefined) defineNav('maxTouchPoints', maxTouchPoints);

    window.matchMedia = jest.fn((query) => ({
        matches: query.includes('pointer: coarse')
            ? Boolean(pointerCoarse)
            : query.includes('hover: hover')
                ? Boolean(hoverHover)
                : false,
        media: query,
    }));

    const fakeGl = {
        getExtension: (name) =>
            name === 'WEBGL_debug_renderer_info'
                ? { UNMASKED_VENDOR_WEBGL: UNMASKED_VENDOR, UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER }
                : null,
        getParameter: (p) => (p === UNMASKED_VENDOR ? gpuVendor : p === UNMASKED_RENDERER ? gpuRenderer : null),
    };
    HTMLCanvasElement.prototype.getContext = jest.fn(() => fakeGl);
}

// Construct after stubbing the environment; mock the network flush so setScene stays hermetic.
function makeC3D() {
    const c3d = new C3DAnalytics(settings);
    c3d.sendData = jest.fn().mockResolvedValue(200);
    c3d.setScene(scene1);
    return c3d;
}

function createXRSessionMock({ mode, localFloorSpace, boundedFloorSpace, inputSources = [] }) {
    return {
        mode,
        inputSources,
        enabledFeatures: [],
        requestReferenceSpace: jest.fn((type) => {
            if (type === 'local-floor' && localFloorSpace) return Promise.resolve(localFloorSpace);
            if (type === 'bounded-floor' && boundedFloorSpace) return Promise.resolve(boundedFloorSpace);
            return Promise.reject(new Error(`Unsupported reference space: ${type}`));
        }),
        requestAnimationFrame: jest.fn(() => 1),
        cancelAnimationFrame: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    };
}

test('Captures raw device-identity signals at construction (desktop profile)', () => {
    stubEnvironment({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
        uaData: {
            mobile: false,
            brands: [
                { brand: 'Microsoft Edge', version: '120' },
                { brand: 'Chromium', version: '120' },
            ],
        },
        deviceMemory: 8,
        maxTouchPoints: 0,
        pointerCoarse: false,
        hoverHover: true,
        gpuVendor: 'Google Inc. (NVIDIA)',
        gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11)',
    });

    const c3d = makeC3D();
    const dp = c3d.getDeviceProperties();

    // Raw UA + UA-CH, verbatim (no classification into OS/browser/device-type).
    expect(dp['c3d.device.user_agent']).toContain('Edg/120.0.0.0');
    expect(dp['c3d.device.ua_brands']).toEqual([
        { brand: 'Microsoft Edge', version: '120' },
        { brand: 'Chromium', version: '120' },
    ]);
    // Falsy-but-meaningful values must still be sent (guarded on !== null, not truthiness).
    expect(dp['c3d.device.ua_mobile']).toBe(false);
    expect(dp['c3d.device.max_touch_points']).toBe(0);
    expect(dp['c3d.device.pointer_coarse']).toBe(false);
    expect(dp['c3d.device.hover_hover']).toBe(true);

    // Memory: legacy MB kept for pipeline continuity; raw GB added under a unit-suffixed key.
    expect(dp['c3d.device.memory']).toBe(8000);
    expect(dp['c3d.device.memoryInGB']).toBe(8);

    // Raw GPU strings, verbatim.
    expect(dp['c3d.device.gpu']).toBe('ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11)');
    expect(dp['c3d.device.gpu.vendor']).toBe('Google Inc. (NVIDIA)');
});

test('Captures raw touch/mobile signals for a phone profile', () => {
    stubEnvironment({
        userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        uaData: { mobile: true, brands: [{ brand: 'Chromium', version: '120' }] },
        deviceMemory: 4,
        maxTouchPoints: 5,
        pointerCoarse: true,
        hoverHover: false,
        gpuVendor: 'Google Inc. (Qualcomm)',
        gpuRenderer: 'ANGLE (Qualcomm, Adreno (TM) 650)',
    });

    const c3d = makeC3D();
    const dp = c3d.getDeviceProperties();

    expect(dp['c3d.device.ua_mobile']).toBe(true);
    expect(dp['c3d.device.max_touch_points']).toBe(5);
    expect(dp['c3d.device.pointer_coarse']).toBe(true);
    expect(dp['c3d.device.hover_hover']).toBe(false);
});

test('Does not override GPU vendor for Adreno renderers (raw UNMASKED_VENDOR preserved)', () => {
    stubEnvironment({
        deviceMemory: 4,
        maxTouchPoints: 5,
        pointerCoarse: true,
        hoverHover: false,
        gpuVendor: 'Google Inc. (Qualcomm)',
        gpuRenderer: 'ANGLE (Qualcomm, Adreno (TM) 650)',
    });

    const c3d = makeC3D();
    const dp = c3d.getDeviceProperties();

    // The removed override would have forced the bare string "Qualcomm"; the raw value must survive.
    expect(dp['c3d.device.gpu.vendor']).toBe('Google Inc. (Qualcomm)');
    expect(dp['c3d.device.gpu.vendor']).not.toBe('Qualcomm');
});

test('Sends raw XR input profiles instead of a classified HMD type/vendor', async () => {
    const xrSession = createXRSessionMock({
        mode: 'immersive-vr',
        localFloorSpace: { kind: 'local-floor' },
        boundedFloorSpace: { kind: 'bounded-floor', boundsGeometry: [] },
        inputSources: [
            {
                handedness: 'left',
                targetRayMode: 'tracked-pointer',
                gripSpace: { kind: 'controller-grip' },
                profiles: ['meta-quest-touch-plus', 'generic-trigger-squeeze-thumbstick'],
            },
            {
                handedness: 'right',
                targetRayMode: 'tracked-pointer',
                gripSpace: { kind: 'controller-grip' },
                profiles: ['meta-quest-touch-plus', 'generic-trigger-squeeze-thumbstick'],
            },
        ],
    });

    const c3d = makeC3D();
    c3d.customEvent.send = jest.fn(); // avoid the 'Session Start' backend call

    await expect(c3d.startSession(xrSession)).resolves.toBe(true);
    const dp = c3d.getDeviceProperties();

    // Flattened + de-duplicated raw profiles across both input sources.
    expect(dp['c3d.device.xr.input_profiles']).toEqual([
        'meta-quest-touch-plus',
        'generic-trigger-squeeze-thumbstick',
    ]);
    // The classified keys are gone entirely.
    expect(dp['c3d.device.hmd.type']).toBeUndefined();
    expect(dp['c3d.device.vendor']).toBeUndefined();
});

test('Controller manifest carries raw input profiles, not a classified controllerType', () => {
    const c3d = makeC3D();

    c3d.dynamicObject.registerControllerObject(
        'Right Controller',
        'QuestPlusTouchRight',
        'c3d_controller_right',
        [0, 0, 0],
        [0, 0, 0, 1],
        ['meta-quest-touch-plus', 'generic-trigger-squeeze-thumbstick'],
        'right',
    );

    const entry = c3d.dynamicObject.manifestEntries.find((e) => e.id === 'c3d_controller_right');
    expect(entry).toBeDefined();
    expect(entry.inputProfiles).toEqual(['meta-quest-touch-plus', 'generic-trigger-squeeze-thumbstick']);
    expect(entry.controllerType).toBeUndefined();
});

test('setHMDType() is retained as a deprecated no-op that warns (no crash)', () => {
    const c3d = makeC3D();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => c3d.gaze.setHMDType('Quest 3')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deprecated'));

    warnSpy.mockRestore();
});

test('the deprecated HMDType config setting warns when provided', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const c3d = new C3DAnalytics({ config: { ...settings.config, HMDType: 'Quest 3' } });
    c3d.sendData = jest.fn().mockResolvedValue(200);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HMDType'));

    warnSpy.mockRestore();
});
