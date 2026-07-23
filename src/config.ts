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
    /** @deprecated No longer has any effect; see GazeTracker.setHMDType. */
    HMDType?: string;
    gazeTrackingSource?: 'webxr' | 'engine';
    fallbackController?: string;
    allSceneData?: SceneConfig[];
    [key: string]: unknown; // Allow flexibility
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
    /** @deprecated No longer has any effect; retained for backward compatibility. */
    public HMDType?: string;
    public gazeTrackingSource: 'webxr' | 'engine';
    public fallbackController?: string;
    [key: string]: any; // Index signature for dynamic access in setter

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
    }

    sceneData(sceneName: string, sceneId: string, versionNumber: string): SceneConfig {
        return {
            sceneName,
            sceneId,
            versionNumber
        };
    }

    /**
     * Setter to apply bulk settings
     */
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
            'fallbackController'
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