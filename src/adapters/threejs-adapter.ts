import * as THREE from 'three';
import { GLTFExporter, GLTFExporterOptions } from 'three/examples/jsm/exporters/GLTFExporter.js';
// @ts-ignore
import JSZip from 'jszip';
import type C3D from '../index';
import type { GazeHitData } from '../utils/webxr'; 

interface FPSState {
    frameCount: number;
    timeAccumulator: number;
    lastTime: number;
    frameTimes: number[];
}

interface DynamicObjectOptions {
    positionThreshold?: number;
    rotationThreshold?: number;
    scaleThreshold?: number;
    useLocalScale?: boolean;
}

// Helper interface for extended WebXRManager
interface ExtendedWebXRManager extends THREE.WebXRManager {
    getScene?: () => THREE.Scene;
}

class C3DThreeAdapter {
    private c3d: C3D;
    private _fpsState: FPSState = {
        frameCount: 0,
        timeAccumulator: 0,
        lastTime: performance.now(),
        frameTimes: []
    };
    // Used to avoid TS errors in environments without FileSystem API types
    private exportDirHandle: any = null; 
    private _interactableObjects: THREE.Object3D[] = [];  
    private _trackedRootByInteractable = new Map<string, THREE.Object3D>();

    // Properties for engine-camera driven gaze tracking
    private _camera: THREE.Camera | null = null;
    private _lastGazeTime: number = 0;
    private _defaultGazeRaycaster: (() => GazeHitData | null) | null = null;

    // Optional analytics origin. When set, all camera and dynamic-object poses
    // are recorded relative to this object's world transform instead of raw
    // world coordinates. Used by Mattercraft WebAR so the scene root translation
    // (and any other ancestor transforms outside the Zappar anchor frame) do
    // not contaminate the recorded gaze/object positions.
    private _analyticsOrigin: THREE.Object3D | null = null;

    // Object Pooling for GC optimization
    private _tempVec = new THREE.Vector3();
    private _tempQuat = new THREE.Quaternion();
    private _tempScale = new THREE.Vector3();
    private _tempForward = new THREE.Vector3(0, 0, -1); // Forward vector
    private _gazeRaycaster = new THREE.Raycaster();
    private _gazeOriginNDC = new THREE.Vector2(0, 0);

    // Temps used only by the analytics-origin transform path. Kept separate
    // from the gaze/object temps so concurrent reads in the same frame don't
    // clobber each other.
    private _originPosTemp = new THREE.Vector3();
    private _originQuatTemp = new THREE.Quaternion();
    private _originScaleTemp = new THREE.Vector3();
    private _originInverseQuatTemp = new THREE.Quaternion();

    // Synthetic-gaze fallback temps. On no-hit frames we emit a world-space
    // point a fixed distance ahead of the camera so the dashboard's beam
    // always has an endpoint anchored to the current head pose, instead of
    // sticking to the last real hit's pose while the head icon keeps moving.
    private _fallbackEndpointTemp = new THREE.Vector3();
    private _fallbackForwardTemp = new THREE.Vector3();
    private _fallbackQuatTemp = new THREE.Quaternion();
    // Distance in meters from camera to the synthetic gaze endpoint after the
    // last-hit grace window elapses. Tuned for AR-scale scenes (typical user
    // viewing distance is ~1 m).
    private static readonly FALLBACK_GAZE_DISTANCE = 2;

    // Last-hit cache. During a heavy jitter or fast camera motion the
    // raycaster can produce isolated misses while the user is still
    // effectively aiming at the same object — without this cache the beam
    // endpoint would flick out to the forward-synthetic point and snap back
    // on the very next frame. Re-anchoring to the last real hit's world
    // position for a short grace window keeps the beam visually stable
    // through those misses.
    private _hasLastHit = false;
    private _lastHitWorldPoint = new THREE.Vector3();
    private _lastHitTimestamp = 0;
    // Grace window after a real hit during which transient misses reuse the
    // cached world point. ~12 frames at 60 Hz — long enough to span typical
    // tracking-noise miss bursts, short enough that genuinely looking away
    // transitions to forward-synthetic without a perceptible lag.
    private static readonly LAST_HIT_GRACE_MS = 200;

