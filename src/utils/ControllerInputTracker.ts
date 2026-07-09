import { isBrowser } from './environment';
import { ButtonState } from '../dynamicobject';
import { SessionPropertyValue } from '../core';

interface C3DInstance {
    customEvent: {
        send: (name: string, position: number[], properties?: Record<string, SessionPropertyValue>) => void;
    };
    dynamicObject: {
        registerControllerObject: (
            name: string, meshname: string, customid: string,
            position: number[], rotation: number[],
            inputProfiles: string[], handedness: 'left' | 'right'
        ) => string;
        addInputSnapshot: (
            id: string, position: number[], rotation: number[],
            buttons?: Record<string, ButtonState> | null,
            properties?: any
        ) => void;
        objectIds: Array<{ id: string; used: boolean; meshname: string }>;
    };
    xrSessionManager: { referenceSpace: XRReferenceSpace | null } | null;
    lastInputType: 'none' | 'hand' | 'controller';
}

// Maps a raw WebXR profile id to the dashboard mesh used to render the controller.
// This is rendering configuration only. Controller *identity* is carried by the raw
// input profiles transmitted alongside (see registerControllerObject) and is never
// classified in the SDK.
type ControllerMesh = (h: 'left' | 'right') => string;

const CONTROLLER_MESH_MAP: Record<string, ControllerMesh> = {
    'meta-quest-touch-plus': h => h === 'left' ? 'QuestPlusTouchLeft' : 'QuestPlusTouchRight',
    'meta-quest-touch-pro': h => h === 'left' ? 'QuestProTouchLeft' : 'QuestProTouchRight',
    'oculus-touch-v3': h => h === 'left' ? 'OculusQuestTouchLeft' : 'OculusQuestTouchRight',
    'oculus-touch-v2': h => h === 'left' ? 'OculusQuestTouchLeft' : 'OculusQuestTouchRight',
    'oculus-touch': h => h === 'left' ? 'OculusRiftTouchLeft' : 'OculusRiftTouchRight',
    'htc-vive-focus-3': h => h === 'left' ? 'ViveFocusControllerLeft' : 'ViveFocusControllerRight',
    'htc-vive': _ => 'ViveController',
    'valve-index': h => h === 'left' ? 'SteamIndexLeft' : 'SteamIndexRight',
    'microsoft-mixed-reality': h => h === 'left' ? 'WindowsMixedRealityLeft' : 'WindowsMixedRealityRight',
    'hp-mixed-reality': h => h === 'left' ? 'WindowsMixedRealityLeft' : 'WindowsMixedRealityRight',
    'pico-neo3-controller': h => h === 'left' ? 'PicoNeo3ControllerLeft' : 'PicoNeo3ControllerRight',
    'pico-4-controller': h => h === 'left' ? 'PicoNeo4ControllerLeft' : 'PicoNeo4ControllerRight',
};

const UNKNOWN_MESH: ControllerMesh = _ => 'GenericController';

// Resolves the render mesh only. `fallbackController` selects a mesh for unrecognized
// profiles; it does not influence any identity signal — the raw profiles are always sent.
export function resolveControllerMesh(profiles: readonly string[], handedness: 'left' | 'right', fallback?: string): string {
    for (const profile of profiles) {
        const lower = profile.toLowerCase();
        for (const key of Object.keys(CONTROLLER_MESH_MAP)) {
            if (lower.includes(key)) return CONTROLLER_MESH_MAP[key](handedness);
        }
    }
    if (fallback) {
        const fallbackMesh = CONTROLLER_MESH_MAP[fallback];
        if (fallbackMesh) {
            console.warn(`C3D: Unrecognized controller profiles [${profiles.join(', ')}]. Using configured fallback mesh '${fallback}'.`);
            return fallbackMesh(handedness);
        }
    }
    console.warn(`C3D: Unrecognized controller profiles [${profiles.join(', ')}]. Using generic controller mesh.`);
    return UNKNOWN_MESH(handedness);
}

const ANALOG_THROTTLE_MS = 100;
const JOYSTICK_MIN_MAGNITUDE = 0.05;

class ControllerInputTracker {
    private c3d: C3DInstance;
    private fallbackController?: string;
    private xrSession: XRSession | null = null;
    private isTracking = false;
    private animationFrameHandle: number | null = null;

    private registeredIds = new Set<string>();
    private lastButtons = new Map<string, Record<string, ButtonState>>();
    private lastAnalogTime = new Map<string, number>();
    private lastPoses = new Map<string, { pos: number[]; rot: number[] }>();

    constructor(c3dInstance: C3DInstance, fallbackController?: string) {
        this.c3d = c3dInstance;
        this.fallbackController = fallbackController;
        this._onFrame = this._onFrame.bind(this);
    }

