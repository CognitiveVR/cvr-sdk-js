import crossFetch from 'cross-fetch';

interface NavigatorUAData {
    mobile: boolean;
    brands: Array<{ brand: string; version: string }>;
}

interface ExtendedNavigator extends Navigator {
    deviceMemory?: number;
    connection?: {
        effectiveType?: string;
        downlink?: number;
        rtt?: number;
        saveData?: boolean;
    };
    userAgentData?: NavigatorUAData;
}

export const isBrowser: boolean = typeof window !== 'undefined' && typeof document !== 'undefined';
export const isNode: boolean = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

export const safeWindowAccess = <T>(accessor: () => T, defaultValue: T): T => {
    if (!isBrowser) return defaultValue;
    try {
        return accessor();
    } catch (e) {
        console.warn('Error accessing window property:', e);
        return defaultValue;
    }
};

export const getDeviceMemory = (): number | null => safeWindowAccess(() => (navigator as ExtendedNavigator).deviceMemory ?? null, null);
export const getScreenHeight = (): number | null => safeWindowAccess(() => window.screen.height, null);
export const getScreenWidth = (): number | null => safeWindowAccess(() => window.screen.width, null);
export const getUserAgent = (): string => safeWindowAccess(() => navigator.userAgent, '');
export const getHardwareConcurrency = (): number | null => safeWindowAccess(() => navigator.hardwareConcurrency, null);
export const getConnection = (): ExtendedNavigator['connection'] | null => safeWindowAccess(() => (navigator as ExtendedNavigator).connection ?? null, null);

// Raw User-Agent Client Hints (low-entropy, no permission prompt). Sent verbatim so the
// pipeline — not the SDK — resolves browser/OS/device from them.
export const getUABrands = (): Array<{ brand: string; version: string }> | null =>
    safeWindowAccess(() => (navigator as ExtendedNavigator).userAgentData?.brands ?? null, null);
export const getUAMobile = (): boolean | null =>
    safeWindowAccess(() => (navigator as ExtendedNavigator).userAgentData?.mobile ?? null, null);

// Raw touch/pointer capability signals for phone/tablet/desktop disambiguation downstream.
export const getMaxTouchPoints = (): number | null =>
    safeWindowAccess(() => navigator.maxTouchPoints ?? null, null);
export const getPointerCoarse = (): boolean | null =>
    safeWindowAccess(() => window.matchMedia('(pointer: coarse)').matches, null);
export const getHoverHover = (): boolean | null =>
    safeWindowAccess(() => window.matchMedia('(hover: hover)').matches, null);

export interface GPUInfo { vendor: string; renderer: string; }

export const getGPUInfo = (): GPUInfo | null => {
    if (!isBrowser) return null;
    try {
        const canvas = document.createElement('canvas');
        const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext;
        if (!gl) return null;

        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (!debugInfo) return null;

        const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);

        return { vendor, renderer };
    } catch (e) {
        console.warn("WebGL is not supported", e);
    }
    return null;
};

export const fetch = crossFetch;