    // Helper to log object hierarchy recursively for during object export debugging 
    private _logHierarchy(obj: THREE.Object3D, depth = 0): void {
        const indent = "  ".repeat(depth);
        const info = `Type: ${obj.type}, Name: "${obj.name}"`;
        console.log(`${indent}- ${info}`);
        if (obj.children) {
            obj.children.forEach(child => this._logHierarchy(child, depth + 1));
        }
    }

    constructor(c3dInstance: C3D) {
        if (!c3dInstance) {
            throw new Error("A C3D instance must be provided to the Three.js adapter.");
        }
        this.c3d = c3dInstance;

        this.c3d.setDeviceProperty('AppEngine', 'Three.js');
        this.c3d.setDeviceProperty('AppEngineVersion', THREE.REVISION);
    }

    private fromVector3(vec3: THREE.Vector3): number[] {
        return [vec3.x, vec3.y, vec3.z];
    }

    private fromQuaternion(quat: THREE.Quaternion): number[] {
        return [quat.x, quat.y, quat.z, quat.w];
    }

    private _toAnalyticsDirection(direction: THREE.Vector3): number[] {
        return [direction.x, direction.y, -direction.z];
    }

    private _getAnalyticsForwardDirection(camera: THREE.Camera): number[] {
        camera.updateWorldMatrix(true, false);
        this._tempForward.set(0, 0, -1).transformDirection(camera.matrixWorld);
        return this._toAnalyticsDirection(this._tempForward);
    }

    private _getEngineGazeIntervalMs(): number {
        const configuredInterval = this.c3d.core.config.GazeInterval;
        const configuredIntervalMs = typeof configuredInterval === 'number' && configuredInterval > 0
            ? configuredInterval * 1000
            : 100;

        // Cap at 60 Hz only for WebAR (analytics origin set). Handheld AR at
        // 30 Hz shows visible stair-stepping in lateral motion replay because
        // the 60 Hz display has no fresh sample every other frame. WebXR/VR
        // sessions can be long and don't need the extra sample density.
        if (this._analyticsOrigin) {
            return Math.min(configuredIntervalMs, 1000 / 60);
        }
        return configuredIntervalMs;
    }

    private _getCenterRayHit(camera: THREE.Camera): GazeHitData | null {
        camera.updateWorldMatrix(true, false);
        this._gazeRaycaster.setFromCamera(this._gazeOriginNDC, camera);
        if (this._interactableObjects.length === 0) {
            return null;
        }

        const intersects = this._gazeRaycaster.intersectObjects(this._interactableObjects, true);
        if (intersects.length === 0) {
            return null;
        }

        const intersection = intersects[0];
        const trackedRoot = this._resolveTrackedRoot(intersection.object);
        if (!trackedRoot || !trackedRoot.userData?.c3dId) {
            return null;
        }

        // Cache the world-space hit point for the synthetic-gaze fallback so
        // that transient raycast misses during heavy jitter keep the beam
        // endpoint pinned to the same world location instead of snapping out
        // to a forward-synthetic point.
        this._lastHitWorldPoint.copy(intersection.point);
        this._lastHitTimestamp = performance.now();
        this._hasLastHit = true;

        const worldPoint = intersection.point.clone();
        trackedRoot.worldToLocal(worldPoint);
        worldPoint.z *= -1;

        return {
            objectId: trackedRoot.userData.c3dId,
            point: [worldPoint.x, worldPoint.y, worldPoint.z]
        };
    }

