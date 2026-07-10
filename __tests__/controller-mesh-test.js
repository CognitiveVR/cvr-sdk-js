/**
 * Unit coverage for ControllerInputTracker's mesh resolution (C3D-1726).
 *
 * `resolveControllerMesh` is rendering config only — it picks the dashboard mesh from raw
 * WebXR profiles and must NOT classify controller identity (that now rides on the raw
 * `inputProfiles` sent alongside). These tests lock in: correct handed mesh, specific-
 * before-generic profile matching, and the mesh-only `fallbackController` behavior.
 */
import { resolveControllerMesh } from '../src/utils/ControllerInputTracker';

// Silence the intentional "unrecognized profile" warnings for the fallback/unknown cases.
beforeAll(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterAll(() => console.warn.mockRestore());

test('resolves the handed mesh for a recognized profile', () => {
    expect(resolveControllerMesh(['meta-quest-touch-plus'], 'left')).toBe('QuestPlusTouchLeft');
    expect(resolveControllerMesh(['meta-quest-touch-plus'], 'right')).toBe('QuestPlusTouchRight');
});

test('matches more-specific profiles before their shorter substrings', () => {
    // 'oculus-touch-v3' must win over the bare 'oculus-touch' key.
    expect(resolveControllerMesh(['oculus-touch-v3'], 'left')).toBe('OculusQuestTouchLeft');
    expect(resolveControllerMesh(['oculus-touch'], 'left')).toBe('OculusRiftTouchLeft');
    // 'htc-vive-focus-3' must win over 'htc-vive'.
    expect(resolveControllerMesh(['htc-vive-focus-3'], 'right')).toBe('ViveFocusControllerRight');
    expect(resolveControllerMesh(['htc-vive'], 'right')).toBe('ViveController');
});

test('matches case-insensitively and ignores unrecognized companion profiles', () => {
    expect(resolveControllerMesh(['Valve-Index'], 'left')).toBe('SteamIndexLeft');
    expect(
        resolveControllerMesh(['meta-quest-touch-plus', 'generic-trigger-squeeze-thumbstick'], 'left'),
    ).toBe('QuestPlusTouchLeft');
});

test('falls back to the generic mesh for unrecognized profiles with no fallback', () => {
    expect(resolveControllerMesh(['some-unknown-controller'], 'left')).toBe('GenericController');
    expect(resolveControllerMesh([], 'right')).toBe('GenericController');
});

test('fallbackController selects a mesh (only) when profiles are unrecognized', () => {
    // A valid fallback key resolves to that controller's mesh...
    expect(resolveControllerMesh(['some-unknown'], 'right', 'valve-index')).toBe('SteamIndexRight');
    // ...but a fallback that is not itself a valid map key degrades to the generic mesh.
    expect(resolveControllerMesh(['some-unknown'], 'left', 'not-a-real-profile')).toBe('GenericController');
});
