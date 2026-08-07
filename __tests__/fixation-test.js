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
    return c3d;
}

function captureNetwork(c3d) {
    const capture = { called: false };
    c3d.fixation.network = {
        networkCall: (suburl, payload) => { capture.called = true; capture.suburl = suburl; capture.payload = payload; return Promise.resolve(200); },
    };
    return capture;
}

const HMD = [0, 0, 0];

function endFixation(c3d, t) {
    c3d.fixation.recordGazeSample(t, HMD, { world: [8, 0, 1] });
    c3d.fixation.recordGazeSample(t + 0.02, HMD, { world: [8, 0, 1] });
}

test('a steady world gaze produces one fixation with the Unity payload shape', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);

    c3d.fixation.recordGazeSample(0.00, HMD, { world: [0, 0, 1] });
    c3d.fixation.recordGazeSample(0.03, HMD, { world: [0, 0, 1] });
    c3d.fixation.recordGazeSample(0.06, HMD, { world: [0, 0, 1] });
    c3d.fixation.recordGazeSample(0.12, HMD, { world: [0, 0, 1] });
    endFixation(c3d, 0.14);

    await c3d.fixation.sendData();

    expect(capture.suburl).toBe('fixations');
    expect(capture.payload.data.length).toBe(1);
    const f = capture.payload.data[0];
    expect(f.time).toBeCloseTo(0, 3);
    expect(f.duration).toBe(120);
    expect(f.p).toEqual([0, 0, 1]);
    expect(f.objectid).toBeUndefined();

    expect(f.maxradius).toBeCloseTo(Math.atan(1 * Math.PI / 180) * 1, 6);
});

test('scattered gaze produces no fixation', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);
    for (let i = 0; i < 10; i++) {
        c3d.fixation.recordGazeSample(i * 0.05, HMD, { world: [Math.cos(i) * 3, Math.sin(i) * 3, 2] });
    }
    const res = await c3d.fixation.sendData();
    expect(capture.called).toBe(false);
    expect(typeof res).toBe('string');
});

test('an object fixation emits objectid and p in OBJECT-LOCAL space', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);

    const onCube = {
        world: [0, 0, 4.7],
        local: [0, 0, -0.3],
        objectId: 'obj-1',
        objectPosition: [0, 0, 5],
        objectRotation: [0, 0, 0, 1],
    };
    c3d.fixation.recordGazeSample(0.00, HMD, onCube);
    c3d.fixation.recordGazeSample(0.05, HMD, onCube);
    c3d.fixation.recordGazeSample(0.10, HMD, onCube);
    endFixation(c3d, 0.15);

    await c3d.fixation.sendData();
    expect(capture.payload.data.length).toBe(1);
    const f = capture.payload.data[0];
    expect(f.objectid).toBe('obj-1');
    expect(f.p[0]).toBeCloseTo(0, 6);
    expect(f.p[1]).toBeCloseTo(0, 6);
    expect(f.p[2]).toBeCloseTo(-0.3, 6);
});

test('a steady gaze on a moving object stays a single fixation (smooth pursuit)', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);

    const onMovingCube = (t, x) => ({
        world: [x, 0, 4.7],
        local: [0, 0, -0.3],
        objectId: 'obj-1',
        objectPosition: [x, 0, 5],
        objectRotation: [0, 0, 0, 1],
    });
    c3d.fixation.recordGazeSample(0.00, HMD, onMovingCube(0.00, 0));
    c3d.fixation.recordGazeSample(0.05, HMD, onMovingCube(0.05, 0.33));
    c3d.fixation.recordGazeSample(0.10, HMD, onMovingCube(0.10, 0.66));
    c3d.fixation.recordGazeSample(0.15, HMD, onMovingCube(0.15, 1.0));
    endFixation(c3d, 0.20);

    await c3d.fixation.sendData();
    expect(capture.payload.data.length).toBe(1);
    const f = capture.payload.data[0];
    expect(f.objectid).toBe('obj-1');
    expect(f.duration).toBe(150);
});

test('a cluster shorter than the minimum duration never starts a fixation', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);
    c3d.fixation.recordGazeSample(0.00, HMD, { world: [0, 0, 1] });
    c3d.fixation.recordGazeSample(0.02, HMD, { world: [0, 0, 1] });
    c3d.fixation.finalize();
    await c3d.fixation.sendData();
    expect(capture.called).toBe(false);
});

test('an in-progress fixation is discarded at teardown, matching Unity', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);
    c3d.fixation.recordGazeSample(0.00, HMD, { world: [0, 0, 1] });
    c3d.fixation.recordGazeSample(0.05, HMD, { world: [0, 0, 1] });
    c3d.fixation.recordGazeSample(0.10, HMD, { world: [0, 0, 1] });
    c3d.fixation.finalize();
    await c3d.fixation.sendData();
    expect(capture.called).toBe(false);
});

test('GazeTracker.recordGaze splits the hit into world and object-local for the sink', () => {
    const c3d = makeActiveC3D();
    const calls = [];
    c3d.gaze.setFixationSink({
        recordGazeSample: (t, hmd, sample) => calls.push({ t, hmd, sample }),
    });
    c3d.gaze.recordGaze([1, 2, 3], [0, 0, 0, 1], {
        objectId: 'obj-9',
        point: [0, 0, 1],
        worldPoint: [0, 0, 5],
        objectPosition: [0, 0, 6],
        objectRotation: [0, 0, 0, 1],
    });
    expect(calls.length).toBe(1);
    expect(calls[0].hmd).toEqual([1, 2, 3]);
    expect(calls[0].sample.local).toEqual([0, 0, 1]);
    expect(calls[0].sample.world).toEqual([0, 0, 5]);
    expect(calls[0].sample.objectId).toBe('obj-9');
    expect(calls[0].sample.objectPosition).toEqual([0, 0, 6]);
});

test('a world hit with no objectId passes its point through as the world point', () => {
    const c3d = makeActiveC3D();
    const calls = [];
    c3d.gaze.setFixationSink({
        recordGazeSample: (t, hmd, sample) => calls.push(sample),
    });
    c3d.gaze.recordGaze([0, 0, 0], [0, 0, 0, 1], { point: [0, 0, 9] });
    expect(calls[0].world).toEqual([0, 0, 9]);
    expect(calls[0].local).toBeNull();
    expect(calls[0].objectId).toBeNull();
});