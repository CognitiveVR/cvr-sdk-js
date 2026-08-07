import Network from './network';
import { CognitiveVRAnalyticsCore } from './core';

interface FixationPayloadEntry {
    time: number;
    duration: number;
    maxradius: number;
    objectid?: string;
    p: number[];
}

interface FixationPayload {
    userid: string;
    timestamp: number;
    sessionid: string;
    part: number;
    data: FixationPayloadEntry[];
}

export interface FixationSample {
    world: number[] | null;
    local?: number[] | null;
    objectId?: string | null;
    objectPosition?: number[] | null;
    objectRotation?: number[] | null;
}

export interface GazeFixationSink {
    recordGazeSample: (_timeSec: number, _hmdPosition: number[], _sample: FixationSample) => void;
}

interface Vec3 { x: number; y: number; z: number; }
interface Quat { x: number; y: number; z: number; w: number; }

interface Capture {
    tMs: number;
    hmd: Vec3;
    world: Vec3;
    local: Vec3 | null;
    objectId: string | null;
    objPos: Vec3 | null;
    objRot: Quat | null;
}

interface ActiveFixation {
    isLocal: boolean;
    objectId: string | null;
    startMs: number;
    durationEndMs: number;
    lastInRangeMs: number;
    lastValidMs: number;
    lastOnTransformMs: number;
    sampleCount: number;
    centroid: Vec3;
    objPos: Vec3 | null;
    objRot: Quat | null;
    maxRadius: number;
}

const DEFAULT_MIN_FIXATION_MS = 60;
const DEFAULT_MAX_FIXATION_ANGLE = 1;
const DEFAULT_MAX_BLINK_MS = 400;
const DEFAULT_SACCADE_END_MS = 10;
const DEFAULT_MAX_OFF_DYNAMIC_MS = 500;
const DEFAULT_DYNAMIC_SIZE_MULTIPLIER = 1.25;
const DEFAULT_FOCUS_SIZE_MULTIPLIER = 2;
const DEFAULT_FIXATION_DATA_LIMIT = 256;

const MAX_PENDING_CAPTURES = 120;

const DEG2RAD = Math.PI / 180;

class FixationTracker implements GazeFixationSink {
    private core: CognitiveVRAnalyticsCore;
    private network: Network;
    private batchedFixations: FixationPayloadEntry[];
    private jsonPart: number;
    private active: ActiveFixation | null;
    private pending: Capture[];
    private wasOutOfDispersionLastSample: boolean;

    constructor(core: CognitiveVRAnalyticsCore) {
        this.core = core;
        this.network = new Network(core);
        this.batchedFixations = [];
        this.jsonPart = 1;
        this.active = null;
        this.pending = [];
        this.wasOutOfDispersionLastSample = false;
    }

    private cfg(key: string, fallback: number): number {
        const value = (this.core.config as { [k: string]: unknown })[key];
        return typeof value === 'number' ? value : fallback;
    }

    private coneAngle(isLocal: boolean): number {
        const base = this.cfg('fixationMaxAngle', DEFAULT_MAX_FIXATION_ANGLE)
            * this.cfg('fixationFocusSizeMultiplier', DEFAULT_FOCUS_SIZE_MULTIPLIER);
        return isLocal
            ? base * this.cfg('fixationDynamicSizeMultiplier', DEFAULT_DYNAMIC_SIZE_MULTIPLIER)
            : base;
    }

    recordGazeSample(timeSec: number, hmdPosition: number[], sample: FixationSample): void {
        const tMs = timeSec * 1000;
        const hmd: Vec3 = { x: hmdPosition[0], y: hmdPosition[1], z: hmdPosition[2] };

        if (!sample || !sample.world || sample.world.length < 3) {
            this.pending = [];
            if (this.active && tMs - this.active.lastValidMs > this.cfg('fixationMaxBlinkMs', DEFAULT_MAX_BLINK_MS)) {
                this.endActiveFixation();
            }
            return;
        }

        const objectId = sample.objectId || null;
        const capture: Capture = {
            tMs,
            hmd,
            world: toVec3(sample.world),
            local: sample.local && sample.local.length >= 3 ? toVec3(sample.local) : null,
            objectId,
            objPos: sample.objectPosition && sample.objectPosition.length >= 3 ? toVec3(sample.objectPosition) : null,
            objRot: sample.objectRotation && sample.objectRotation.length >= 4 ? toQuat(sample.objectRotation) : null,
        };

        if (this.active) {
            this.continueFixation(capture);
            return;
        }

        this.pending.push(capture);
        if (this.pending.length > MAX_PENDING_CAPTURES) {
            this.pending.shift();
        }
        this.tryBeginFixation();
    }