    start(xrSession: XRSession): void {
        if (!isBrowser || this.isTracking) return;
        this.xrSession = xrSession;
        this.isTracking = true;
        this.animationFrameHandle = xrSession.requestAnimationFrame(this._onFrame);
    }

    stop(): void {
        this.isTracking = false;
        if (this.xrSession && this.animationFrameHandle !== null) {
            this.xrSession.cancelAnimationFrame(this.animationFrameHandle);
        }
        this.animationFrameHandle = null;
        this.xrSession = null;
        this.registeredIds.clear();
        this.lastButtons.clear();
        this.lastAnalogTime.clear();
        this.lastPoses.clear();
    }

    private _onFrame(timestamp: number, frame: XRFrame): void {
        if (!this.isTracking || !this.xrSession) return;
        this.animationFrameHandle = this.xrSession.requestAnimationFrame(this._onFrame);

        const refSpace = this.c3d.xrSessionManager?.referenceSpace;
        if (!refSpace) return;

        this._detectInputTypeChange(frame, refSpace);
        this._processControllers(timestamp, frame, refSpace);
        this._processHands(frame, refSpace);
    }

    private _detectInputTypeChange(frame: XRFrame, refSpace: XRReferenceSpace): void {
        if (!this.xrSession) return;

        let sawController = false;
        let sawHand = false;

        for (const src of this.xrSession.inputSources) {
            if (src.hand && this._getWristPose(frame, src, refSpace)) {
                sawHand = true;
            } else if (src.gripSpace && frame.getPose(src.gripSpace, refSpace)) {
                sawController = true;
            }
        }

        const current: 'none' | 'hand' | 'controller' = sawController ? 'controller' : sawHand ? 'hand' : 'none';
        const prev = this.c3d.lastInputType;
        if (current === prev) return;

        this.c3d.customEvent.send('c3d.input.tracking.changed', [0, 0, 0], {
            'Previously Tracking': prev,
            'Now Tracking': current,
        });
        this.c3d.lastInputType = current;
        this._updateEnabledStates(current);
    }

    private _updateEnabledStates(current: 'none' | 'hand' | 'controller'): void {
        const pairs: Array<[string, 'controller' | 'hand']> = [
            ['c3d_controller_left', 'controller'],
            ['c3d_controller_right', 'controller'],
            ['c3d_hand_left', 'hand'],
            ['c3d_hand_right', 'hand'],
        ];
        for (const [id, type] of pairs) {
            if (!this.registeredIds.has(id)) continue;
            const pose = this.lastPoses.get(id) ?? { pos: [0, 0, 0], rot: [0, 0, 0, 1] };
            this.c3d.dynamicObject.addInputSnapshot(id, pose.pos, pose.rot, null, [{ enabled: current === type }]);
        }
    }

    private _processControllers(timestamp: number, frame: XRFrame, refSpace: XRReferenceSpace): void {
        if (!this.xrSession) return;

        for (const src of this.xrSession.inputSources) {
            if (src.hand || src.targetRayMode !== 'tracked-pointer' || !src.gripSpace) continue;
            const handedness = src.handedness as 'left' | 'right';
            if (handedness !== 'left' && handedness !== 'right') continue;

            const id = handedness === 'left' ? 'c3d_controller_left' : 'c3d_controller_right';

            if (!this.registeredIds.has(id)) {
                // Guard src.profiles: per the WebXR spec it is always present, but polyfills and
                // synthetic input sources can omit it. Match the defensiveness of getInputProfiles()
                // and the hand path below so a malformed source can't throw and kill the frame loop.
                const profiles = src.profiles ?? [];
                const mesh = resolveControllerMesh(profiles, handedness, this.fallbackController);
                const pose = frame.getPose(src.gripSpace, refSpace);
                const pos = pose ? this._extractPos(pose) : [0, 0, 0];
                const rot = pose ? this._extractRot(pose) : [0, 0, 0, 1];
                const name = handedness === 'left' ? 'Left Controller' : 'Right Controller';
                this.c3d.dynamicObject.registerControllerObject(
                    name, mesh, id, pos, rot,
                    Array.from(profiles), handedness
                );
                this.registeredIds.add(id);
                this.lastPoses.set(id, { pos, rot });
                continue;
            }

            const pose = frame.getPose(src.gripSpace, refSpace);
            if (!pose) continue;
            const pos = this._extractPos(pose);
            const rot = this._extractRot(pose);
            this.lastPoses.set(id, { pos, rot });

            const buttons = this._readButtons(timestamp, id, src, handedness);
            this.c3d.dynamicObject.addInputSnapshot(id, pos, rot, buttons ?? undefined);
        }
    }

