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

function makeFrame(planes, meshes) {
    return {
        detectedPlanes: planes,
        detectedMeshes: meshes,
        getPose: () => ({ transform: { position: { x: 0, y: 0, z: -2 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }),
    };
}

function makePlane(label = 'Wall Face') {
    return {
        planeSpace: {},
        polygon: [{ x: -1, y: 0, z: -0.5 }, { x: 1, y: 0, z: -0.5 }, { x: 1, y: 0, z: 0.5 }, { x: -1, y: 0, z: 0.5 }],
        orientation: 'horizontal',
        semanticLabel: label,
    };
}

function captureNetwork(c3d) {
    const capture = {};
    c3d.roomCapture.network = {
        networkCall: (suburl, payload) => { capture.suburl = suburl; capture.payload = payload; return Promise.resolve(200); },
    };
    return capture;
}

const anchorData = (payload) => payload.roomData.filter((d) => d.id !== 'webxr-room');
const anchorManifest = (payload) => payload.roomManifest.flatMap((r) => r.anchors);

test('a detected plane produces roomManifest + roomData with normalized label and converted pose', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);

    const plane = {
        planeSpace: {},
        polygon: [{ x: -1, y: 0, z: -0.5 }, { x: 1, y: 0, z: -0.5 }, { x: 1, y: 0, z: 0.5 }, { x: -1, y: 0, z: 0.5 }],
        orientation: 'horizontal',
        semanticLabel: 'Wall Face',
    };
    c3d.roomCapture.processFrame(makeFrame(new Set([plane]), undefined), {});

    await c3d.roomCapture.sendData();

    expect(capture.suburl).toBe('boundary');
    const p = capture.payload;
    expect(p.userid).toBeDefined();
    expect(p.sessionid).toBeDefined();
    const anchors = anchorManifest(p);
    expect(anchors.length).toBe(1);
    const anchor = anchors[0];
    expect(anchor.shape).toBe('plane');
    expect(anchor.label).toBe('wall-face');
    const entries = anchorData(p);
    expect(entries.length).toBe(1);
    const d = entries[0];
    expect(d.enabled).toBe(true);
    expect(d.p).toEqual([0, 0, 2]);
    expect(d.s).toEqual([2, 1, 0]);

    const rotate = (q, v) => {
        const [x, y, z, w] = q;
        const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
        return [
            v[0] + w * t[0] + (y * t[2] - z * t[1]),
            v[1] + w * t[1] + (z * t[0] - x * t[2]),
            v[2] + w * t[2] + (x * t[1] - y * t[0]),
        ];
    };
    const round = (v) => v.map((n) => { const r = Math.round(n * 1e6) / 1e6; return r === 0 ? 0 : r; });
    expect(round(rotate(d.r, [0, 1, 0]))).toEqual([0, 0, -1]);
    expect(round(rotate(d.r, [1, 0, 0]))).toEqual([1, 0, 0]);
    expect(round(rotate(d.r, [0, 0, 1]))).toEqual([0, 1, 0]);
});

test('a mesh is recorded as a volume anchor with 3D extents', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);

    const mesh = {
        meshSpace: {},
        vertices: new Float32Array([0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 4]),
        indices: new Uint32Array([0, 1, 2]),
        semanticLabel: 'couch',
    };
    c3d.roomCapture.processFrame(makeFrame(undefined, new Set([mesh])), {});
    await c3d.roomCapture.sendData();

    const anchor = anchorManifest(capture.payload)[0];
    expect(anchor.shape).toBe('volume');
    expect(anchor.label).toBe('couch');
    expect(anchorData(capture.payload)[0].s).toEqual([2, 3, 4]);
});

test('re-detecting an unchanged plane does not emit duplicate roomData', async () => {
    const c3d = makeActiveC3D();
    const plane = { planeSpace: {}, polygon: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }], semanticLabel: 'floor' };
    const frame = makeFrame(new Set([plane]), undefined);
    c3d.roomCapture.processFrame(frame, {});
    c3d.roomCapture.processFrame(frame, {});

    const capture = captureNetwork(c3d);
    await c3d.roomCapture.sendData();
    expect(anchorData(capture.payload).length).toBe(1);
});

test('a removed plane emits an enabled:false record', async () => {
    const c3d = makeActiveC3D();
    const plane = { planeSpace: {}, polygon: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }], semanticLabel: 'floor' };
    c3d.roomCapture.processFrame(makeFrame(new Set([plane]), undefined), {});
    c3d.roomCapture.processFrame(makeFrame(new Set([]), undefined), {});

    const capture = captureNetwork(c3d);
    await c3d.roomCapture.sendData();
    const removed = capture.payload.roomData.find((d) => d.enabled === false);
    expect(removed).toBeDefined();
});

test('no-op when the runtime exposes no plane/mesh detection', async () => {
    const c3d = makeActiveC3D();
    const frameWithoutGeometry = { getPose: () => ({ transform: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }) };
    expect(() => c3d.roomCapture.processFrame(frameWithoutGeometry, {})).not.toThrow();
    const res = await c3d.roomCapture.sendData();
    expect(typeof res).toBe('string');
});

test('a plane whose polygon is off-centre reports the geometry centre, not the origin', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);
    const plane = {
        planeSpace: {},
        polygon: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }],
        semanticLabel: 'table',
    };
    c3d.roomCapture.processFrame(makeFrame(new Set([plane]), undefined), {});
    await c3d.roomCapture.sendData();

    const d = anchorData(capture.payload)[0];
    expect(d.p[0]).toBeCloseTo(1, 6);
    expect(d.p[1]).toBeCloseTo(0, 6);
    expect(d.p[2]).toBeCloseTo(1.5, 6);
    expect(d.s).toEqual([2, 1, 0]);
});

