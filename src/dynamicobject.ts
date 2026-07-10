import { v5 as uuidv5 } from 'uuid';
import Network from './network';
import { CognitiveVRAnalyticsCore } from './core';
import CustomEvents from './customevent';

// Fixed namespace so that uuidv5 output is stable across SDK consumers and
// sessions. Do not change this — changing it would invalidate every
// previously-generated dynamic object ID.
const C3D_DYNAMIC_OBJECT_NAMESPACE = 'c3d7ef2b-8a1d-4e5c-9b3f-7a6e2d8c4f10';

export interface DynamicObjectId {
    id: string;
    used: boolean;
    meshname: string;
}

export interface ManifestEntry {
    id: string;
    name: string;
    mesh: string;
    fileType: string;
    inputProfiles?: string[];
    properties?: Array<Record<string, any>>;
}

export interface EngagementEvent {
    isActive: boolean;
    startTime: number;
    name: string;
    id: string | null; 
    engagementNumber: number;
    endTime?: number;
}

interface EngagementPayload {
    engagementtype: string;
    engagementparent: string | null;
    engagement_count: number;
    engagement_time: number | undefined;
}

interface DynamicsPayload {
    userid: string;
    timestamp: number;
    sessionid: string;
    part: number;
    manifest: Record<string, ManifestPayloadEntry>;
    data: SnapshotPayload[];
}

interface ManifestPayloadEntry {
    name: string;
    mesh: string;
    fileType: string;
    inputProfiles?: string[];
    properties?: Array<Record<string, any>>;
}

export interface ButtonState {
    buttonPercent: number;
    x?: number;
    y?: number;
}

export interface SnapshotPayload {
    id: string;
    time: number;
    p: number[];
    r: number[];
    s?: number[];
    engagements?: EngagementPayload[];
    properties?: any;
    buttons?: Record<string, ButtonState>;
}

export interface Snapshot {
    position: number[];
    rotation: number[];
    time: number;
    id: string;
    scale?: number[] | null;
    properties?: any;
    engagements?: EngagementPayload[];
    buttons?: Record<string, ButtonState>;
}

export interface TrackedObjectEntry {
    object: object; 
    positionThreshold: number;
    rotationThreshold: number;
    scaleThreshold: number;
    [key: string]: unknown;
}

class DynamicObject {
    private core: CognitiveVRAnalyticsCore;
    private network: Network;
    private customEvent: CustomEvents;
    private generatedIdOffset: number;
    private jsonPart: number;
    
    public objectIds: DynamicObjectId[];
    public snapshots: Snapshot[];
    public fullManifest: ManifestEntry[];
    public manifestEntries: ManifestEntry[];
    public activeEngagements: { [objectId: string]: EngagementEvent[] };
    public allEngagements: { [objectId: string]: EngagementEvent[] };
    private engagementCounts: { [objectId: string]: { [name: string]: number } };
    public trackedObjects: Map<string, TrackedObjectEntry>;
    private snapshotIndexMap: Map<string, number>; // Track indices of snapshots while session is inactive

