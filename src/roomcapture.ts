import Network from './network';
import { CognitiveVRAnalyticsCore } from './core';

interface XRPlaneLike {
    planeSpace: XRSpace;
    polygon: ReadonlyArray<{ x: number; y: number; z: number }>;
    orientation?: 'horizontal' | 'vertical';
    semanticLabel?: string;
    lastChangedTime?: number;
}

interface XRMeshLike {
    meshSpace: XRSpace;
    vertices: Float32Array;
    indices: Uint32Array | Uint16Array;
    semanticLabel?: string;
    lastChangedTime?: number;
}

interface RoomDataEntry {
    id: string;
    time: number;
    enabled: boolean;
    p?: number[];
    r?: number[];
    s?: number[];
}

interface AnchorManifestEntry {
    id: string;
    label: string;
    shape: 'plane' | 'volume';
}

interface RoomManifestEntry {
    id: string;
    label?: string;
    anchors: AnchorManifestEntry[];
}

interface BoundaryShape {
    time: number;
    points: number[][];
}

interface TrackingSnapshot {
    time: number;
    p: number[];
    r: number[];
}

interface BoundaryPayload {
    userid: string;
    timestamp: number;
    sessionid: string;
    part: number;
    data: TrackingSnapshot[];
    shapes: BoundaryShape[];
    roomManifest: RoomManifestEntry[];
    roomData: RoomDataEntry[];
}

interface Extents {
    size: [number, number, number];
    centre: [number, number, number];
}

interface TrackedAnchor {
    id: string;
    shape: 'plane' | 'volume';
    label: string;
    lastP: [number, number, number];
    lastR: [number, number, number, number];
    lastS: [number, number, number];
    lastEmitMs: number;
    seenThisFrame: boolean;
    srcChangedTime?: number;
    cachedExtents: Extents;
}

const normalizeLabel = (label: string | undefined): string => {
    if (!label) return 'unknown';
    return label
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[\s_,]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'unknown';
};

const POSITION_EPSILON = 0.02;
const SCALE_EPSILON = 0.02;
const MIN_UPDATE_INTERVAL_MS = 250;

const ROOM_ID = 'webxr-room';

class RoomCapture {
    private core: CognitiveVRAnalyticsCore;
    private network: Network;
    private tracked: Map<object, TrackedAnchor>;
    private pendingManifest: AnchorManifestEntry[];
    private roomData: RoomDataEntry[];
    private roomDeclared: boolean;
    private pendingRoomDeclaration: boolean;
    private jsonPart: number;
    private anchorCounter: number;
    private geometryUnsupported: boolean;
    private pendingShapes: BoundaryShape[];
    private pendingTracking: TrackingSnapshot[];

    constructor(core: CognitiveVRAnalyticsCore) {
        this.core = core;
        this.network = new Network(core);
        this.tracked = new Map();
        this.pendingManifest = [];
        this.roomData = [];
        this.roomDeclared = false;
        this.pendingRoomDeclaration = false;
        this.jsonPart = 1;
        this.anchorCounter = 0;
        this.geometryUnsupported = false;
        this.pendingShapes = [];
        this.pendingTracking = [];
    }

    recordBoundary(points: number[][], pose: { p: number[]; r: number[] }): void {
        if (!points || points.length === 0) {
            return;
        }
        const time = this.core.getTimestamp();
        this.pendingShapes.push({ time, points });
        this.pendingTracking.push({ time, p: pose.p, r: pose.r });
        this.sendData().catch((err) => console.warn('C3D: RoomCapture boundary flush failed', err));
    }

