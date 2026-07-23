import coreInstance, { CognitiveVRAnalyticsCore, SessionProperties } from './core';
import GazeTracker from './gazetracker';
import CustomEvent from './customevent';
import Network from './network';
import Sensor from './sensors';
import ExitPoll from './exitpoll';
import DynamicObject from './dynamicobject';
import FPSTracker, { FPSMetrics } from './utils/Framerate';
import HMDOrientationTracker, { OrientationData } from './utils/HMDOrientation';
import Profiler from './utils/Profiler';
import ControllerTracker from './utils/ControllerTracker';
import ControllerInputTracker from './utils/ControllerInputTracker';
import FingerprintJS from '@fingerprintjs/fingerprintjs';
import BoundaryTracker from './utils/BoundaryTracker';
import { Settings, SceneConfig } from './config';

import {
  getDeviceMemory,
  getScreenHeight,
  getScreenWidth,
  getHardwareConcurrency,
  getConnection,
  getGPUInfo,
  getUserAgent,
  getUABrands,
  getUAMobile,
  getMaxTouchPoints,
  getPointerCoarse,
  getHoverHover,
  isBrowser
} from './utils/environment';

import {
  XRSessionManager,
  getInputProfiles,
  getEnabledFeatures,
  hasTrackedControllers,
  XRSessionManager as XRSessionManagerType,
  GazeHitData
} from './utils/webxr';

interface C3DConstructorSettings {
    config: Settings;
}

class C3D {
  private static readonly DEVICE_ID_WAIT_TIMEOUT_MS = 3000;
  public core: CognitiveVRAnalyticsCore;
  public xrSessionManager: XRSessionManagerType | null;
  public lastInputType: 'none' | 'hand' | 'controller';
  public network: Network;
  public gaze: GazeTracker;
  public customEvent: CustomEvent;
  public hmdOrientation: HMDOrientationTracker;
  public profiler: Profiler;
  public controllerTracker: ControllerTracker;
  public controllerInputTracker: ControllerInputTracker;
  public sensor: Sensor;
  public exitpoll: ExitPoll;
  public dynamicObject: DynamicObject;
  public fpsTracker: FPSTracker;
  public adapterManagesFPS: boolean = false;
  public renderer: any;    // Supports multiple engines (Three, Babylon, WLE) without shared interfaces
  public boundaryTracker: BoundaryTracker;
  private deviceIdPromise: Promise<void> | null = null;
  private _gazeRaycaster: (() => GazeHitData | null) | null;