    constructor(core: CognitiveVRAnalyticsCore, customEvent: CustomEvents) {
        this.core = core;
        // @ts-ignore
        this.network = new Network(core);
        this.customEvent = customEvent;
        this.generatedIdOffset = 1000;
        this.jsonPart = 1;
        this.objectIds = [];
        this.snapshots = [];
        this.fullManifest = [];
        this.manifestEntries = [];
        this.activeEngagements = {};
        this.allEngagements = {};
        this.engagementCounts = {};
        this.trackedObjects = new Map();
        this.snapshotIndexMap = new Map();
    }
    // 1. Explicit Overloads for backwards compatibility
    registerObjectCustomId(name: string, meshname: string, customid: string, position: number[], rotation: number[], fileType?: string): string;
    registerObjectCustomId(name: string, meshname: string, customid: string, position: number[], rotation: number[], scale: number[] | null, fileType?: string): string;
    // Implementation
    registerObjectCustomId(name: string, meshname: string, customid: string, position: number[], rotation: number[], scaleOrFileType?: number[] | string | null, maybeFileType?: string): string {
        let scale: number[] | null = null;
        let fileType: string | undefined;
        if (Array.isArray(scaleOrFileType) || scaleOrFileType === null) {
            scale = scaleOrFileType;
            fileType = maybeFileType;
        } else if (typeof scaleOrFileType === 'string') {
            fileType = scaleOrFileType;
        }
        for (let i = 0; i < this.objectIds.length; i++) {
            if (this.objectIds[i].id === customid) {
                console.log("DynamicObject.registerObjectCustomId object id " + customid + " already registered");
                break;
            }
        }
        let registerId = this.dynamicObjectId(customid, meshname);
        this.objectIds.push(registerId);

        const finalFileType = fileType || "gltf";
        let dome = this.dynamicObjectManifestEntry(registerId.id, name, meshname, finalFileType);
        this.manifestEntries.push(dome);
        this.fullManifest.push(dome);
        let props = [{ "enabled": true }]; 

        this.addSnapshot(customid, position, rotation, scale, props);

        if (this.core.isSessionActive && (this.snapshots.length + this.manifestEntries.length >= this.core.config.dynamicDataLimit)) {
            this.sendData();
        }
        return customid;
    }

    // Explicit Overloads for registerObject
    registerObject(name: string, meshname: string, position: number[], rotation: number[], fileType?: string): string;
    registerObject(name: string, meshname: string, position: number[], rotation: number[], scale: number[] | null, fileType?: string): string;
    // Implementation
    registerObject(name: string, meshname: string, position: number[], rotation: number[], scaleOrFileType?: number[] | string | null, maybeFileType?: string): string {
        let scale: number[] | null = null;
        let fileType: string | undefined;
        if (Array.isArray(scaleOrFileType) || scaleOrFileType === null) {
            scale = scaleOrFileType;
            fileType = maybeFileType;
        } else if (typeof scaleOrFileType === 'string') {
            fileType = scaleOrFileType;
        }
        
        const sceneId = this.core.sceneData.sceneId || '';
        const seed = `${sceneId}::${name}::${meshname}`;
        const deterministicId = uuidv5(seed, C3D_DYNAMIC_OBJECT_NAMESPACE);
        const finalFileType = fileType || "gltf";

        const existing = this.objectIds.find(o => o.id === deterministicId);
        if (existing) {
            if (!existing.used) {
                existing.used = true;
                let manifestEntry = this.fullManifest.find(entry => entry.id === existing.id);
                if (!manifestEntry) {
                    manifestEntry = this.dynamicObjectManifestEntry(existing.id, name, meshname, finalFileType);
                    this.fullManifest.push(manifestEntry);
                }
                if (!this.manifestEntries.some(entry => entry.id === existing.id)) {
                    this.manifestEntries.push(manifestEntry);
                }
                this.addSnapshot(existing.id, position, rotation, scale, [{ "enabled": true }]);
                if (this.core.isSessionActive && (this.snapshots.length + this.manifestEntries.length >= this.core.config.dynamicDataLimit)) {
                    this.sendData();
                }
            }
            console.warn(`DynamicObject.registerObject: "${name}" + "${meshname}" already registered in this scene; returning existing id.`);
            return existing.id;
        }

        let newObjectId = this.dynamicObjectId(deterministicId, meshname);
        this.objectIds.push(newObjectId);
        let dome = this.dynamicObjectManifestEntry(newObjectId.id, name, meshname, finalFileType);
        this.manifestEntries.push(dome);
        this.fullManifest.push(dome);

        let props = [{ "enabled": true }];
        this.addSnapshot(newObjectId.id, position, rotation, scale, props);

        if (this.core.isSessionActive && (this.snapshots.length + this.manifestEntries.length >= this.core.config.dynamicDataLimit)) {
            this.sendData();
        }
        return newObjectId.id;
    }

