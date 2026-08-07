import Network from './network';
import { CognitiveVRAnalyticsCore, SessionPropertyValue } from './core';

// Shape of a single event payload
interface CustomEventData {
    name: string;
    time: number;
    point: number[];
    lobbyId: string;
    properties?: Record<string, SessionPropertyValue>;
}

// Interface for the payload sent to the network
interface CustomEventPayload {
    userid: string;
    timestamp: number;
    sessionid: string;
    part: number;
    data: CustomEventData[];
}

class CustomEvents {
    private core: CognitiveVRAnalyticsCore;
    private network: Network;
    public batchedCustomEvents: CustomEventData[]; 
    private jsonPart: number;

    constructor(core: CognitiveVRAnalyticsCore) {
        this.core = core;
        // @ts-ignore: Network expects the default export type, but they are compatible at runtime
        this.network = new Network(core);
        this.batchedCustomEvents = [];
        this.jsonPart = 1;
    }

    send(category: string, position: number[], properties?: Record<string, SessionPropertyValue>): void {
        let data: CustomEventData = {
            name: category,
            time: this.core.getTimestamp(),
            point: [position[0], position[1], position[2]],
            lobbyId: this.core.lobbyId
        };
        
        if (properties) { 
            data.properties = properties; 
        }

        this.batchedCustomEvents = this.batchedCustomEvents.concat([data]);

        if (this.core.isSessionActive && this.batchedCustomEvents.length >= this.core.config.customEventBatchSize) {
            this.sendData().catch((err) => console.warn('C3D: CustomEvent auto-flush failed', err));
        }
    }

    sendData(): Promise<number | string> {
        return new Promise((resolve, reject) => {
            if (!this.core.isSessionActive) {
                const msg = 'CustomEvent.sendData failed: no session active';
                console.log(msg);
                resolve(msg);
                return;
            } else {
                let payload: CustomEventPayload = {
                    userid: this.core.userId,
                    timestamp: parseInt(this.core.getTimestamp() as unknown as string, 10),
                    sessionid: this.core.getSessionId(),
                    part: this.jsonPart,
                    data: this.batchedCustomEvents
                };
                
                this.jsonPart++;
                
                this.network.networkCall('events', payload)
                    .then(res => (res === 200) ? resolve(res as number) : reject(res))
                    .catch(err => reject(err));
                
                this.batchedCustomEvents = [];
            }
        });
    }

    endSession(): void {
        this.batchedCustomEvents = [];
        // restart counter on end session
        this.jsonPart = 1;
    }
}

export default CustomEvents;