    private _resolveTrackedRoot(hitObject: THREE.Object3D | null): THREE.Object3D | null {
        let current: THREE.Object3D | null = hitObject;

        while (current) {
            if (current.userData?.c3dTrackedRoot instanceof THREE.Object3D) {
                return current.userData.c3dTrackedRoot;
            }

            const mappedRoot = this._trackedRootByInteractable.get(current.uuid);
            if (mappedRoot) {
                return mappedRoot;
            }

            if (current.userData?.c3dId) {
                return current;
            }

            current = current.parent;
        }

        return null;
    }

    public recordGazeFromCamera(camera: THREE.Camera): void {
        const worldPos = this._tempVec;
        const worldQuat = this._tempQuat;
        camera.getWorldPosition(worldPos);
        camera.getWorldQuaternion(worldQuat);

        this._applyAnalyticsOriginTransform(worldPos, worldQuat);

        // Apply C3D Coordinate Corrections
        const correctedPosition = [worldPos.x, worldPos.y, -worldPos.z];
        const correctedOrientation = [worldQuat.x, worldQuat.y, -worldQuat.z, -worldQuat.w];

        // Calculate gaze vector natively using pooled forward vector
        const correctedGaze = this._getAnalyticsForwardDirection(camera);

        this.c3d.gaze.recordGaze(correctedPosition, correctedOrientation, correctedGaze);
    }

    /**
     * Set the analytics origin. When non-null, camera and dynamic-object poses
     * are recorded in this origin's local frame instead of world space. Pass
     * null to clear and revert to raw world-space recording.
     *
     * In Mattercraft WebAR the natural origin is the scene's top-level Group
     * (or the active Zappar anchor), so the scene-root translation does not
     * appear as a constant offset in the recorded camera path.
     */
    public setAnalyticsOrigin(origin: THREE.Object3D | null): void {
        this._analyticsOrigin = origin;
    }

    public getAnalyticsOrigin(): THREE.Object3D | null {
        return this._analyticsOrigin;
    }

    /**
     * Transform a world-space pose into the analytics origin's local frame in-place.
     * Mutates the supplied position and quaternion. No-op when no origin is set.
     * Scale is intentionally ignored (assumes the origin has identity scale,
     * which is the common case for scene roots).
     */
    private _applyAnalyticsOriginTransform(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
        if (!this._analyticsOrigin) return;

        this._analyticsOrigin.updateWorldMatrix(true, false);
        this._analyticsOrigin.matrixWorld.decompose(
            this._originPosTemp,
            this._originQuatTemp,
            this._originScaleTemp
        );

        this._originInverseQuatTemp.copy(this._originQuatTemp).invert();

        // Translate then rotate into origin-local space
        position.sub(this._originPosTemp).applyQuaternion(this._originInverseQuatTemp);
        quaternion.premultiply(this._originInverseQuatTemp);
    }

    /**
     * Public version of the analytics-origin transform helper. Lets the
     * Mattercraft integration record one-shot snapshots (e.g. dynamic object
     * initial registration) using the same coordinate frame as the per-frame
     * pose stream.
     */
    public transformWorldToAnalyticsOrigin(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
        this._applyAnalyticsOriginTransform(position, quaternion);
    }
    
    //  Helper function for recursively finding dynamic interactable objects in a three.scene or three.group
    private _scanForInteractables(root: THREE.Object3D): void {
        root.traverse((child) => {
            
            if (child.userData && child.userData.c3dId) {
                this._interactableObjects.push(child);
                
                if (child.userData.isDynamic) {
                     const options: DynamicObjectOptions = {
                        positionThreshold: child.userData.positionThreshold,
                        rotationThreshold: child.userData.rotationThreshold,
                        scaleThreshold: child.userData.scaleThreshold
                    };
                    this.trackDynamicObject(child, child.userData.c3dId, options);
                    console.log(`Cognitive3D: Automatically started tracking dynamic object: ${child.name}`);
                }
            }
        });
    }

