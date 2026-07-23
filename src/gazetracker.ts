import Network from './network';
import { CognitiveVRAnalyticsCore, SessionPropertyValue } from './core';

// Define the structure of a single gaze data point
interface GazeData {
    time: number;
    p: number[]; 
    r: number[]; 
    o?: string;  
    g?: number[]; 
}

// Define the hit result structure
export interface GazeHit {
    objectId?: string | null;
    point: number[];
}

// Interface for the payload sent to the network
interface GazePayload {
    userid: string;
    timestamp: number;
    sessionid: string;
    lobbyId?: string;
    part: number;
    interval?: number;
    data: GazeData[];
    properties?: Record<string, SessionPropertyValue>;
}

class GazeTracker {
    private core: CognitiveVRAnalyticsCore;
    private network: Network;
    private playerSnapshotInterval: number | undefined;
    public batchedGaze: GazeData[];
    private jsonPart: number;

    constructor(core: CognitiveVRAnalyticsCore) {
        this.core = core;
        // @ts-ignore
        this.network = new Network(core);
        this.playerSnapshotInterval = undefined;
        this.batchedGaze = [];
        this.jsonPart = 1;
    }

    recordGaze(position: number[], rotation: number[], gazeHit?: GazeHit | number[] | null, objectId?: string): void {
        let ts = this.core.getTimestamp();
        let data: GazeData = {
            time: ts,
            p: [...position],
            r: [...rotation],
        };

        if (gazeHit) {
            if (Array.isArray(gazeHit)) {
                data['g'] = gazeHit;
            } else {
                if (gazeHit.objectId) {
                    data['o'] = gazeHit.objectId;
                    data['g'] = gazeHit.point; 
                } else {
                    data['g'] = gazeHit.point; 
                }
            }
        } 
        else if (objectId) {
             data['o'] = objectId;
        }

        this.batchedGaze = this.batchedGaze.concat([data]);

        if (this.core.isSessionActive && this.batchedGaze.length >= this.core.config.gazeBatchSize) {
            this.sendData();
        }
    }

    setInterval(interval: number): void {
        this.playerSnapshotInterval = interval;
    }

    /**
     * @deprecated The `hmdtype` gaze-payload shadow channel was removed. HMD identity is now
     * derived by the pipeline from the raw `c3d.device.xr.input_profiles` device signal. This
     * method is retained as a no-op for backward compatibility and will be removed in a future
     * major version.
     */
    setHMDType(_hmdtype: string): void {
        console.warn('C3D: setHMDType() is deprecated and has no effect. HMD identity is derived from the raw c3d.device.xr.input_profiles device signal.');
    }

    sendData(): Promise<number | string> {
        return new Promise((resolve, reject) => {
            if (!this.core.isSessionActive) {
                const msg = 'GazeTracker.sendData failed: no session active';
                console.log(msg);
                reject(msg);
                return;
            }
            
            const newOrChangedProperties = this._getChangedProperties();

            if (this.batchedGaze.length === 0 && Object.keys(newOrChangedProperties).length === 0) { 
                resolve('No data to send');
                return;
            }

            const payload = this._createPayload(newOrChangedProperties);

            this.network.networkCall('gaze', payload)
                .then(res => {
                    if (res === 200) {
                        this.core.sentSessionProperties = { ...this.core.sentSessionProperties, ...newOrChangedProperties };
                        resolve(res as number);
                    } else {
                        reject(res);
                    }
                });
            this.batchedGaze = [];
        });
    }

    private _getChangedProperties(): Record<string, SessionPropertyValue> {
        const allSessionProperties = this.core.sessionProperties || {};
        const sentSessionProperties = this.core.sentSessionProperties || {};
        const newOrChangedProperties: Record<string, SessionPropertyValue> = {}; 

        for (const key in allSessionProperties) {
            if (allSessionProperties[key] !== sentSessionProperties[key]) {
                newOrChangedProperties[key] = allSessionProperties[key];
            }
        }
        return newOrChangedProperties;
    }

    private _createPayload(properties: Record<string, SessionPropertyValue>): GazePayload {
        let payload: GazePayload = {
            userid: this.core.userId,
            timestamp: parseInt(this.core.getTimestamp() as unknown as string, 10),
            sessionid: this.core.getSessionId(),
            part: this.jsonPart,
            interval: this.playerSnapshotInterval,
            data: this.batchedGaze,
            properties: {}
        };

        if (this.core.lobbyId) { 
            payload.lobbyId = this.core.lobbyId; 
        }
        
        this.jsonPart++;
                    
        if (Object.keys(properties).length > 0) { 
            payload.properties = properties; 
        }
        return payload;
    }

    endSession(): void {
        this.batchedGaze = [];
        this.jsonPart = 1;
    }
}

export default GazeTracker;