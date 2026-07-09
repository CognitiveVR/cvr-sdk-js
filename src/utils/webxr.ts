import Config from '../config';

/**
 * For data that can only be retrieved from an active webxr session, 
 * such as gaze data, and vr device information 
 */

// Define the structure for gaze hit result
export interface GazeHitData {
    objectId: string;
    point: number[];
}

type XRSessionModeValue = 'immersive-ar' | 'immersive-vr' | 'inline' | string;

// Dependencies interfaces
interface GazeTracker {
    recordGaze: (_position: number[], orientation: number[], gazeHitData: GazeHitData | number[] | null) => void;
}

interface DynamicObject {
    // Define properties if needed, currently unused in logic
}

export type GazeRaycaster = () => GazeHitData | null;

interface SessionStartResult {
    referenceSpace: XRReferenceSpace | null;
    referenceSpaceType: string | null;
    boundedReferenceSpace: XRReferenceSpace | null;
    sessionMode: XRSessionModeValue | null;
}

interface ReferenceSpaceResult {
    referenceSpace: XRReferenceSpace | null;
    type: string | null;
}


export class XRSessionManager {
  private gazeTracker: GazeTracker;
  private xrSession: XRSession;
  private dynamicObject: DynamicObject | null;
  private gazeRaycaster: GazeRaycaster | null;
  
  public referenceSpace: XRReferenceSpace | null;  // For gaze tracking (local-floor)
  public boundedReferenceSpace: XRReferenceSpace | null; // For boundary tracking (bounded-floor)
  public referenceSpaceType: string | null;
  public sessionMode: XRSessionModeValue | null;
  
  private isTracking: boolean;
  private animationFrameHandle: number | null;
  private lastUpdateTime: number;
  private interval: number;

  constructor(gazeTracker: GazeTracker, xrSession: XRSession, dynamicObject: DynamicObject | null = null, gazeRaycaster: GazeRaycaster | null = null) {
    this.gazeTracker = gazeTracker; 
    this.xrSession = xrSession; 
    this.dynamicObject = dynamicObject;
    this.gazeRaycaster = gazeRaycaster;
    this.referenceSpace = null;  // For gaze tracking (local-floor)
    this.boundedReferenceSpace = null; // For boundary tracking (bounded-floor)
    this.referenceSpaceType = null;
    this.sessionMode = null;
    this.isTracking = false; 
    this.animationFrameHandle = null;
    this.onXRFrame = this.onXRFrame.bind(this);
    this.lastUpdateTime = 0; 
    this.interval = 100; 
  }

  setGazeRaycaster(gazeRaycaster: GazeRaycaster | null): void {
      this.gazeRaycaster = gazeRaycaster;
  }

  async start(): Promise<SessionStartResult | null> {
      if (this.isTracking) return { 
          referenceSpace: this.referenceSpace, 
          referenceSpaceType: this.referenceSpaceType,
          boundedReferenceSpace: this.boundedReferenceSpace,
          sessionMode: this.sessionMode
      };

      this.sessionMode = getSessionMode(this.xrSession);

      const preferredReferenceSpaces = this.sessionMode === 'immersive-ar'
          ? ['local', 'local-floor']
          : ['local-floor', 'local'];

      const referenceSpaceResult = await this._requestFirstSupportedReferenceSpace(preferredReferenceSpaces);
      if (!referenceSpaceResult.referenceSpace) {
          console.error('Cog3D-XR-Session-Manager: Failed to get reference space for gaze.');
          return null;
      }

      this.referenceSpace = referenceSpaceResult.referenceSpace;
      this.referenceSpaceType = referenceSpaceResult.type;
      console.log(`Cog3D-XR-Session-Manager: Using "${this.referenceSpaceType}" for ${this.sessionMode || 'xr'} gaze tracking.`);

      // 2. Try to get bounded-floor for boundary tracking (optional)
      if (this.sessionMode !== 'immersive-ar') {
          try {
              this.boundedReferenceSpace = await this.xrSession.requestReferenceSpace('bounded-floor');
              console.log('Cog3D-XR-Session-Manager: "bounded-floor" available for boundary tracking.');
          } catch (error) {
              console.warn('Cog3D-XR-Session-Manager: "bounded-floor" not available. Boundary tracking disabled.', error);
              this.boundedReferenceSpace = null;
          }
      } else {
          this.boundedReferenceSpace = null;
          console.log('Cog3D-XR-Session-Manager: Skipping bounded-floor lookup for immersive-ar session.');
      }
      
      this.isTracking = true;
      this.animationFrameHandle = this.xrSession.requestAnimationFrame(this.onXRFrame);
      console.log('Cog3D-XR-Session-Manager: Gaze tracking started.');
      
      return {
          referenceSpace: this.referenceSpace,  // local-floor for gaze
          referenceSpaceType: this.referenceSpaceType,
          boundedReferenceSpace: this.boundedReferenceSpace,  // bounded-floor for boundaries
          sessionMode: this.sessionMode
      };
  }