    /**
     * Initializes the tracking systems (Gaze, Dynamic Objects, FPS).
     * You MUST call c3dAdapter.update() in your own render loop.
     */
    public startTracking(
        renderer: THREE.WebGLRenderer, 
        camera: THREE.Camera, 
        // Accept a Scene, a specific Group, or a manual list of objects
        trackableTarget: THREE.Object3D | THREE.Object3D[] | null = null
    ): void {
        if (!renderer || !camera) {
            console.error("Cognitive3D: renderer and camera must be provided to startTracking.");
            return;
        }

        if (this.c3d.fpsTracker) {
            this.c3d.adapterManagesFPS = true;
            this.c3d.fpsTracker.stop();
            console.log("Cognitive3D: Stopped default FPS tracker in favor of XR-synced tracking.");
        }

        this._camera = camera; 
        this._gazeRaycaster.far = 1000;

        // Setup Dynamic Objects & Gaze, Clear previous list
        this._interactableObjects = [];
        this._trackedRootByInteractable.clear();
        if (this.c3d.gazeRaycaster === this._defaultGazeRaycaster) {
            this.c3d.gazeRaycaster = null;
        }
        this._defaultGazeRaycaster = null;

        // Drop any cached hit state from a prior session so the fallback path
        // never re-anchors a fresh session's beam to a stale world point.
        this._hasLastHit = false;
        this._lastHitTimestamp = 0;

        if (trackableTarget) {
            if (Array.isArray(trackableTarget)) {
                // User manually provided a list of objects
                this._interactableObjects = trackableTarget;
            } else {
                // User provided the Scene or a Group -> Scan it
                this._scanForInteractables(trackableTarget);
            }

            console.log(`Cognitive3D: Tracking ${this._interactableObjects.length} objects.`);
            
            this._setupGazeRaycasting(camera);
            console.log('Cognitive3D: Gaze raycasting enabled.');
        }

        this._initFPSState();

        console.log('Cognitive3D: Adapter initialized. Please ensure you call c3dAdapter.update() within your render loop.');
    }

    /**
     * MUST be called once per frame in your developer render loop.
     */
    public update(timestamp?: number, frame?: XRFrame): void {
        if (!this.c3d.core.isSessionActive) return;

        this._updateFPS();
        this.updateTrackedObjectTransforms();

        // Read directly from the instantiated core config
        if (this.c3d.core.config.gazeTrackingSource === 'engine') {
            this._recordEngineGaze();
        }
    }

    private _initFPSState(): void {
        this._fpsState = {
            frameCount: 0,
            timeAccumulator: 0,
            lastTime: performance.now(),
            frameTimes: []
        };
    }

    private _updateFPS(): void {
        const now = performance.now();
        let delta = (now - this._fpsState.lastTime) / 1000; // delta in seconds

        if (delta > 1.0) delta = 0;

        this._fpsState.lastTime = now;
        this._fpsState.timeAccumulator += delta;
        this._fpsState.frameCount++;
        this._fpsState.frameTimes.push(delta);

        if (this._fpsState.timeAccumulator >= 1.0) {
            this._sendFPSData();

            this._fpsState.frameCount = 0;
            this._fpsState.timeAccumulator = 0;
            this._fpsState.frameTimes = [];
        }
    }

    private _sendFPSData(): void {
        const { frameCount, timeAccumulator, frameTimes } = this._fpsState;

        // A. Average FPS
        const avgFps = frameCount / timeAccumulator;
        this.c3d.sensor.recordSensor('c3d.fps.avg', avgFps);

        // B. 1% Low FPS
        frameTimes.sort((a, b) => b - a);

        const onePercentCount = Math.ceil(frameTimes.length * 0.01);
        const slowestFrames = frameTimes.slice(0, onePercentCount);

        if (slowestFrames.length > 0) {
            const totalSlowestTime = slowestFrames.reduce((sum, t) => sum + t, 0);
            const avgSlowestTime = totalSlowestTime / slowestFrames.length;

            const fps1pl = avgSlowestTime > 0 ? (1 / avgSlowestTime) : avgFps;

            this.c3d.sensor.recordSensor('c3d.fps.1pl', fps1pl);
        }
    }

