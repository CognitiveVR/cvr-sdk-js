import Network from './network';
import { CognitiveVRAnalyticsCore } from './core';

export type SensorValue = number;

interface SensorDataPoint {
    name: string;
    data: Array<[number, SensorValue]>;
}

interface SensorPayload {
    name: string;
    sessionid: string;
    timestamp: number;
    part: number;
    data: SensorDataPoint[];
}

class Sensors {
    private core: CognitiveVRAnalyticsCore;
    private network: Network;
    public allSensors: SensorDataPoint[];
    public sensorCount: number;
    private jsonPart: number;

    constructor(core: CognitiveVRAnalyticsCore) {
        this.core = core;
        // @ts-ignore
        this.network = new Network(core);
        this.allSensors = [];
        this.sensorCount = 0;
        this.jsonPart = 1;
    }

    recordSensor(name: string, value: number | boolean): void {
        let finalValue: number;
        if (typeof value === 'boolean') {
            finalValue = value ? 1 : 0;
        } else {
            finalValue = value;
        }

        let point: [number, SensorValue] = [this.core.getTimestamp(), finalValue];
        let sensor = this.allSensors.find(sensor => sensor.name === name);
        
        // Append value to sensor in list if it exists, otherwise create new entry
        if (sensor) {
            sensor.data.push(point);
        } else {
            this.allSensors.push({ name: name, data: [point] });
        }

        this.sensorCount++;
        if (this.core.isSessionActive && this.sensorCount >= this.core.config.sensorDataLimit) {
            this.sendData().catch((err) => console.warn('C3D: Sensor auto-flush failed', err));
        }
    }

    sendData(): Promise<number | string> {
        return new Promise((resolve, reject) => {
            if (!this.core.isSessionActive) {
                const msg = 'Sensor.sendData failed: no session active';
                console.log(msg);
                reject(msg);
                return;
            }
            if (this.allSensors.length === 0) {
                console.log('no sensor data');
                resolve('no sensor data');
                return;
            }

            let payload: SensorPayload = {
                name: this.core.userId,
                sessionid: this.core.getSessionId(),
                timestamp: parseInt(this.core.getTimestamp() as unknown as string, 10),
                part: this.jsonPart,
                data: this.allSensors
            };
            this.jsonPart++;

            this.network.networkCall('sensors', payload)
                .then(res => (res === 200) ? resolve(res as number) : reject(res))
                .catch(err => reject(err));
            
            this.sensorCount = 0;
            this.allSensors = [];
        });
    }

    endSession(): void {
        this.allSensors = [];
        this.jsonPart = 1;
    }
}

export default Sensors;