    private tryBeginFixation(): void {
        const minMs = this.cfg('fixationMinDurationMs', DEFAULT_MIN_FIXATION_MS);

        while (this.pending.length >= 2) {
            const span = this.pending[this.pending.length - 1].tMs - this.pending[0].tMs;
            if (span < minMs) {
                return;
            }
            if (this.beginLocal(this.pending) || this.beginWorld(this.pending)) {
                this.pending = [];
                return;
            }
            this.pending.shift();
        }
    }

    private beginLocal(window: Capture[]): boolean {
        for (const c of window) {
            if (!c.objectId || !c.local) {
                return false;
            }
        }

        const counts = new Map<string, number>();
        for (const c of window) {
            counts.set(c.objectId as string, (counts.get(c.objectId as string) || 0) + 1);
        }
        let mostUsed = window[0].objectId as string;
        let best = 0;
        counts.forEach((n, id) => { if (n > best) { best = n; mostUsed = id; } });

        const used = window.filter((c) => c.objectId === mostUsed);
        if (used.length < 2) {
            return false;
        }

        const centroid = meanOf(used.map((c) => c.local as Vec3));
        const first = used[0];
        const objPos = first.objPos;
        const objRot = first.objRot;
        const cone = this.coneAngle(true);

        for (const c of used) {
            const centreWorld = localToWorld(centroid, objPos, objRot, c.world);
            const sampleWorld = localToWorld(c.local as Vec3, objPos, objRot, c.world);
            if (angleBetweenFromOrigin(c.hmd, centreWorld, sampleWorld) > cone) {
                return false;
            }
        }

        const startWorld = localToWorld(centroid, objPos, objRot, first.world);
        this.active = {
            isLocal: true,
            objectId: mostUsed,
            startMs: first.tMs,
            durationEndMs: used[used.length - 1].tMs,
            lastInRangeMs: used[used.length - 1].tMs,
            lastValidMs: used[used.length - 1].tMs,
            lastOnTransformMs: used[used.length - 1].tMs,
            sampleCount: used.length,
            centroid,
            objPos,
            objRot,
            maxRadius: this.radiusAt(startWorld, first.hmd),
        };
        this.wasOutOfDispersionLastSample = false;
        return true;
    }

    private beginWorld(window: Capture[]): boolean {
        for (const c of window) {
            if (c.objectId) {
                return false;
            }
        }

        const centroid = meanOf(window.map((c) => c.world));
        const cone = this.coneAngle(false);
        for (const c of window) {
            if (angleBetweenFromOrigin(c.hmd, centroid, c.world) > cone) {
                return false;
            }
        }

        const first = window[0];
        const last = window[window.length - 1];
        this.active = {
            isLocal: false,
            objectId: null,
            startMs: first.tMs,
            durationEndMs: last.tMs,
            lastInRangeMs: last.tMs,
            lastValidMs: last.tMs,
            lastOnTransformMs: last.tMs,
            sampleCount: window.length,
            centroid,
            objPos: null,
            objRot: null,
            maxRadius: this.radiusAt(centroid, first.hmd),
        };
        this.wasOutOfDispersionLastSample = false;
        return true;
    }

    private continueFixation(c: Capture): void {
        const f = this.active as ActiveFixation;
        f.lastValidMs = c.tMs;

        const sameKind = f.isLocal
            ? (c.objectId === f.objectId && c.local !== null)
            : (c.objectId === null);

        const objPos = f.isLocal ? (c.objPos || f.objPos) : null;
        const objRot = f.isLocal ? (c.objRot || f.objRot) : null;
        const centreWorld = f.isLocal
            ? localToWorld(f.centroid, objPos, objRot, c.world)
            : f.centroid;
        const sampleWorld = (f.isLocal && sameKind && c.local)
            ? localToWorld(c.local, objPos, objRot, c.world)
            : c.world;

        const angle = angleBetweenFromOrigin(c.hmd, centreWorld, sampleWorld);
        const inRange = angle <= this.coneAngle(f.isLocal);

        if (inRange) {
            f.lastInRangeMs = c.tMs;
            this.wasOutOfDispersionLastSample = false;

            if (sameKind) {
                f.lastOnTransformMs = c.tMs;
                f.durationEndMs = c.tMs;
                f.sampleCount += 1;
                const point = f.isLocal ? (c.local as Vec3) : c.world;
                f.centroid.x += (point.x - f.centroid.x) / f.sampleCount;
                f.centroid.y += (point.y - f.centroid.y) / f.sampleCount;
                f.centroid.z += (point.z - f.centroid.z) / f.sampleCount;
                if (f.isLocal && c.objPos && c.objRot) {
                    f.objPos = c.objPos;
                    f.objRot = c.objRot;
                }
            }

            const r = this.radiusAt(centreWorld, c.hmd);
            if (r > f.maxRadius) {
                f.maxRadius = r;
            }
        } else {
            if (this.wasOutOfDispersionLastSample
                && c.tMs > f.lastInRangeMs + this.cfg('fixationSaccadeEndMs', DEFAULT_SACCADE_END_MS)) {
                this.endActiveFixation();
                this.pending = [c];
                return;
            }
            this.wasOutOfDispersionLastSample = true;
        }

        if (f.isLocal
            && c.tMs > f.lastOnTransformMs + this.cfg('fixationMaxOffDynamicMs', DEFAULT_MAX_OFF_DYNAMIC_MS)) {
            this.endActiveFixation();
            this.pending = [c];
        }
    }