    private _setupGazeRaycasting(camera: THREE.Camera): void {
        this._defaultGazeRaycaster = (): GazeHitData | null => this._getCenterRayHit(camera);
        this.c3d.gazeRaycaster = this._defaultGazeRaycaster;
    }

    // Handle Gaze tracking natively through Three.js camera
    private _recordEngineGaze(): void {
        if (!this._camera) return;

        const now = performance.now();
        const intervalMs = this._getEngineGazeIntervalMs();

        if (now - this._lastGazeTime < intervalMs) {
            return;
        }
        this._lastGazeTime = now;

        // 1. Resolve a possible real hit BEFORE the in-place origin transform,
        //    so the raycaster still sees world-space camera/object transforms.
        let gazePayload: GazeHitData | null = null;
        if (this.c3d.gazeRaycaster) {
            const hitPayload = this.c3d.gazeRaycaster === this._defaultGazeRaycaster
                ? this._getCenterRayHit(this._camera)
                : this.c3d.gazeRaycaster();
            if (hitPayload) {
                gazePayload = hitPayload;
            }
        }

        // 2. On no-hit frames in WebAR (analytics origin set), synthesize a
        //    world-space endpoint in front of the camera so every sample
        //    carries a `g` payload — without it the dashboard's beam re-anchors
        //    only on hit samples and visibly lags behind the head icon between
        //    hits during handheld motion. WebXR/VR sessions don't exhibit the
        //    same beam-lag pattern, so we preserve the original null-on-miss
        //    behaviour there. `now` is forwarded so the grace-window check uses
        //    the same timestamp as the throttle gate.
        if (!gazePayload && this._analyticsOrigin) {
            const fallbackPoint = this._computeFallbackGazePoint(this._camera, now);
            gazePayload = { objectId: "", point: fallbackPoint };
        }

        // 3. Capture the head pose and re-express in analytics-origin frame.
        const worldPos = this._tempVec;
        const worldQuat = this._tempQuat;
        this._camera.getWorldPosition(worldPos);
        this._camera.getWorldQuaternion(worldQuat);
        this._applyAnalyticsOriginTransform(worldPos, worldQuat);

        const correctedPosition = [worldPos.x, worldPos.y, -worldPos.z];
        const correctedOrientation = [worldQuat.x, worldQuat.y, -worldQuat.z, -worldQuat.w];

        this.c3d.gaze.recordGaze(correctedPosition, correctedOrientation, gazePayload);
    }