test('a mesh whose vertices are off-centre reports the geometry centre', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);
    const mesh = {
        meshSpace: {},
        vertices: new Float32Array([0, 0, 0, 4, 2, 6]),
        indices: new Uint32Array([0, 1, 0]),
        semanticLabel: 'global mesh',
    };
    c3d.roomCapture.processFrame(makeFrame(undefined, new Set([mesh])), {});
    await c3d.roomCapture.sendData();

    const d = anchorData(capture.payload)[0];
    expect(d.p[0]).toBeCloseTo(2, 6);
    expect(d.p[1]).toBeCloseTo(1, 6);
    expect(d.p[2]).toBeCloseTo(-1, 6);
    expect(d.s).toEqual([4, 2, 6]);
});

test('a momentary null getPose does not remove or re-id an anchor', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);
    const plane = makePlane();
    const planes = new Set([plane]);

    let poseWorks = true;
    const frame = {
        detectedPlanes: planes,
        detectedMeshes: undefined,
        getPose: () => (poseWorks
            ? { transform: { position: { x: 0, y: 0, z: -2 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }
            : null),
    };

    c3d.roomCapture.processFrame(frame, {});
    poseWorks = false;
    c3d.roomCapture.processFrame(frame, {});
    c3d.roomCapture.processFrame(frame, {});
    poseWorks = true;
    c3d.roomCapture.processFrame(frame, {});

    await c3d.roomCapture.sendData();
    const anchorEntries = capture.payload.roomData.filter((d) => d.id !== 'webxr-room');
    expect(anchorEntries.some((d) => d.enabled === false)).toBe(false);
    expect(new Set(anchorEntries.map((d) => d.id)).size).toBe(1);
    const declared = capture.payload.roomManifest.flatMap((r) => r.anchors);
    expect(declared.length).toBe(1);
});

test('removal carries the last known transform, and the room is declared once', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);
    const plane = makePlane();

    c3d.roomCapture.processFrame(makeFrame(new Set([plane]), undefined), {});
    c3d.roomCapture.processFrame(makeFrame(new Set(), undefined), {});

    await c3d.roomCapture.sendData();
    const payload = capture.payload;

    const roomDecl = payload.roomManifest.find((r) => r.label !== undefined);
    expect(roomDecl).toMatchObject({ id: 'webxr-room', label: 'webxr-room', anchors: [] });
    const roomToggle = payload.roomData.find((d) => d.id === 'webxr-room');
    expect(roomToggle.enabled).toBe(true);
    expect(roomToggle.p).toBeUndefined();

    const partial = payload.roomManifest.find((r) => r.anchors.length > 0);
    expect(partial.label).toBeUndefined();

    const removal = payload.roomData.find((d) => d.enabled === false);
    expect(removal.p).toEqual([0, 0, 2]);
    expect(removal.s).toEqual([2, 1, 0]);
    expect(removal.r).toBeDefined();
});

test('mesh extents are not recomputed while lastChangedTime is unchanged', () => {
    const c3d = makeActiveC3D();
    let vertexReads = 0;
    const buffer = new Float32Array([0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 4]);
    const mesh = {
        meshSpace: {},
        get vertices() { vertexReads++; return buffer; },
        indices: new Uint32Array([0, 1, 2]),
        semanticLabel: 'couch',
        lastChangedTime: 10,
    };
    const meshes = new Set([mesh]);

    c3d.roomCapture.processFrame(makeFrame(undefined, meshes), {});
    expect(vertexReads).toBe(1);

    for (let i = 0; i < 5; i++) {
        c3d.roomCapture.processFrame(makeFrame(undefined, meshes), {});
    }
    expect(vertexReads).toBe(1);

    mesh.lastChangedTime = 11;
    c3d.roomCapture.processFrame(makeFrame(undefined, meshes), {});
    expect(vertexReads).toBe(2);
});

test('recordBoundary sends the play-area polygon in shapes with a placing pose', async () => {
    const c3d = makeActiveC3D();
    const capture = captureNetwork(c3d);
    const points = [[-1, 0, -1.5], [1, 0, -1.5], [1, 0, 1.5], [-1, 0, 1.5]];
    const pose = { p: [0.5, 0, -0.5], r: [0, 0, 0, 1] };

    c3d.roomCapture.recordBoundary(points, pose);

    const p = capture.payload;
    expect(capture.suburl).toBe('boundary');
    expect(p.shapes.length).toBe(1);
    expect(p.shapes[0].points).toEqual(points);
    expect(typeof p.shapes[0].time).toBe('number');
    expect(p.data.length).toBe(1);
    expect(p.data[0].p).toEqual([0.5, 0, -0.5]);
    expect(p.data[0].r).toEqual([0, 0, 0, 1]);
});

test('survives detectedPlanes/detectedMeshes accessors that throw, and latches', () => {
    const c3d = makeActiveC3D();
    let planeReads = 0;
    const throwingFrame = {
        get detectedPlanes() {
            planeReads++;
            throw new DOMException('plane-detection not enabled', 'NotSupportedError');
        },
        get detectedMeshes() {
            throw new DOMException('mesh-detection not enabled', 'NotSupportedError');
        },
        getPose: () => ({ transform: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }),
    };

    expect(() => c3d.roomCapture.processFrame(throwingFrame, {})).not.toThrow();
    expect(planeReads).toBe(1);

    for (let i = 0; i < 5; i++) {
        expect(() => c3d.roomCapture.processFrame(throwingFrame, {})).not.toThrow();
    }
    expect(planeReads).toBe(1);
});