  constructor(settings?: C3DConstructorSettings, renderer: any = null) { 
    this.core = coreInstance;
    
    if (settings) { 
        this.core.config.settings = settings.config; 
    }

    this.xrSessionManager = null; 
    this._gazeRaycaster = null;

    this.setUserProperty("c3d.version", this.core.config.SDKVersion);
    this.lastInputType = 'none';

    // Identify the SDK, and default the engine for adapter-less ("plain core") usage.
    // Engine adapters (Three.js / Babylon / PlayCanvas / Wonderland) overwrite c3d.app.engine
    // via setDeviceProperty in their startTracking(), so this default only persists when no
    // adapter is used. The pipeline's enrichment layer treats c3d.app.engine as a required
    // core prop and drops sessions that omit it, so adapter-less sessions need a default here.
    this.setDeviceProperty('SDKType', 'WebXR');
    this.setDeviceProperty('AppEngine', 'WebXR');
    
    // Explicitly cast to unknown first to avoid circular type issues if strictly typed in deps
    const self = this as unknown as any; 
    
    // @ts-ignore
    this.network = new Network(this.core);
    this.gaze = new GazeTracker(this.core);
    this.customEvent = new CustomEvent(this.core);
    this.hmdOrientation = new HMDOrientationTracker();
    this.profiler = new Profiler(self);
    this.controllerTracker = new ControllerTracker(self);
    this.controllerInputTracker = new ControllerInputTracker(self, this.core.config.fallbackController);
    this.sensor = new Sensor(this.core);
    this.exitpoll = new ExitPoll(this.core, this.customEvent);
    this.dynamicObject = new DynamicObject(this.core, this.customEvent);
    this.fpsTracker = new FPSTracker(); 
    this.renderer = renderer; 
    this.boundaryTracker = new BoundaryTracker(self);

    // Initialize FingerprintJS in the background
    if (isBrowser) {
        this.deviceIdPromise = this.initializeDeviceId();
    }

    const deviceMemory = getDeviceMemory();
    if (deviceMemory) {
      // MB (legacy convention, no unit in key name; the pipeline normalizes on this). Kept for continuity.
      this.setDeviceProperty('DeviceMemory', deviceMemory * 1000);
      // Raw navigator.deviceMemory (GB), unit encoded in the key name.
      this.setDeviceProperty('DeviceMemoryGB', deviceMemory);
    }

    const screenHeight = getScreenHeight();
    if (screenHeight) {
      this.setDeviceProperty('DeviceScreenHeight', screenHeight);
    }

    const screenWidth = getScreenWidth();
    if (screenWidth) {
      this.setDeviceProperty('DeviceScreenWidth', screenWidth);
    }

    const hardwareConcurrency = getHardwareConcurrency();
    if (hardwareConcurrency) {
      this.setDeviceProperty('DeviceCPUCores', hardwareConcurrency);
    }

    const connection = getConnection();
    if (connection) {
        this.setDeviceProperty('NetworkEffectiveType', connection.effectiveType);
        this.setDeviceProperty('NetworkDownlink', connection.downlink);
        this.setDeviceProperty('NetworkRTT', connection.rtt);
    }
    const gpuInfo = getGPUInfo();
    if (gpuInfo) {
      this.setDeviceProperty('DeviceGPU', gpuInfo.renderer);
      this.setDeviceProperty('DeviceGPUVendor', gpuInfo.vendor);
    }

    // Raw device-identity signals for pipeline-side resolution (SDK does no classification).
    // Booleans/numbers are gated on `!== null` so meaningful falsy values (false, 0) are still sent.
    const userAgent = getUserAgent();
    if (userAgent) {
      this.setDeviceProperty('UserAgent', userAgent);
    }

    const uaBrands = getUABrands();
    if (uaBrands) {
      // Serialize to a JSON string: the ingestion pipeline drops array/object-valued session
      // properties (verified), so the raw brands array must be sent as a scalar to land. The
      // full raw data is preserved and the pipeline can JSON.parse or substring-match it.
      this.setDeviceProperty('UABrands', JSON.stringify(uaBrands));
    }

    const uaMobile = getUAMobile();
    if (uaMobile !== null) {
      this.setDeviceProperty('UAMobile', uaMobile);
    }

    const maxTouchPoints = getMaxTouchPoints();
    if (maxTouchPoints !== null) {
      this.setDeviceProperty('DeviceMaxTouchPoints', maxTouchPoints);
    }

    const pointerCoarse = getPointerCoarse();
    if (pointerCoarse !== null) {
      this.setDeviceProperty('DevicePointerCoarse', pointerCoarse);
    }

    const hoverHover = getHoverHover();
    if (hoverHover !== null) {
      this.setDeviceProperty('DeviceHoverHover', hoverHover);
    }
  }

  get gazeRaycaster(): (() => GazeHitData | null) | null {
    return this._gazeRaycaster;
  }

  set gazeRaycaster(value: (() => GazeHitData | null) | null) {
    this._gazeRaycaster = value;
    if (this.xrSessionManager) {
      this.xrSessionManager.setGazeRaycaster(value);
    }
  }

  private async initializeDeviceId(): Promise<void> {
    try {
        const fp = await FingerprintJS.load();
        const result = await fp.get();
        
        this.core.setDeviceId = result.visitorId;
        this.setSessionProperty("c3d.deviceid", result.visitorId); 
        this.setSessionProperty("c3d.deviceid.confidence", result.confidence.score);
    } catch (error) {
        console.warn('FingerprintJS failed:', error);
    }
  }