  private async _requestFirstSupportedReferenceSpace(candidates: string[]): Promise<ReferenceSpaceResult> {
      for (const candidate of candidates) {
          try {
              const referenceSpace = await this.xrSession.requestReferenceSpace(candidate as XRReferenceSpaceType);
              return {
                  referenceSpace,
                  type: candidate
              };
          } catch (error) {
              console.warn(`Cog3D-XR-Session-Manager: "${candidate}" not supported. Trying next reference space.`, error);
          }
      }

      return {
          referenceSpace: null,
          type: null
      };
  }
  
  onXRFrame(timestamp: number, frame: XRFrame): void { 
    if (!this.isTracking) return;

    // ONLY process hardware gaze if configured to use WebXR directly
    if (Config.gazeTrackingSource === 'webxr') {
        const configIntervalMs = Config.GazeInterval ? Config.GazeInterval * 1000 : this.interval;
        if (timestamp - this.lastUpdateTime >= configIntervalMs) {
            this.lastUpdateTime = timestamp;
            if(!this.referenceSpace) return;

            const viewerPose = frame.getViewerPose(this.referenceSpace); 

            if (viewerPose) {
                const { position, orientation } = viewerPose.transform;
                
                let gazeHitData: GazeHitData | null = null;
                if (this.gazeRaycaster) {
                    gazeHitData = this.gazeRaycaster();
                }

                const correctedPosition = [position.x, position.y, -position.z];
                const correctedOrientation = [orientation.x, orientation.y, -orientation.z, -orientation.w];

                this.gazeTracker.recordGaze(
                    correctedPosition,
                    correctedOrientation,
                    gazeHitData
                );
            }
        }
    }
    
    this.animationFrameHandle = this.xrSession.requestAnimationFrame(this.onXRFrame); 
  }
  
  stop(): void { 
    if (!this.isTracking) return;

    this.isTracking = false;
    if (this.animationFrameHandle) {
      this.xrSession.cancelAnimationFrame(this.animationFrameHandle);
    }
    this.referenceSpace = null;
    this.referenceSpaceType = null;
    this.boundedReferenceSpace = null;
    this.sessionMode = null;
    console.log('Cog3D-XR-Session-Manager: Gaze tracking stopped.');
  }
}

export const getSessionMode = (xrSession: XRSession): XRSessionModeValue | null => {
    const sessionWithMode = xrSession as unknown as { mode?: XRSessionModeValue };
    return sessionWithMode.mode || null;
};

export const hasTrackedControllers = (inputSources: XRInputSourceArray | XRInputSource[]): boolean => {
    for (const source of inputSources) {
        if (!source.hand && source.targetRayMode === 'tracked-pointer' && source.gripSpace) {
            return true;
        }
    }
    return false;
};

// Raw WebXR input profiles (e.g. "meta-quest-touch-plus") flattened and de-duplicated
// across all input sources. Returned verbatim as the device's hardware fingerprint — the
// pipeline (not the SDK) resolves HMD/controller identity from these strings.
export const getInputProfiles = (inputSources: XRInputSourceArray | XRInputSource[]): string[] => {
    const profiles = new Set<string>();
    for (const source of inputSources) {
        if (!source.profiles) continue;
        for (const profile of source.profiles) {
            profiles.add(profile);
        }
    }
    return Array.from(profiles);
};

export const getEnabledFeatures = (xrSession: XRSession): { handTracking: boolean; eyeTracking: boolean } => {
    // Safely access 'enabledFeatures' by casting to unknown first.
    // Prevents build errors if the standard XRSession type definition is missing this property.
    const sessionWithFeatures = xrSession as unknown as { enabledFeatures?: string[] };
    const enabledFeatures = sessionWithFeatures.enabledFeatures || [];

    const handTracking = enabledFeatures.includes('hand-tracking');
    const eyeTracking = enabledFeatures.includes('eye-tracking');

    console.log(`Cog3D-XR-Session-Manager: Hand Tracking feature is ${handTracking ? 'enabled' : 'disabled'}.`);
    console.log(`Cog3D-XR-Session-Manager: Eye Tracking feature is ${eyeTracking ? 'enabled' : 'disabled'}.`);

    return {
        handTracking,
        eyeTracking
    };
};
