// Declare the global build variable injected by Rollup
declare const __SDK_VERSION__: string;

// Interface for a single scene's data
export interface SceneConfig {
    sceneName: string;
    sceneId: string;
    versionNumber: string;
}

// Interface for the settings object passed to the setter
export interface Settings {
    LOG?: boolean;
    SDKVersion?: string;
    networkHost?: string;
    APIKey?: string;
    networkVersion?: string;
    sensorDataLimit?: number;
    dynamicDataLimit?: number;
    customEventBatchSize?: number;
    gazeBatchSize?: number;
    GazeInterval?: number;
    
    HMDType?: string;
    gazeTrackingSource?: 'webxr' | 'engine';
    fallbackController?: string;
    autoFetchRemoteVariables?: boolean;
    enableRoomCapture?: boolean;
    roomDataLimit?: number;
    enableFixation?: boolean;
    fixationDataLimit?: number;
    fixationMinDurationMs?: number;
    fixationMaxAngle?: number;
    fixationMaxBlinkMs?: number;
    fixationSaccadeEndMs?: number;
    fixationMaxOffDynamicMs?: number;
    fixationDynamicSizeMultiplier?: number;
    fixationFocusSizeMultiplier?: number;
    allSceneData?: SceneConfig[];
    [key: string]: unknown;
}

class Config {
    public LOG: boolean;
    public SDKVersion: string;
    public networkHost: string;
    public APIKey: string;
    public networkVersion: string;
    public sensorDataLimit: number;
    public dynamicDataLimit: number;
    public customEventBatchSize: number;
    public gazeBatchSize: number;
    public GazeInterval: number;
    public allSceneData: SceneConfig[];
    
    public HMDType?: string;
    public gazeTrackingSource: 'webxr' | 'engine';
    public fallbackController?: string;
    public autoFetchRemoteVariables: boolean;
    public enableRoomCapture: boolean;
    public roomDataLimit: number;
    public enableFixation: boolean;
    public fixationDataLimit: number;
    public fixationMinDurationMs: number;
    public fixationMaxAngle: number;
    public fixationMaxBlinkMs: number;
    public fixationSaccadeEndMs: number;
    public fixationMaxOffDynamicMs: number;
    public fixationDynamicSizeMultiplier: number;
    public fixationFocusSizeMultiplier: number;
    [key: string]: any;

    constructor() {
        this.LOG = false;
        this.SDKVersion = typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : 'dev';
        
        this.networkHost = (process.env.NODE_ENV === 'production')
            ? 'data.cognitive3d.com'
            : 'data.c3ddev.com';
            
        this.APIKey = ''; 
        this.networkVersion = '0';
        this.sensorDataLimit = 512;
        this.dynamicDataLimit = 512;
        this.gazeTrackingSource = 'webxr';
        this.customEventBatchSize = 256;
        this.gazeBatchSize = 256;
        this.GazeInterval = 0.1;
        this.allSceneData = [];
        this.autoFetchRemoteVariables = false;
        this.enableRoomCapture = true;
        this.roomDataLimit = 64;
        this.enableFixation = true;
        this.fixationDataLimit = 256;
        this.fixationMinDurationMs = 60;
        this.fixationMaxAngle = 1;
        this.fixationMaxBlinkMs = 400;
        this.fixationSaccadeEndMs = 10;
        this.fixationMaxOffDynamicMs = 500;
        this.fixationDynamicSizeMultiplier = 1.25;
        this.fixationFocusSizeMultiplier = 2;
    }

    sceneData(sceneName: string, sceneId: string, versionNumber: string): SceneConfig {
        return {
            sceneName,
            sceneId,
            versionNumber
        };
    }

    set settings(settings: Settings) {
        if (settings.LOG !== undefined) this.LOG = settings.LOG;

        if (settings.HMDType !== undefined) {
            console.warn('C3D: the `HMDType` setting is deprecated and has no effect. HMD identity is derived from the raw c3d.device.xr.input_profiles device signal.');
        }

        // Map Settings keys to Config keys
        const keys: (keyof Settings)[] = [
            'SDKVersion', 'networkHost', 'APIKey', 'networkVersion',
            'sensorDataLimit', 'dynamicDataLimit', 'customEventBatchSize',
            'gazeBatchSize', 'GazeInterval', 'HMDType', 'allSceneData', 'gazeTrackingSource',
            'fallbackController',
            'autoFetchRemoteVariables', 'enableRoomCapture', 'roomDataLimit',
            'enableFixation', 'fixationDataLimit', 'fixationMinDurationMs',
            'fixationMaxAngle', 'fixationMaxBlinkMs', 'fixationSaccadeEndMs',
            'fixationMaxOffDynamicMs', 'fixationDynamicSizeMultiplier',
            'fixationFocusSizeMultiplier'
        ];

        for (const key of keys) {
            if (settings[key] !== undefined) {
                this[key] = settings[key];
            }
        }
    }
}

const defaultConfig = new Config();
export default defaultConfig;