    /**
     * Build a world-space point to send as the fallback gaze endpoint for the
     * dashboard, expressed in the analytics origin's frame with the standard
     * C3D Z-flip applied.
     *
     * Two modes:
     *   1. Recent real hit (within LAST_HIT_GRACE_MS) — re-use the cached
     *      world hit point. Keeps the beam parked on the same world location
     *      during transient raycast misses caused by tracking jitter.
     *   2. No recent hit — synthesize a forward-looking point at
     *      FALLBACK_GAZE_DISTANCE m in the camera's forward direction.
     *
     * The returned array has no `objectId` partner — it is intended to be sent
     * as `{ objectId: "", point }`, which the SDK serializes as a `g` payload
     * with no `o`, i.e. a world-space gaze endpoint. The dashboard treats
     * world-space `g` as the beam's far endpoint, which keeps the beam base
     * locked to the current head pose between actual object hits.
     *
     * `now` is supplied by the caller so the grace-window evaluation uses the
     * same clock reading as the throttle gate — this also keeps the function
     * free of side effects against performance.now(), which keeps the test
     * timestamp mock deterministic.
     */
    private _computeFallbackGazePoint(camera: THREE.Camera, now: number): number[] {
        const withinHitGrace = this._hasLastHit
            && (now - this._lastHitTimestamp) <= C3DThreeAdapter.LAST_HIT_GRACE_MS;

        if (withinHitGrace) {
            this._fallbackEndpointTemp.copy(this._lastHitWorldPoint);
        } else {
            camera.getWorldPosition(this._fallbackEndpointTemp);
            this._fallbackForwardTemp.set(0, 0, -1).transformDirection(camera.matrixWorld);
            this._fallbackEndpointTemp.addScaledVector(
                this._fallbackForwardTemp,
                C3DThreeAdapter.FALLBACK_GAZE_DISTANCE
            );
        }

        // Same origin transform as the head pose so beam endpoint and beam
        // base live in the same coordinate frame in replay.
        this._fallbackQuatTemp.set(0, 0, 0, 1);
        this._applyAnalyticsOriginTransform(this._fallbackEndpointTemp, this._fallbackQuatTemp);

        return [this._fallbackEndpointTemp.x, this._fallbackEndpointTemp.y, -this._fallbackEndpointTemp.z];
    }

    public trackDynamicObject(object: THREE.Object3D, id: string, options: DynamicObjectOptions): void {
        this.c3d.dynamicObject.trackObject(id, object, options);

        const tracked = this.c3d.dynamicObject.trackedObjects.get(id);
        if (tracked) {
            tracked.lastPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
            tracked.lastRotation = new THREE.Quaternion(Infinity, Infinity, Infinity, Infinity);
            tracked.lastScale = new THREE.Vector3(Infinity, Infinity, Infinity);
        }
    }

    public updateTrackedObjectTransforms(): void {
        const dynamicObjectManager = this.c3d.dynamicObject;

        dynamicObjectManager.trackedObjects.forEach((tracked, id) => {
            if (!tracked.lastPosition) return;

            const { object, lastPosition, lastRotation, lastScale, positionThreshold, rotationThreshold, scaleThreshold, useLocalScale } = tracked;
            const threeObject = object as THREE.Object3D;
            const threeLastPos = lastPosition as THREE.Vector3;
            const threeLastRot = lastRotation as THREE.Quaternion;
            const threeLastScale = lastScale as THREE.Vector3;

            threeObject.updateWorldMatrix(true, false);
            threeObject.matrixWorld.decompose(this._tempVec, this._tempQuat, this._tempScale);

            // Re-express the tracked object's pose in the analytics origin's
            // local frame so dynamic object positions stay consistent with the
            // camera pose stream and the exported scene root.
            this._applyAnalyticsOriginTransform(this._tempVec, this._tempQuat);

            if (useLocalScale) {
                this._tempScale.copy(threeObject.scale);
            }

            const positionChanged = this._tempVec.distanceTo(threeLastPos) > (positionThreshold || 0.01);
            const rotationChanged = this._tempQuat.angleTo(threeLastRot) * (180 / Math.PI) > (rotationThreshold || 1);
            const scaleChanged = this._tempScale.distanceTo(threeLastScale) > (scaleThreshold || 0.01);

            if (positionChanged || rotationChanged || scaleChanged) {
                // OPTIMIZATION: Manually construct arrays to avoid .clone() and .toArray() allocations
                const posArray = [this._tempVec.x, this._tempVec.y, this._tempVec.z * -1];
                const quatArray = [this._tempQuat.x, this._tempQuat.y, this._tempQuat.z * -1, this._tempQuat.w * -1];
                const scaleArray = [this._tempScale.x, this._tempScale.y, this._tempScale.z];

                dynamicObjectManager.addSnapshot(id, posArray, quatArray, scaleArray);

                threeLastPos.copy(this._tempVec);
                threeLastRot.copy(this._tempQuat);
                threeLastScale.copy(this._tempScale);
            }
        });
    }