    trackObject(id: string, object: object, options: { positionThreshold?: number, rotationThreshold?: number, scaleThreshold?: number, useLocalScale?: boolean } = {}): void { 
        if (!id || !object) {
            console.error("DynamicObject.trackObject: id and object must be provided.");
            return;
        }
        this.trackedObjects.set(id, {
            object: object,
            positionThreshold: options.positionThreshold || 0.01, 
            rotationThreshold: options.rotationThreshold || 0.5, 
            scaleThreshold: options.scaleThreshold || 0.05
        });
    }

    addSnapshot(objectId: string, position: number[], rotation: number[], scale?: number[] | null, properties?: any): void {
        let foundId = this.objectIds.some(element => objectId === element.id);
        if (!foundId) {
            console.warn("DynamicObject::Snapshot cannot find objectId " + objectId + " in full manifest. Did you Register this object?");
        }

        let snapshot = this.dynamicObjectSnapshot(position, rotation, objectId, scale, properties);

        if (this.allEngagements[objectId] && Object.keys(this.allEngagements[objectId]).length > 0) {
            this._processSnapshotEngagements(snapshot, objectId);
        }

        // If session is inactive and this is a standard transform update (no properties),
        // overwrite previous snapshot for this object to prevent data flooding 
        // while ensuring the *latest* start position is preserved.
        if (!this.core.isSessionActive && !properties) {
            if (this.snapshotIndexMap.has(objectId)) {
                const index = this.snapshotIndexMap.get(objectId) as number;
                // Safety check: ensure the snapshot at this index actually belongs to this ID
                if (this.snapshots[index] && this.snapshots[index].id === objectId) {
                    this.snapshots[index] = snapshot;
                    return; // Successfully updated in place, exit early
                }
            }
            // If not found in map, or map was stale, store the new index for future overwrites
            this.snapshotIndexMap.set(objectId, this.snapshots.length);
        }
        this.snapshots.push(snapshot);

        if (this.core.isSessionActive && (this.snapshots.length + this.manifestEntries.length >= this.core.config.dynamicDataLimit)) {
            this.sendData();
        }
    }

    private _processSnapshotEngagements(snapshot: Snapshot, objectId: string): void {
        if (!snapshot.engagements) {
            snapshot.engagements = [];
        }
        for (let e of this.allEngagements[objectId]) {
            let engagementEvent: EngagementPayload = {
                engagementtype: e.name,
                engagementparent: e.id,
                engagement_count: e.engagementNumber,
                engagement_time: e.isActive ? (this.core.getTimestamp() - e.startTime) : e.endTime
            };
            snapshot.engagements.push(engagementEvent);
        }
        this.removeInActiveEngagementsOfAnObject(objectId);
    }

    removeInActiveEngagementsOfAnObject(objectId: string): void {
        let { length: i } = this.allEngagements[objectId];
        while (i--) {
            if (!this.allEngagements[objectId][i].isActive) {
                this.allEngagements[objectId].splice(i, 1);
            }
            if (this.activeEngagements[objectId] && this.activeEngagements[objectId][i] && !this.activeEngagements[objectId][i].isActive) {
                this.activeEngagements[objectId].splice(i, 1);
            }
        }
    }

    sendData(): Promise<number | string> {
        return new Promise((resolve, reject) => {
            if (!this.core.isSessionActive) {
                console.log('DynamicObject.sendData failed: no session active');
                resolve('DynamicObject.sendData failed: no session active');
                return;
            }

            if ((this.manifestEntries.length + this.snapshots.length) === 0) {
                resolve('no manifest entries/snapshots');
                return;
            }

            let sendJson: DynamicsPayload = {
                userid: this.core.userId,
                timestamp: this.core.getTimestamp(),
                sessionid: this.core.sessionId,
                part: this.jsonPart,
                manifest: this._buildManifest(),
                data: this._buildSnapshotData()
            };
            this.jsonPart++;

            this.network.networkCall('dynamics', sendJson)
                .then(res => (res === 200) ? resolve(200) : reject(res));
            
            this.manifestEntries = [];
            this.snapshots = [];
            this.snapshotIndexMap.clear();
        });
    }