  private async waitForDeviceId(): Promise<void> {
    if (!this.deviceIdPromise) {
      return;
    }

    let didTimeout = false;

    await Promise.race([
      this.deviceIdPromise,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          didTimeout = true;
          resolve();
        }, C3D.DEVICE_ID_WAIT_TIMEOUT_MS);
      }),
    ]);

    if (didTimeout) {
      console.warn(
        `C3D: Device fingerprint initialization exceeded ${C3D.DEVICE_ID_WAIT_TIMEOUT_MS}ms. Continuing session startup without waiting for it.`,
      );
    }
  }

  async startSession(xrSession: XRSession | null = null): Promise<boolean> {
    if (this.core.isSessionActive) { return false; }

    if (this.deviceIdPromise) {
      await this.waitForDeviceId();
    }
  
    if (this.renderer) { 
      this.profiler.start(this.renderer);
    }
    if (!this.adapterManagesFPS) {
      this.fpsTracker.start((metrics: FPSMetrics) => {
        this.sensor.recordSensor('c3d.fps.avg', metrics.avg);
        this.sensor.recordSensor('c3d.fps.1pl', metrics['1pl']);
      });
    }

    if (xrSession) {  
      this.xrSessionManager = new XRSessionManager(this.gaze, xrSession, this.dynamicObject, this.gazeRaycaster);
      
      let sessionInfo = null;
      try {
        sessionInfo = await this.xrSessionManager.start();
      } catch (e) {
        console.error("C3D: Failed to start XRSessionManager. Gaze tracking may be disabled.", e);
      }

      this.controllerTracker.start(xrSession);
      this.controllerInputTracker.start(xrSession);

      if (sessionInfo && sessionInfo.boundedReferenceSpace) {
          this.boundaryTracker.start(xrSession, sessionInfo.boundedReferenceSpace);
          console.log('C3D: Boundary tracking started with bounded-floor reference space');
      } else {
          console.warn('C3D: Boundary tracking not available');
      }

      const referenceSpace = sessionInfo ? sessionInfo.referenceSpace : null;
      const sessionMode = sessionInfo ? sessionInfo.sessionMode : null;
      const referenceSpaceType = sessionInfo ? sessionInfo.referenceSpaceType : null;

      if (sessionMode) {
        this.setSessionProperty('c3d.session.xr.mode', sessionMode);
      }
      if (referenceSpaceType) {
        this.setSessionProperty('c3d.session.xr.reference_space', referenceSpaceType);
      }
      this.setSessionProperty('c3d.session.xr.boundary_available', Boolean(sessionInfo && sessionInfo.boundedReferenceSpace));
      this.setSessionProperty('c3d.device.controllerinputs.enabled', hasTrackedControllers(xrSession.inputSources));

      if (referenceSpace) {
        this.hmdOrientation.start(
          xrSession,
          referenceSpace,
          (orientation: OrientationData) => {
            this.sensor.recordSensor('c3d.hmd.pitch', orientation.pitch);
            this.sensor.recordSensor('c3d.hmd.yaw', orientation.yaw);
          }
        );
      } else {
        console.warn('C3D: Could not start HMD orientation tracking, no reference space available.');
      }
      
      const features = getEnabledFeatures(xrSession);
      this.setDeviceProperty("HandTracking", features.handTracking);
      this.setDeviceProperty("EyeTracking", features.eyeTracking);
      if (features.handTracking) {
          this.setSessionProperty("c3d.app.handtracking.enabled", true);
      }
    }
    else{
        console.warn("C3D: No XR session was provided. Gaze data will not be tracked.");
    }

    if (xrSession && xrSession.inputSources) {
        // Raw input profiles replace the removed classified c3d.device.hmd.type / c3d.device.vendor.
        // Two things to get right:
        //  1. Accumulate the UNION of every profile seen across the session, not just the currently-
        //     connected sources — controllers churn mid-session (sleep, lose tracking, or the user
        //     switches to hand-tracking), and overwriting would erase the headset's hardware fingerprint.
        //  2. Send it as a comma-joined STRING, not an array: the ingestion pipeline drops array-valued
        //     session properties (verified), so an array would silently never reach the backend. Profile
        //     ids contain no commas, and the pipeline substring-matches this string.
        const seenInputProfiles = new Set<string>();
        const recordInputProfiles = (inputSources: XRInputSourceArray | XRInputSource[]) => {
            for (const profile of getInputProfiles(inputSources)) {
                seenInputProfiles.add(profile);
            }
            this.setDeviceProperty('XRInputProfiles', Array.from(seenInputProfiles).join(','));
        };
        recordInputProfiles(xrSession.inputSources);

        xrSession.addEventListener('inputsourceschange', (event: XRInputSourcesChangeEvent) => {
            // @ts-ignore
            const xrEvent = event as XRInputSourcesChangeEvent;
            this.setSessionProperty('c3d.device.controllerinputs.enabled', hasTrackedControllers(xrEvent.session.inputSources));
            recordInputProfiles(xrEvent.session.inputSources);
        });
    }

    this.core.setSessionStatus = true;
    this.core.getSessionTimestamp();
    this.core.getSessionId();
    this.customEvent.send('Session Start', [0, 0, 0]);
    return true;
  }
  
  endSession(): Promise<number | string> {
    return new Promise((resolve, reject) => {
      if (!this.core.isSessionActive) {
        reject('session is not active');
        return;
      }
      this.fpsTracker.stop();  
      this.adapterManagesFPS = false;
      this.profiler.stop();
      if (this.hmdOrientation) {
          this.hmdOrientation.stop();
      }
      
      if (this.controllerTracker) {
          this.controllerTracker.stop();
      }
      if (this.controllerInputTracker) {
          this.controllerInputTracker.stop();
      }
      if (this.boundaryTracker) {
          this.boundaryTracker.stop(); 
      }      
      if (this.xrSessionManager) {
          this.xrSessionManager.stop();
          this.xrSessionManager = null;
      }
      
      const props: Record<string, any> = {};
      const endPos = [0, 0, 0];
      const sessionLength = this.core.getTimestamp() - (this.core.sessionTimestamp as number);
      props['sessionlength'] = sessionLength;
      props['Reason'] = "User exited the application";

      this.customEvent.send('c3d.sessionEnd', endPos, props);

      this.sendData()
        .then(res => {
          this.core.setSessionTimestamp = 0;
          this.core.setSessionId = '';
          this.core.setSessionStatus = false;
          this.core.resetNewUserDeviceProperties();

          this.gaze.endSession();
          this.customEvent.endSession();
          this.sensor.endSession();
          this.dynamicObject.endSession();

          resolve(res);
        })
        .catch(err => reject(err));
    });
  }

  getCurrentInputType(): 'hand' | 'controller' | 'none' {
      return this.lastInputType;
  }

  getXRSessionMode(): string | null {
      return this.xrSessionManager ? this.xrSessionManager.sessionMode : null;
  }

  getXRReferenceSpaceType(): string | null {
      return this.xrSessionManager ? this.xrSessionManager.referenceSpaceType : null;
  }

  isARSession(): boolean {
      return this.getXRSessionMode() === 'immersive-ar';
  }

  isVRSession(): boolean {
      return this.getXRSessionMode() === 'immersive-vr';
  }

  sceneData(name: string, id: string, version: string): SceneConfig {
    return this.core.getSceneData(name, id, version);
  }

  config(property: keyof Settings, value: unknown): void { 
    // @ts-ignore: Dynamic config assignment
    this.core.config[property] = value;
  }

  addToAllSceneData(scene: SceneConfig): void {
    this.core.config.allSceneData.push(scene);
  }

  setScene(name: string): void {
    console.log(`CognitiveVRAnalytics::SetScene: ${name}`);
    if (this.core.sceneData.sceneId) {
      this.sendData();
      this.dynamicObject.refreshObjectManifest();
    }

    if (this.boundaryTracker) {
        this.boundaryTracker.forceBoundaryUpdate();
    }

    this.core.setScene(name);
  }

  set allSceneData(allSceneData: SceneConfig[]) {
    this.core.config.allSceneData = allSceneData;
  }

   sendData(): Promise<number | string> {
    return new Promise((resolve, reject) => {
      if (!this.core.isSessionActive) {
        resolve("Cognitive3DAnalyticsCore::SendData failed: no session active");
        return;
      }
      
      if (!this.core.sceneData.sceneId) { 
        reject('no scene selected'); 
        return;
      }

      const custom = this.customEvent.sendData();
      const gaze = this.gaze.sendData();
      const sensor = this.sensor.sendData();
      const dynamicObject = this.dynamicObject.sendData();

      Promise.all([custom, gaze, sensor, dynamicObject])
        .then(() => resolve(200))
        .catch(err => reject(err));
    });
  }

  isSessionActive(): boolean { return this.core.isSessionActive; }
  wasInitSuccessful(): boolean { return this.core.isSessionActive; }
  getSessionTimestamp(): number | string { return this.core.getSessionTimestamp(); }
  getSessionId(): string { return this.core.getSessionId(); }

  getUserProperties(): Record<string, any> { 
    const allProps = this.core.sessionProperties || {};
    const userProps: Record<string, any> = {}; 
    const deviceKeys = new Set(Object.values(this.core.devicePropertyMap));
    deviceKeys.add('c3d.device.name'); 

    for (const key in allProps) {
        if (!deviceKeys.has(key) && !key.startsWith('c3d.session.') && !key.startsWith('c3d.cohort.') && !key.startsWith('c3d.experiment.') && !key.startsWith('c3d.trial.') && !key.startsWith('c3d.participant.')) {
            userProps[key] = allProps[key];
        }
    }
    const participantPrefix = 'c3d.participant.';
    for (const key in allProps) {
        if (key.startsWith(participantPrefix)) {
             userProps[key.substring(participantPrefix.length)] = allProps[key];
        }
    }
     if (allProps['c3d.name']) {
        userProps['c3d.name'] = allProps['c3d.name'];
     }
    return userProps;
  }

  getDeviceProperties(): Record<string, any> { 
    const allProps = this.core.sessionProperties || {};
    const deviceProps: Record<string, any> = {};
    const deviceKeys = new Set(Object.values(this.core.devicePropertyMap));
    deviceKeys.add('c3d.device.name'); 

    for (const key in allProps) {
        if (deviceKeys.has(key)) {
            deviceProps[key] = allProps[key];
        }
    }
    return deviceProps;
  }

  set userId(userId: string) { this.core.setUserId = userId; }
  
  setUserProperty(propertyOrObject: string | Record<string, any>, value?: any): void {
      if (typeof propertyOrObject === 'object') {
          Object.entries(propertyOrObject).forEach(([key, val]) => this.core.setUserProperty(key, val));
      } else if (typeof propertyOrObject === 'string' && value !== undefined) {
          this.core.setUserProperty(propertyOrObject, value);
      }
  }

  setParticipantFullName(name: string): void { this.core.setUserId = name; this.setUserProperty('c3d.name', name); }
  setParticipantId(id: string): void { this.core.setUserId = id; this.setParticipantProperty('id', id); }
  setSessionName(name: string): void { this.setUserProperty('c3d.sessionname', name); }
  setAppVersion(version: string): void { this.setDeviceProperty('AppVersion', version); }
  setLobbyId(id: string): void { this.core.setLobbyId(id); }
  setDeviceName(name: string): void { this.core.setDeviceId = name; this.core.setSessionProperty('c3d.device.name', name); }

  setDeviceProperty(propertyOrObject: string | Record<string, any>, value?: any): void {
      if (typeof propertyOrObject === 'object') {
          Object.entries(propertyOrObject).forEach(([key, val]) => this.core.setDeviceProperty(key, val));
      } else if (typeof propertyOrObject === 'string' && value !== undefined) {
          this.core.setDeviceProperty(propertyOrObject, value);
      }
  }

  setSessionProperty(propertyOrObject: string | Record<string, any>, value?: any): void {
    if (typeof propertyOrObject === 'object') {
        Object.entries(propertyOrObject).forEach(([key, val]) => this.core.setSessionProperty(key, val));
    } else if (typeof propertyOrObject === 'string' && value !== undefined) {
        this.core.setSessionProperty(propertyOrObject, value);
    }
  }
  setParticipantProperty(key: string, value: any): void { this.setSessionProperty('c3d.participant.' + key, value); }
  setParticipantProperties(obj: Record<string, any>): void { Object.entries(obj).forEach(([key, value]) => this.setParticipantProperty(key, value)); }
  setSessionTag(tag: string, value: boolean = true): void { if (typeof tag !== 'string' || tag.length === 0 || tag.length > 12) return; this.setSessionProperty('c3d.sessiontag.' + tag, value); }
  set deviceId(deviceId: string) { this.core.setDeviceId = deviceId; }
  getApiKey(): string { return this.core.getApiKey(); }
  getSceneId(): string { return this.core.sceneData.sceneId; }
}

export default C3D;