    private _readButtons(timestamp: number, id: string, src: XRInputSource, handedness: 'left' | 'right'): Record<string, ButtonState> | null {
        const gp = src.gamepad;
        if (!gp) return null;

        const last = this.lastButtons.get(id) ?? {};
        const lastAnalog = this.lastAnalogTime.get(id) ?? 0;
        const emitAnalog = (timestamp - lastAnalog) >= ANALOG_THROTTLE_MS;
        const changes: Record<string, ButtonState> = {};
        let hasChanges = false;

        // trigger (index 0, analog)
        if (gp.buttons[0] && emitAnalog) {
            const pct = Math.round(Math.min(1, Math.max(0, gp.buttons[0].value)) * 100);
            if (!last['trigger'] || last['trigger'].buttonPercent !== pct) {
                changes['trigger'] = { buttonPercent: pct };
                hasChanges = true;
            }
        }

        // grip (index 1, analog)
        if (gp.buttons[1] && emitAnalog) {
            const pct = Math.round(Math.min(1, Math.max(0, gp.buttons[1].value)) * 100);
            if (!last['grip'] || last['grip'].buttonPercent !== pct) {
                changes['grip'] = { buttonPercent: pct };
                hasChanges = true;
            }
        }

        // joystick (index 3 press + axes[2]/axes[3])
        const axX = gp.axes[2] ?? 0;
        const axY = gp.axes[3] ?? 0;
        const joyPressed = gp.buttons[3]?.pressed ? 100 : 0;
        const prevJoy = last['joystick'];
        const axisMoved = emitAnalog && Math.sqrt(axX * axX + axY * axY) > JOYSTICK_MIN_MAGNITUDE &&
            (Math.abs((prevJoy?.x ?? 0) - axX) > JOYSTICK_MIN_MAGNITUDE || Math.abs((prevJoy?.y ?? 0) - axY) > JOYSTICK_MIN_MAGNITUDE);
        if (!prevJoy || prevJoy.buttonPercent !== joyPressed || axisMoved) {
            changes['joystick'] = { buttonPercent: joyPressed, x: axX, y: axY };
            hasChanges = true;
        }

        // primary button: A (right) / X (left) — index 4
        if (gp.buttons[4]) {
            const pct = gp.buttons[4].pressed ? 100 : 0;
            const name = handedness === 'left' ? 'xbtn' : 'abtn';
            if (!last[name] || last[name].buttonPercent !== pct) {
                changes[name] = { buttonPercent: pct };
                hasChanges = true;
            }
        }

        // secondary button: B (right) / Y (left) — index 5
        if (gp.buttons[5]) {
            const pct = gp.buttons[5].pressed ? 100 : 0;
            const name = handedness === 'left' ? 'ybtn' : 'bbtn';
            if (!last[name] || last[name].buttonPercent !== pct) {
                changes[name] = { buttonPercent: pct };
                hasChanges = true;
            }
        }

        if (!hasChanges) return null;
        if (emitAnalog) this.lastAnalogTime.set(id, timestamp);
        this.lastButtons.set(id, { ...last, ...changes });
        return changes;
    }

    private _processHands(frame: XRFrame, refSpace: XRReferenceSpace): void {
        if (typeof (frame as any).getJointPose !== 'function') return;
        if (!this.xrSession) return;

        for (const src of this.xrSession.inputSources) {
            if (!src.hand) continue;
            const handedness = src.handedness as 'left' | 'right';
            if (handedness !== 'left' && handedness !== 'right') continue;

            const id = handedness === 'left' ? 'c3d_hand_left' : 'c3d_hand_right';
            const wristPose = this._getWristPose(frame, src, refSpace);
            if (!wristPose) continue;

            const pos = this._extractPos(wristPose);
            const rot = this._extractRot(wristPose);
            this.lastPoses.set(id, { pos, rot });

            if (!this.registeredIds.has(id)) {
                const meshname = handedness === 'left' ? 'handLeft' : 'handRight';
                const name = handedness === 'left' ? 'Left Hand' : 'Right Hand';
                this.c3d.dynamicObject.registerControllerObject(name, meshname, id, pos, rot, Array.from(src.profiles ?? []), handedness);
                this.registeredIds.add(id);
                continue;
            }

            this.c3d.dynamicObject.addInputSnapshot(id, pos, rot);
        }
    }

    private _getWristPose(frame: XRFrame, src: XRInputSource, refSpace: XRReferenceSpace): XRPose | null {
        if (!src.hand) return null;
        const wristJoint = src.hand.get('wrist');
        if (!wristJoint) return null;
        try {
            return (frame as any).getJointPose(wristJoint, refSpace) ?? null;
        } catch {
            return null;
        }
    }

    private _extractPos(pose: XRPose): number[] {
        const p = pose.transform.position;
        return [p.x, p.y, -p.z];
    }

    private _extractRot(pose: XRPose): number[] {
        const o = pose.transform.orientation;
        return [o.x, o.y, -o.z, -o.w];
    }
}

export default ControllerInputTracker;