    private radiusAt(fixationWorld: Vec3, hmd: Vec3): number {
        const distance = dist(fixationWorld, hmd);
        return Math.atan(this.cfg('fixationMaxAngle', DEFAULT_MAX_FIXATION_ANGLE) * DEG2RAD) * distance;
    }

    private endActiveFixation(): void {
        const f = this.active;
        this.active = null;
        this.wasOutOfDispersionLastSample = false;
        if (!f) {
            return;
        }
        const durationMs = f.durationEndMs - f.startMs;
        if (durationMs <= this.cfg('fixationMinDurationMs', DEFAULT_MIN_FIXATION_MS)) {
            return;
        }

        const entry: FixationPayloadEntry = {
            time: f.startMs / 1000,
            duration: Math.round(durationMs),
            maxradius: f.maxRadius,
            p: [f.centroid.x, f.centroid.y, f.centroid.z],
        };
        if (f.isLocal && f.objectId) {
            entry.objectid = f.objectId;
        }

        this.batchedFixations.push(entry);

        if (this.core.isSessionActive && this.batchedFixations.length > this.cfg('fixationDataLimit', DEFAULT_FIXATION_DATA_LIMIT)) {
            this.sendData().catch((err) => console.warn('C3D: FixationTracker auto-flush failed', err));
        }
    }

    sendData(): Promise<number | string> {
        return new Promise((resolve, reject) => {
            if (!this.core.isSessionActive) {
                resolve('FixationTracker.sendData: no session active');
                return;
            }
            if (this.batchedFixations.length === 0) {
                resolve('FixationTracker.sendData: no fixation data');
                return;
            }

            const payload: FixationPayload = {
                userid: this.core.userId,
                timestamp: Math.floor(this.core.getSessionTimestamp()),
                sessionid: this.core.getSessionId(),
                part: this.jsonPart,
                data: this.batchedFixations.slice(),
            };
            this.jsonPart++;
            this.batchedFixations = [];

            this.network.networkCall('fixations', payload)
                .then((res) => (res === 200 ? resolve(res) : reject(res)))
                .catch((err) => reject(err));
        });
    }

    finalize(): void {
        this.active = null;
        this.pending = [];
        this.wasOutOfDispersionLastSample = false;
    }

    endSession(): void {
        this.finalize();
        this.batchedFixations = [];
        this.jsonPart = 1;
    }
}

function localToWorld(local: Vec3, pos: Vec3 | null, rot: Quat | null, fallback: Vec3): Vec3 {
    if (!pos || !rot) {
        return fallback;
    }
    const r = rotateByQuat(local, rot);
    return { x: r.x + pos.x, y: r.y + pos.y, z: r.z + pos.z };
}

function rotateByQuat(v: Vec3, q: Quat): Vec3 {
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return {
        x: v.x + q.w * tx + (q.y * tz - q.z * ty),
        y: v.y + q.w * ty + (q.z * tx - q.x * tz),
        z: v.z + q.w * tz + (q.x * ty - q.y * tx),
    };
}

function meanOf(points: Vec3[]): Vec3 {
    const sum = { x: 0, y: 0, z: 0 };
    for (const p of points) {
        sum.x += p.x; sum.y += p.y; sum.z += p.z;
    }
    const n = points.length || 1;
    return { x: sum.x / n, y: sum.y / n, z: sum.z / n };
}

function toVec3(a: number[]): Vec3 {
    return { x: a[0], y: a[1], z: a[2] };
}

function toQuat(a: number[]): Quat {
    return { x: a[0], y: a[1], z: a[2], w: a[3] };
}

function angleBetweenFromOrigin(origin: Vec3, a: Vec3, b: Vec3): number {
    const da = normalize({ x: a.x - origin.x, y: a.y - origin.y, z: a.z - origin.z });
    const db = normalize({ x: b.x - origin.x, y: b.y - origin.y, z: b.z - origin.z });
    let d = da.x * db.x + da.y * db.y + da.z * db.z;
    if (d > 1) d = 1;
    if (d < -1) d = -1;
    return Math.acos(d) / DEG2RAD;
}

function normalize(v: Vec3): Vec3 {
    const m = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (m < 1e-9) {
        return { x: 0, y: 0, z: 1 };
    }
    return { x: v.x / m, y: v.y / m, z: v.z / m };
}

function dist(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export default FixationTracker;