    public addInteractable(object: THREE.Object3D, trackedRoot: THREE.Object3D = object): void {
        if (!this._interactableObjects.includes(object)) {
            this._interactableObjects.push(object);
        }

        this._trackedRootByInteractable.set(object.uuid, trackedRoot);
        object.userData.c3dTrackedRoot = trackedRoot;
    }

    async _ensureExportDir(): Promise<any> {
        if (this.exportDirHandle) return this.exportDirHandle;
        // @ts-ignore
        if (!window.showDirectoryPicker) return null;
        try {
            // @ts-ignore
            const root = await window.showDirectoryPicker();
            const sceneDir = await root.getDirectoryHandle("scene", { create: true });
            const perm = await sceneDir.requestPermission?.({ mode: "readwrite" });
            if (perm && perm !== "granted") throw new Error("Write permission denied");
            this.exportDirHandle = sceneDir;
            return sceneDir;
        } catch (err) {
            console.error("Error getting directory handle:", err);
            return null;
        }
    }

    async _writeFile(dirHandle: any, filename: string, blob: Blob): Promise<void> {
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
    }

    _downloadBlob(blob: Blob, filename: string): void {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 800);
    }

    private _getExportFileStem(name: string): string {
        return name.replace(/\.(glb|gltf|fbx|obj|usdz)$/i, '');
    }

    public exportScene(scene: THREE.Scene, sceneName: string, renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
        const exporter = new GLTFExporter();
        const staticScene = scene.clone(true);
        const exportDirPromise = this._ensureExportDir();

        staticScene.traverse((obj) => {
            if (obj.userData && (obj.userData.c3dId || obj.userData.isDynamic)) {
                if (obj.parent) {
                    obj.parent.remove(obj);
                }
            }
        });

        const exportRoot = new THREE.Group();
        exportRoot.name = "CoordinateSystemFix";
        exportRoot.add(staticScene);
        exportRoot.scale.z = -1;
        exportRoot.scale.x = -1;

        exporter.parse(
            exportRoot,
            async (gltfInput: any) => {
                const gltf = gltfInput;
                const dir = await exportDirPromise;

                const prefix = "data:application/octet-stream;base64,";
                const uri = gltf.buffers?.[0]?.uri || "";
                let binBlob: Blob | null = null;
                if (uri.startsWith(prefix)) {
                    const b64 = uri.slice(prefix.length);
                    const raw = atob(b64);
                    const bytes = new Uint8Array(raw.length);
                    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                    binBlob = new Blob([bytes.buffer], { type: "application/octet-stream" });
                    if (gltf.buffers && gltf.buffers[0]) {
                        gltf.buffers[0].uri = "scene.bin";
                    }
                }

                const gltfBlob = new Blob([JSON.stringify(gltf, null, 2)], { type: "model/gltf+json" });
                const settings = {
                    scale: 1,
                    sceneName: sceneName,
                    sdkVersion: typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : 'dev'
                };
                const settingsBlob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
                const screenshotDataUrl = renderer.domElement.toDataURL('image/png');
                const screenshotBlob = await (await fetch(screenshotDataUrl)).blob();

                if (dir) {
                    if (binBlob) await this._writeFile(dir, "scene.bin", binBlob);
                    await this._writeFile(dir, "scene.gltf", gltfBlob);
                    await this._writeFile(dir, "settings.json", settingsBlob);
                    await this._writeFile(dir, "screenshot.png", screenshotBlob);
                    console.log("Exported static scene files to the 'scene' directory.");
                } else {
                    console.warn("File System Access API not available; falling back to zip download.");
                    const zip = new JSZip();
                    if (binBlob) zip.file("scene.bin", binBlob);
                    zip.file("scene.gltf", gltfBlob);
                    zip.file("settings.json", settingsBlob);
                    zip.file("screenshot.png", screenshotBlob);

                    const zipBlob = await zip.generateAsync({ type: "blob" });
                    this._downloadBlob(zipBlob, "scene-export.zip");
                }
            },
            (err) => {
                console.error("GLTF export failed:", err);
            },
            { binary: false, embedImages: true, onlyVisible: true, truncateDrawRange: true, maxTextureSize: 4096 } as GLTFExporterOptions
        );
    }

    public async exportObject(objectToExport: THREE.Object3D, objectName: string, renderer: THREE.WebGLRenderer, camera: THREE.Camera): Promise<void> {
        const exportDirPromise = this._ensureExportDir();
        const exportFileStem = this._getExportFileStem(objectName);
        const xrManager = renderer.xr as ExtendedWebXRManager;
        const originalScene = xrManager.isPresenting ? xrManager.getScene?.() : camera.parent; 
        const tempScene = new THREE.Scene();
        tempScene.background = new THREE.Color(0xe0e0e0);
        const tempLight = new THREE.AmbientLight(0xffffff, 3.0);
        tempScene.add(tempLight);

        const objectClone = objectToExport.clone();
        const box = new THREE.Box3().setFromObject(objectClone);
        const center = box.getCenter(new THREE.Vector3());
        objectClone.position.sub(center); 
        tempScene.add(objectClone);

        renderer.render(tempScene, camera);
        const screenshotDataUrl = renderer.domElement.toDataURL('image/png');
        const screenshotBlob = await (await fetch(screenshotDataUrl)).blob();

        if (originalScene) {
            renderer.render(originalScene, camera);
        }

        const exporter = new GLTFExporter();
        
        const gltfClone = objectToExport.clone();

        console.log(`[Cognitive3D] Structure being exported for "${objectName}":`);
        this._logHierarchy(gltfClone);

        exporter.parse(
            gltfClone,
            async (gltfInput: any) => { 
                const gltf = gltfInput;
                const dir = await exportDirPromise;
                const prefix = "data:application/octet-stream;base64,";
                const uri = gltf.buffers?.[0]?.uri || "";
                let binBlob: Blob | null = null;

                if (uri.startsWith(prefix)) {
                    const b64 = uri.slice(prefix.length);
                    const raw = atob(b64);
                    const bytes = new Uint8Array(raw.length);
                    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                    binBlob = new Blob([bytes.buffer], { type: "application/octet-stream" });
                    if (gltf.buffers && gltf.buffers[0]) {
                        gltf.buffers[0].uri = `${exportFileStem}.bin`;
                    }
                }

                const gltfBlob = new Blob([JSON.stringify(gltf, null, 2)], { type: "model/gltf+json" });

                if (dir) {
                    if (binBlob) await this._writeFile(dir, `${exportFileStem}.bin`, binBlob);
                    await this._writeFile(dir, `${exportFileStem}.gltf`, gltfBlob);
                    await this._writeFile(dir, "cvr_object_thumbnail.png", screenshotBlob);
                    console.log(`Exported object files for '${objectName}' as '${exportFileStem}.*' to the 'scene' directory.`);
                } else {
                    console.warn("File System Access API not available; falling back to zip download.");
                    const zip = new JSZip();
                    if (binBlob) zip.file(`${exportFileStem}.bin`, binBlob);
                    zip.file(`${exportFileStem}.gltf`, gltfBlob);
                    zip.file("cvr_object_thumbnail.png", screenshotBlob);
                    const zipBlob = await zip.generateAsync({ type: "blob" });
                    this._downloadBlob(zipBlob, `${exportFileStem}-export.zip`);
                }
            },
            (err) => {
                console.error(`GLTF export for ${objectName} failed:`, err);
            },
            { binary: false, embedImages: true, onlyVisible: true, truncateDrawRange: true, maxTextureSize: 4096 } as GLTFExporterOptions
        );
    }
}

export default C3DThreeAdapter;