    private _buildManifest(): Record<string, ManifestPayloadEntry> {
        let manifest: Record<string, ManifestPayloadEntry> = {};
        for (let element of this.manifestEntries) {
            const entry: ManifestPayloadEntry = {
                name: element.name,
                mesh: element.mesh,
                fileType: "gltf"
            };
            if (element.inputProfiles?.length) entry.inputProfiles = element.inputProfiles;
            if (element.properties) entry.properties = element.properties;
            manifest[element.id] = entry;
        }
        return manifest;
    }

    private _buildSnapshotData(): SnapshotPayload[] {
        let data: SnapshotPayload[] = [];
        for (let element of this.snapshots) {
            let entry: SnapshotPayload = {
                id: element.id,
                time: element.time,
                p: element.position,
                r: element.rotation
            };
            if (element.scale) {
                entry['s'] = element.scale;
            }
            if (element.engagements && element.engagements.length) { entry['engagements'] = element.engagements; }
            if (element.properties) { entry['properties'] = element.properties; }
            if (element.buttons) { entry['buttons'] = element.buttons; }
            data.push(entry);
        }
        return data;
    }

    dynamicObjectSnapshot(position: number[], rotation: number[], objectId: string, scale?: number[] | null, properties?: any, buttons?: Record<string, ButtonState>): Snapshot {
        let ss: Snapshot = {
            position: position,
            rotation: rotation,
            time: this.core.getTimestamp(),
            id: objectId
        };
        if (scale) { ss.scale = scale; }
        if (properties) { ss.properties = properties; }
        if (buttons) { ss.buttons = buttons; }
        return ss;
    }

    registerControllerObject(
        name: string, meshname: string, customid: string,
        position: number[], rotation: number[],
        inputProfiles: string[] | string, handedness: 'left' | 'right'
    ): string {
        // Backward compatibility: the 6th argument was previously a classified `controllerType`
        // string. That classification was removed in favor of raw WebXR input profiles, but this
        // method is publicly reachable, so accept a string too and coerce it to a single-element
        // array — older callers keep working and never write a non-array `inputProfiles` value.
        const profiles: string[] = Array.isArray(inputProfiles)
            ? inputProfiles
            : (inputProfiles ? [inputProfiles] : []);

        for (let i = 0; i < this.objectIds.length; i++) {
            if (this.objectIds[i].id === customid) {
                console.log("DynamicObject.registerControllerObject object id " + customid + " already registered");
                return customid;
            }
        }
        let registerId = this.dynamicObjectId(customid, meshname);
        this.objectIds.push(registerId);

        const dome: ManifestEntry = {
            id: customid,
            name,
            mesh: meshname,
            fileType: 'gltf',
            inputProfiles: profiles,
            properties: [{ controller: handedness }],
        };
        this.manifestEntries.push(dome);
        this.fullManifest.push(dome);

        this.addSnapshot(customid, position, rotation, null, [{ enabled: true }]);

        if (this.core.isSessionActive && (this.snapshots.length + this.manifestEntries.length >= this.core.config.dynamicDataLimit)) {
            this.sendData();
        }
        return customid;
    }

    addInputSnapshot(
        objectId: string, position: number[], rotation: number[],
        buttons?: Record<string, ButtonState> | null,
        properties?: any
    ): void {
        const foundId = this.objectIds.some(e => objectId === e.id);
        if (!foundId) {
            console.warn("DynamicObject::addInputSnapshot cannot find objectId " + objectId);
            return;
        }
        const snapshot = this.dynamicObjectSnapshot(position, rotation, objectId, null, properties, buttons ?? undefined);
        this.snapshots.push(snapshot);

        if (this.core.isSessionActive && (this.snapshots.length + this.manifestEntries.length >= this.core.config.dynamicDataLimit)) {
            this.sendData();
        }
    }

