import Network from './network';
import { CognitiveVRAnalyticsCore, SessionPropertyValue } from './core';

export type RemoteVariableType = 'string' | 'int' | 'boolean';

export interface RemoteVariableItem {
    name?: string;
    description?: string;
    remoteVariableName: string;
    type: RemoteVariableType | string;
    valueString?: string;
    valueInt?: number;
    valueBoolean?: boolean;
}

export interface RemoteVariableCollection {
    abTests?: RemoteVariableItem[];
    remoteConfigurations?: RemoteVariableItem[];
}

type RemoteVariablesListener = () => void;

class RemoteVariables {
    private core: CognitiveVRAnalyticsCore;
    private network: Network;
    private variables: Map<string, RemoteVariableItem>;
    private fetched: boolean;
    private listeners: Set<RemoteVariablesListener>;

    constructor(core: CognitiveVRAnalyticsCore) {
        this.core = core;
        this.network = new Network(core);
        this.variables = new Map();
        this.fetched = false;
        this.listeners = new Set();
    }

    get hasFetchedVariables(): boolean {
        return this.fetched;
    }

    onRemoteVariablesAvailable(listener: RemoteVariablesListener): void {
        this.listeners.add(listener);
        if (this.fetched) {
            try { listener(); } catch (e) { console.warn('C3D: remote-variable listener error', e); }
        }
    }

    offRemoteVariablesAvailable(listener: RemoteVariablesListener): void {
        this.listeners.delete(listener);
    }

    fetchVariables(identifier?: string): Promise<boolean> {
        return new Promise((resolve) => {
            if (this.fetched) {
                resolve(true);
                return;
            }
            const id = identifier || this.core.userId || this.core.deviceId;
            if (!id) {
                console.warn('C3D: RemoteVariables.fetchVariables - no participant or device id available yet.');
                resolve(false);
                return;
            }
            this.network.networkRemoteVariablesGet(id)
                .then((collection) => {
                    this.applyCollection(collection);
                    resolve(true);
                })
                .catch((err) => {
                    console.warn('C3D: RemoteVariables.fetchVariables failed.', err);
                    resolve(false);
                });
        });
    }

    applyCollection(collection: RemoteVariableCollection | null | undefined): void {
        const items = [
            ...((collection && collection.abTests) || []),
            ...((collection && collection.remoteConfigurations) || []),
        ];
        for (const item of items) {
            if (!item || !item.remoteVariableName) {
                continue;
            }
            this.variables.set(item.remoteVariableName, item);
            const value = this.rawValue(item);
            if (value !== undefined) {
                this.core.setSessionProperty('c3d.remote_variable.' + item.remoteVariableName, value);
            }
        }
        this.fetched = true;
        this.listeners.forEach((listener) => {
            try { listener(); } catch (e) { console.warn('C3D: remote-variable listener error', e); }
        });
    }

    getValue<T extends SessionPropertyValue>(name: string, defaultValue: T): T {
        const item = this.variables.get(name);
        if (!item) {
            return defaultValue;
        }
        const converted = this.convert(item, defaultValue);
        return (converted === undefined ? defaultValue : converted) as T;
    }

    listAllVariables(): RemoteVariableItem[] {
        return Array.from(this.variables.values());
    }

    endSession(): void {
        this.variables.clear();
        this.fetched = false;
    }

    private rawValue(item: RemoteVariableItem): SessionPropertyValue {
        switch (item.type) {
            case 'string': return item.valueString !== undefined ? item.valueString : '';
            case 'boolean': return item.valueBoolean !== undefined ? item.valueBoolean : false;
            case 'int': return item.valueInt !== undefined ? item.valueInt : 0;
            default:
                if (item.valueString !== undefined) return item.valueString;
                if (item.valueBoolean !== undefined) return item.valueBoolean;
                if (item.valueInt !== undefined) return item.valueInt;
                return undefined;
        }
    }

    private convert<T extends SessionPropertyValue>(item: RemoteVariableItem, defaultValue: T): SessionPropertyValue {
        if (typeof defaultValue === 'boolean') {
            return item.valueBoolean !== undefined ? item.valueBoolean : defaultValue;
        }
        if (typeof defaultValue === 'number') {
            if (item.valueInt !== undefined) return item.valueInt;
            if (item.valueString !== undefined) {
                const parsed = parseFloat(item.valueString);
                return isNaN(parsed) ? defaultValue : parsed;
            }
            return defaultValue;
        }
        if (typeof defaultValue === 'string') {
            return item.valueString !== undefined ? item.valueString : defaultValue;
        }
        if (item.valueString !== undefined) return item.valueString;
        if (item.valueBoolean !== undefined) return item.valueBoolean;
        if (item.valueInt !== undefined) return item.valueInt;
        return defaultValue;
    }
}

export default RemoteVariables;
