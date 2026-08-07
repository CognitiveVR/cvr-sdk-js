import { fetch, isBrowser } from './utils/environment';
import Core from './core';
import type { RemoteVariableCollection } from './remotevariables';

// Define the shape of the QuestionSet response
export interface QuestionSet {
    id: string;
    [key: string]: unknown;
}

class Network {
    private core: typeof Core;

    constructor(core: typeof Core) {
        this.core = core;
    }

    isOnline(): boolean {
        // In browser, check navigator.onLine
        if (isBrowser && navigator && typeof navigator.onLine === 'boolean') {
            return navigator.onLine;
        }
        // In Node or other environments, assume online
        return true;
    }

    networkCall(suburl: string, content: object): Promise<number | string> {
        return new Promise((resolve, reject) => {
            if (!this.core.sceneData.sceneId || !this.core.sceneData.versionNumber) {
                const msg = 'no scene selected';
                reject(msg);
                return;
            }

            const path = `https://${this.core.config.networkHost}/v${this.core.config.networkVersion}/${suburl}/${this.core.sceneData.sceneId}?version=${this.core.sceneData.versionNumber}`;

            // --- LOGGER IMPLEMENTATION ---
            if (this.core.config.LOG) {
                const items = (content as any).data;
                const count = Array.isArray(items) ? `${items.length} items` : 'Object';
                
                console.groupCollapsed(`[C3D] Sending Batch: ${suburl} (${count})`);
                console.log("URL:", path);
                
                let payloadForLog = content;
                if (typeof structuredClone === 'function') {
                    try {
                        payloadForLog = structuredClone(content);
                    } catch (e) {
                        // If structuredClone fails (e.g. complex objects), fallback to original ref
                    }
                }
                console.log("Payload:", payloadForLog);
                console.groupEnd();
            }
            // -----------------------------

            const options = {
                method: 'post',
                headers: {
                    'Authorization': `APIKEY:DATA ${this.core.config.APIKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(content)
            };

            if (this.isOnline()) {
                fetch(path, options)
                    .then(res => resolve(res.status))
                    .catch(err => {
                        console.error('Network error:', err);
                        reject(err);
                    });
            } else {
                const message = 'Network.networkCall failed: please check internet connection.';
                console.log(message);
                resolve(message);
            }
        });
    }

    networkExitpollGet(hook: string): Promise<QuestionSet> {
        return new Promise((resolve, reject) => {
            const path = `https://${this.core.config.networkHost}/v${this.core.config.networkVersion}/questionSetHooks/${hook}/questionSet`;

            console.log(`Network.networkExitpollGet: ${path}`);

            const options = {
                method: 'get',
                headers: {
                    'Authorization': `APIKEY:DATA ${this.core.config.APIKey}`,
                    'Content-Type': 'application/json'
                }
            };

            fetch(path, options)
                .then(response => response.json() as Promise<QuestionSet>)
                .then(payload => resolve(payload))
                .catch(err => reject(err));
        });
    }

    networkExitpollPost(questionsetname: string, questionsetversion: string, content: object): Promise<number> {
        return new Promise((resolve, reject) => {
            const options = {
                method: 'post',
                headers: {
                    'Authorization': `APIKEY:DATA ${this.core.config.APIKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(content)
            };

            const path = `https://${this.core.config.networkHost}/v${this.core.config.networkVersion}/questionSets/${questionsetname}/${questionsetversion}/responses`;

            fetch(path, options)
                .then(res => res.status)
                .then(res => resolve(res))
                .catch(err => {
                    console.error('Error posting exit poll:', err);
                    reject(err);
                });
        });
    }

    networkRemoteVariablesGet(identifier: string): Promise<RemoteVariableCollection> {
        return new Promise((resolve, reject) => {
            const path = `https://${this.core.config.networkHost}/v${this.core.config.networkVersion}/remotevariables?identifier=${encodeURIComponent(identifier)}`;

            if (this.core.config.LOG) {
                console.log(`Network.networkRemoteVariablesGet: ${path}`);
            }

            const options = {
                method: 'get',
                headers: {
                    'Authorization': `APIKEY:DATA ${this.core.config.APIKey}`,
                    'Content-Type': 'application/json'
                }
            };

            fetch(path, options)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`remote variables request failed: HTTP ${response.status}`);
                    }
                    return response.json() as Promise<RemoteVariableCollection>;
                })
                .then(payload => resolve(payload))
                .catch(err => reject(err));
        });
    }
}

export default Network;