    dynamicObjectEngagementEvent(id: string | null, engagementName: string, engagementNumber: number): EngagementEvent {
        return {
            isActive: true,
            startTime: this.core.getTimestamp(),
            name: engagementName,
            id: id,
            engagementNumber: engagementNumber
        };
    }

    dynamicObjectId(id: string, meshname: string): DynamicObjectId {
        return { id, used: true, meshname };
    }

    dynamicObjectManifestEntry(id: string, name: string, mesh: string, fileType: string): ManifestEntry {
        return { id, name, mesh, fileType };
    }

    endSession(): void {
        this.fullManifest = [];
        this.manifestEntries = [];
        this.objectIds = [];
        this.snapshots = [];
        this.snapshotIndexMap.clear();
        this.engagementCounts = {};
        this.allEngagements = {};
        this.activeEngagements = {};
        this.trackedObjects.clear();
    }

    refreshObjectManifest(): void {
        for (var i = 0; i < this.fullManifest.length; i++) {
            var element = this.fullManifest[i];
            this.manifestEntries.push(element);
        }
    }

    removeObject(objectid: string, position: number[], rotation: number[]): void {
        this.endActiveEngagements(objectid);
        let props = [{ "enabled": false }];
        this.addSnapshot(objectid, position, rotation, null, props);

        for (let i = 0; i < this.objectIds.length; i++) {
            if (this.objectIds[i].id === objectid) {
                this.objectIds[i].used = false;
                return;
            }
        }
    }

    beginEngagement(objectId: string, name: string, parentId: string | null = null): void {
        console.log("DynamicObject::beginEngagement engagement " + name + " on object " + objectId);
        if (!this.engagementCounts[objectId]) {
            this.engagementCounts[objectId] = {};
        }
        if (!this.engagementCounts[objectId][name]) {
            this.engagementCounts[objectId][name] = 1;
        } else {
            this.engagementCounts[objectId][name] = this.engagementCounts[objectId][name] + 1;
        }

        let engagement = this.dynamicObjectEngagementEvent(parentId, name, this.engagementCounts[objectId][name]);
        if (!this.activeEngagements[objectId]) this.activeEngagements[objectId] = [];
        if (!this.allEngagements[objectId]) this.allEngagements[objectId] = [];
        
        this.activeEngagements[objectId].push(engagement);
        this.allEngagements[objectId].push(engagement);
    }

    endActiveEngagements(objectId: string): void {
        if (!this.activeEngagements[objectId]) return;
        for (let i = 0; i < this.activeEngagements[objectId].length; i++) {
            if (this.activeEngagements[objectId][i].isActive) {
                this.activeEngagements[objectId][i].isActive = false;
            }
        }
    }

    endEngagement(objectId: string, name: string, parentId: string): void {
        if (this.activeEngagements[objectId]) {
            const index = this._findActiveEngagementIndex(objectId, name, parentId);
            if (index !== -1) {
                this._closeEngagement(this.activeEngagements[objectId][index]);
                return;
            }
        }
        // otherwise create and end the engagement
        console.log("DynamicObject::EndEngagement engagement " + name + " not found on object" + objectId + ". Begin+End");
        this.beginEngagement(objectId, name, parentId);
        
        // Find it again in the newly created list
        const newIndex = this._findActiveEngagementIndex(objectId, name, parentId);
        if (newIndex !== -1) {
            this._closeEngagement(this.activeEngagements[objectId][newIndex]);
        }
    }

    private _findActiveEngagementIndex(objectId: string, name: string, parentId: string | null): number {
        const engagements = this.activeEngagements[objectId];
        if (!engagements) return -1;
        
        return engagements.findIndex(e => {
            if (!e.isActive || e.name !== name) return false;
            if (parentId) return e.id === parentId;
            return true;
        });
    }

    private _closeEngagement(engagement: EngagementEvent): void {
        engagement.isActive = false;
        engagement['endTime'] = this.core.getTimestamp() - engagement.startTime;
    }
}

export default DynamicObject;