    processFrame(frame: XRFrame, referenceSpace: XRReferenceSpace | null): void {
        if (!frame || !referenceSpace || !this.core.isSessionActive || this.geometryUnsupported) {
            return;
        }

        const frameWithGeometry = frame as unknown as {
            detectedPlanes?: Set<XRPlaneLike>;
            detectedMeshes?: Set<XRMeshLike>;
        };

        let planes: Set<XRPlaneLike> | undefined;
        let meshes: Set<XRMeshLike> | undefined;
        try {
            planes = frameWithGeometry.detectedPlanes;
            meshes = frameWithGeometry.detectedMeshes;
        } catch (error) {
            this.geometryUnsupported = true;
            return;
        }

        if (!planes && !meshes) {
            return;
        }

        const nowMs = this.core.getTimestamp() * 1000;

        if (!this.roomDeclared) {
            this.roomDeclared = true;
            this.pendingRoomDeclaration = true;
            this.roomData.push({ id: ROOM_ID, time: this.core.getTimestamp(), enabled: true });
        }

        this.tracked.forEach((anchor) => { anchor.seenThisFrame = false; });

        if (planes) {
            planes.forEach((plane) => this.handleAnchor(plane, 'plane', frame, referenceSpace, nowMs));
        }
        if (meshes) {
            meshes.forEach((mesh) => this.handleAnchor(mesh, 'volume', frame, referenceSpace, nowMs));
        }

        const removed: object[] = [];
        this.tracked.forEach((anchor, key) => {
            if (!anchor.seenThisFrame) {
                this.roomData.push({
                    id: anchor.id,
                    time: this.core.getTimestamp(),
                    enabled: false,
                    p: anchor.lastP,
                    r: anchor.lastR,
                    s: anchor.lastS,
                });
                removed.push(key);
            }
        });
        removed.forEach((key) => this.tracked.delete(key));

        const limit = (this.core.config as { roomDataLimit?: number }).roomDataLimit || 64;
        if (this.roomData.length >= limit) {
            this.sendData().catch((err) => console.warn('C3D: RoomCapture auto-flush failed', err));
        }
    }

    private handleAnchor(
        source: XRPlaneLike | XRMeshLike,
        shape: 'plane' | 'volume',
        frame: XRFrame,
        referenceSpace: XRReferenceSpace,
        nowMs: number,
    ): void {
        const space = shape === 'plane' ? (source as XRPlaneLike).planeSpace : (source as XRMeshLike).meshSpace;

        const existing = this.tracked.get(source);
        if (existing) {
            existing.seenThisFrame = true;
        }

        const pose = frame.getPose(space, referenceSpace);
        if (!pose) {
            return;
        }

        const baseRotation = toC3DRotation(pose.transform.orientation);
        const rotation = shape === 'plane'
            ? multiplyQuaternions(baseRotation, PLANE_LOCAL_OFFSET)
            : baseRotation;
        const changedTime = source.lastChangedTime;
        let extents: Extents;
        if (existing && changedTime !== undefined && existing.srcChangedTime === changedTime) {
            extents = existing.cachedExtents;
        } else {
            extents = shape === 'plane'
                ? planeExtents((source as XRPlaneLike).polygon)
                : meshExtents((source as XRMeshLike).vertices);
            if (existing) {
                existing.srcChangedTime = changedTime;
                existing.cachedExtents = extents;
            }
        }
        const size = extents.size;

        const worldCentre = rotateVectorByQuat(extents.centre, pose.transform.orientation);
        const position = toC3DPosition({
            x: pose.transform.position.x + worldCentre[0],
            y: pose.transform.position.y + worldCentre[1],
            z: pose.transform.position.z + worldCentre[2],
        });

        const label = normalizeLabel(source.semanticLabel);

        if (!existing) {
            this.anchorCounter += 1;
            const id = `${shape === 'plane' ? 'plane' : 'mesh'}-${this.anchorCounter}`;
            this.tracked.set(source, {
                id,
                shape,
                label,
                lastP: position,
                lastR: rotation,
                lastS: size,
                lastEmitMs: nowMs,
                seenThisFrame: true,
                srcChangedTime: changedTime,
                cachedExtents: extents,
            });
            this.pendingManifest.push({ id, label, shape });
            this.roomData.push({
                id,
                time: this.core.getTimestamp(),
                enabled: true,
                p: position,
                r: rotation,
                s: size,
            });
            return;
        }

        const anchor = existing;

        const movedEnough = distance(anchor.lastP, position) >= POSITION_EPSILON
            || distance(anchor.lastS, size) >= SCALE_EPSILON;
        if (movedEnough && nowMs - anchor.lastEmitMs >= MIN_UPDATE_INTERVAL_MS) {
            anchor.lastP = position;
            anchor.lastR = rotation;
            anchor.lastS = size;
            anchor.lastEmitMs = nowMs;
            if (label !== anchor.label) {
                anchor.label = label;
            }
            this.roomData.push({
                id: anchor.id,
                time: this.core.getTimestamp(),
                enabled: true,
                p: position,
                r: rotation,
                s: size,
            });
        }
    }

