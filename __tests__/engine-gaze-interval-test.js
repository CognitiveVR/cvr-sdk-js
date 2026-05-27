/**
 * @jest-environment jsdom
 */

jest.mock('three', () => {
    class Vector2 {
        constructor(x = 0, y = 0) {
            this.x = x;
            this.y = y;
        }
    }

    class Vector3 {
        constructor(x = 0, y = 0, z = 0) {
            this.x = x;
            this.y = y;
            this.z = z;
        }

        set(x, y, z) {
            this.x = x;
            this.y = y;
            this.z = z;
            return this;
        }

        transformDirection() {
            return this;
        }

        clone() {
            return new Vector3(this.x, this.y, this.z);
        }

        copy(other) {
            this.x = other.x;
            this.y = other.y;
            this.z = other.z;
            return this;
        }

        add(other) {
            this.x += other.x;
            this.y += other.y;
            this.z += other.z;
            return this;
        }

        addScaledVector(other, scalar) {
            this.x += other.x * scalar;
            this.y += other.y * scalar;
            this.z += other.z * scalar;
            return this;
        }

        sub(other) {
            this.x -= other.x;
            this.y -= other.y;
            this.z -= other.z;
            return this;
        }

        applyQuaternion() {
            return this;
        }

        normalize() {
            return this;
        }
    }

    class Quaternion {
        constructor(x = 0, y = 0, z = 0, w = 1) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
        }

        set(x, y, z, w) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
            return this;
        }

        copy(other) {
            this.x = other.x;
            this.y = other.y;
            this.z = other.z;
            this.w = other.w;
            return this;
        }

        invert() {
            return this;
        }

        premultiply() {
            return this;
        }
    }

    class Object3D {}

    return {
        REVISION: 'test',
        Vector2,
        Vector3,
        Quaternion,
        Object3D,
        Raycaster: class {
            constructor() {
                this.ray = {
                    origin: new Vector3(0, 1, 2),
                    direction: new Vector3(0.25, -0.5, 0.75),
                };
            }

            setFromCamera() {
                this.ray.origin.set(0, 1, 2);
                this.ray.direction.set(0.25, -0.5, 0.75);
            }

            intersectObjects() {
                return [];
            }
        },
        WebXRManager: class {},
    };
}, { virtual: true });

jest.mock('three/examples/jsm/exporters/GLTFExporter.js', () => ({
    GLTFExporter: class {},
}), { virtual: true });

jest.mock('jszip', () => class JSZipMock {}, { virtual: true });

import ThreeAdapter from '../lib/cjs/adapters/threejs-adapter.cjs.js';