    sendData(): Promise<number | string> {
        return new Promise((resolve, reject) => {
            if (!this.core.isSessionActive) {
                resolve('RoomCapture.sendData: no session active');
                return;
            }
            if (this.roomData.length === 0 && this.pendingManifest.length === 0
                && this.pendingShapes.length === 0 && this.pendingTracking.length === 0) {
                resolve('RoomCapture.sendData: no room data');
                return;
            }

            const manifest: RoomManifestEntry[] = [];
            if (this.pendingRoomDeclaration) {
                manifest.push({ id: ROOM_ID, label: ROOM_ID, anchors: [] });
            }
            if (this.pendingManifest.length > 0) {
                manifest.push({ id: ROOM_ID, anchors: this.pendingManifest.slice() });
            }

            const payload: BoundaryPayload = {
                userid: this.core.userId,
                timestamp: Math.floor(this.core.getSessionTimestamp()),
                sessionid: this.core.getSessionId(),
                part: this.jsonPart,
                data: this.pendingTracking.slice(),
                shapes: this.pendingShapes.slice(),
                roomManifest: manifest,
                roomData: this.roomData.slice(),
            };
            this.jsonPart++;

            this.roomData = [];
            this.pendingManifest = [];
            this.pendingRoomDeclaration = false;
            this.pendingShapes = [];
            this.pendingTracking = [];

            this.network.networkCall('boundary', payload)
                .then((res) => (res === 200 ? resolve(res) : reject(res)))
                .catch((err) => reject(err));
        });
    }

    endSession(): void {
        this.tracked.clear();
        this.pendingManifest = [];
        this.roomData = [];
        this.roomDeclared = false;
        this.pendingRoomDeclaration = false;
        this.jsonPart = 1;
        this.anchorCounter = 0;
        this.geometryUnsupported = false;
        this.pendingShapes = [];
        this.pendingTracking = [];
    }
}

function toC3DPosition(p: { x: number; y: number; z: number }): [number, number, number] {
    return [p.x, p.y, -p.z];
}

function toC3DRotation(q: { x: number; y: number; z: number; w: number }): [number, number, number, number] {
    return [q.x, q.y, -q.z, -q.w];
}

const PLANE_LOCAL_OFFSET: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

function multiplyQuaternions(
    a: [number, number, number, number],
    b: [number, number, number, number],
): [number, number, number, number] {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}

function planeExtents(polygon: ReadonlyArray<{ x: number; y: number; z: number }>): Extents {
    if (!polygon || polygon.length === 0) {
        return { size: [0, 0, 0], centre: [0, 0, 0] };
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const pt of polygon) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.z < minZ) minZ = pt.z;
        if (pt.z > maxZ) maxZ = pt.z;
    }
    return {
        size: [maxX - minX, maxZ - minZ, 0],
        centre: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2],
    };
}

function meshExtents(vertices: Float32Array): Extents {
    if (!vertices || vertices.length < 3) {
        return { size: [0, 0, 0], centre: [0, 0, 0] };
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i + 2 < vertices.length; i += 3) {
        const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
    return {
        size: [maxX - minX, maxY - minY, maxZ - minZ],
        centre: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    };
}

function rotateVectorByQuat(
    v: [number, number, number],
    q: { x: number; y: number; z: number; w: number },
): [number, number, number] {
    const tx = 2 * (q.y * v[2] - q.z * v[1]);
    const ty = 2 * (q.z * v[0] - q.x * v[2]);
    const tz = 2 * (q.x * v[1] - q.y * v[0]);
    return [
        v[0] + q.w * tx + (q.y * tz - q.z * ty),
        v[1] + q.w * ty + (q.z * tx - q.x * tz),
        v[2] + q.w * tz + (q.x * ty - q.y * tx),
    ];
}

function distance(a: [number, number, number], b: [number, number, number]): number {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export default RoomCapture;