describe('Three.js engine gaze interval', () => {
    const createCameraStub = () => ({
        matrixWorld: {},
        updateWorldMatrix: jest.fn(),
        getWorldPosition: jest.fn((target) => {
            target.x = 0;
            target.y = 1;
            target.z = 2;
            return target;
        }),
        getWorldQuaternion: jest.fn((target) => {
            target.x = 0;
            target.y = 0;
            target.z = 0;
            target.w = 1;
            return target;
        }),
    });

    const createC3DStub = () => ({
        setDeviceProperty: jest.fn(),
        core: {
            config: {
                GazeInterval: 0.1,
            },
        },
        gaze: {
            recordGaze: jest.fn(),
        },
        gazeRaycaster: null,
    });

    // Identity-transform origin stub. decompose() is a no-op so the internal
    // temps stay at their zero/identity defaults, leaving poses unchanged.
    const createAnalyticsOriginStub = () => ({
        updateWorldMatrix: jest.fn(),
        matrixWorld: { decompose: jest.fn() },
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('records every 60 Hz frame and emits a synthetic forward endpoint when nothing is hit', () => {
        const c3d = createC3DStub();
        const adapter = new ThreeAdapter(c3d);
        adapter._camera = createCameraStub();
        adapter._analyticsOrigin = createAnalyticsOriginStub();
        adapter._lastGazeTime = Number.NEGATIVE_INFINITY;

        // Five 60 Hz render frames — at the 16.66 ms cap every frame should
        // produce a sample, which is what mobile AR replay needs to look
        // smooth.
        const timestamps = [0, 17, 34, 51, 68];
        let timestampIndex = 0;
        jest.spyOn(performance, 'now').mockImplementation(() => timestamps[timestampIndex++]);

        for (let i = 0; i < timestamps.length; i++) {
            adapter._recordEngineGaze();
        }

        expect(c3d.gaze.recordGaze).toHaveBeenCalledTimes(5);
        expect(c3d.gaze.recordGaze.mock.calls[0][0]).toEqual([0, 1, -2]);
        expect(c3d.gaze.recordGaze.mock.calls[0][1]).toEqual([0, 0, -0, -1]);
        // Every sample carries a `g` payload — a synthetic world-space
        // endpoint along the camera forward when there is no real hit. This
        // keeps the dashboard's beam base locked to the current head pose
        // between actual object hits.
        expect(c3d.gaze.recordGaze.mock.calls[0]).toHaveLength(3);
        const fallback = c3d.gaze.recordGaze.mock.calls[0][2];
        expect(fallback.objectId).toBe('');
        expect(Array.isArray(fallback.point)).toBe(true);
        expect(fallback.point).toHaveLength(3);
        // Mock camera world position is (0,1,2) and forward stays (0,0,-1)
        // through the stub's transformDirection, so endpoint = (0,1,2) + 2*(0,0,-1)
        // = (0,1,0), Z-flipped to (0,1,-0) (i.e. 0).
        expect(fallback.point[0]).toBeCloseTo(0);
        expect(fallback.point[1]).toBeCloseTo(1);
        expect(fallback.point[2]).toBeCloseTo(0);
    });

    test('still throttles below the 60 Hz cap when frames arrive faster', () => {
        const c3d = createC3DStub();
        const adapter = new ThreeAdapter(c3d);
        adapter._camera = createCameraStub();
        adapter._analyticsOrigin = createAnalyticsOriginStub();
        adapter._lastGazeTime = Number.NEGATIVE_INFINITY;

        // 120 Hz-style timing: 8 ms per frame. Only every other frame should
        // pass the 16.66 ms gate.
        const timestamps = [0, 8, 16, 24, 32, 40, 48];
        let timestampIndex = 0;
        jest.spyOn(performance, 'now').mockImplementation(() => timestamps[timestampIndex++]);

        for (let i = 0; i < timestamps.length; i++) {
            adapter._recordEngineGaze();
        }

        // Records at t=0, t=24 (24 > 16.66 from 0), t=48 (48-24=24 > 16.66).
        expect(c3d.gaze.recordGaze).toHaveBeenCalledTimes(3);
    });

    test('uses configured interval without the 60 Hz cap when no analytics origin is set', () => {
        const c3d = createC3DStub(); // GazeInterval: 0.1 → 100 ms
        const adapter = new ThreeAdapter(c3d);
        adapter._camera = createCameraStub();
        // No _analyticsOrigin — simulates a standard WebXR/VR session.
        adapter._lastGazeTime = Number.NEGATIVE_INFINITY;

        // Six frames spread over ~83 ms — well under the 100 ms configured
        // interval. Only the very first frame should produce a sample.
        const timestamps = [0, 17, 34, 51, 68, 85];
        let timestampIndex = 0;
        jest.spyOn(performance, 'now').mockImplementation(() => timestamps[timestampIndex++]);

        for (let i = 0; i < timestamps.length; i++) {
            adapter._recordEngineGaze();
        }

        expect(c3d.gaze.recordGaze).toHaveBeenCalledTimes(1);
    });

    test('passes null gaze payload on no-hit frames when no analytics origin is set', () => {
        const c3d = createC3DStub();
        const adapter = new ThreeAdapter(c3d);
        adapter._camera = createCameraStub();
        // No _analyticsOrigin — synthetic fallback should NOT activate.
        adapter._lastGazeTime = Number.NEGATIVE_INFINITY;

        jest.spyOn(performance, 'now').mockReturnValue(0);
        adapter._recordEngineGaze();

        expect(c3d.gaze.recordGaze).toHaveBeenCalledTimes(1);
        // Third argument should be null — preserves pre-WebAR behaviour.
        expect(c3d.gaze.recordGaze.mock.calls[0][2]).toBeNull();
    });
});
