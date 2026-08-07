/** @jest-environment jsdom */
import C3DAnalytics from '../lib/cjs/index.cjs.js';

const settings = {
    config: {
        APIKey: 'test-api-key',
        networkHost: 'data.cognitive3d.com',
        allSceneData: [
            { sceneName: 'BasicScene', sceneId: '93f486e4-0e22-4650-946a-e64ce527f915', versionNumber: '1' },
        ],
    },
};

const collection = {
    abTests: [
        { remoteVariableName: 'feature_flag', type: 'boolean', valueBoolean: true },
    ],
    remoteConfigurations: [
        { remoteVariableName: 'max_players', type: 'int', valueInt: 8 },
        { remoteVariableName: 'api_url', type: 'string', valueString: 'https://api.example.com' },
        { remoteVariableName: 'difficulty', type: 'int', valueInt: 3 },
    ],
};

function makeC3D() {
    const c3d = new C3DAnalytics(settings);
    c3d.core.resetNewUserDeviceProperties();
    c3d.core.setUserId = '';
    c3d.core.setDeviceId = 'test-device';
    return c3d;
}

test('getValue returns the supplied default before any fetch', () => {
    const c3d = makeC3D();
    expect(c3d.remoteVariables.hasFetchedVariables).toBe(false);
    expect(c3d.remoteVariables.getValue('feature_flag', false)).toBe(false);
    expect(c3d.remoteVariables.getValue('max_players', 4)).toBe(4);
    expect(c3d.remoteVariables.getValue('api_url', 'default')).toBe('default');
});

test('applyCollection resolves typed values and mirrors them as session properties', () => {
    const c3d = makeC3D();
    c3d.remoteVariables.applyCollection(collection);

    expect(c3d.remoteVariables.hasFetchedVariables).toBe(true);
    expect(c3d.remoteVariables.getValue('feature_flag', false)).toBe(true);
    expect(c3d.remoteVariables.getValue('max_players', 0)).toBe(8);
    expect(c3d.remoteVariables.getValue('api_url', '')).toBe('https://api.example.com');
    expect(c3d.remoteVariables.getValue('difficulty', 1.5)).toBe(3);
    expect(c3d.remoteVariables.getValue('does_not_exist', 'fallback')).toBe('fallback');

    const props = c3d.core.sessionProperties;
    expect(props['c3d.remote_variable.feature_flag']).toBe(true);
    expect(props['c3d.remote_variable.max_players']).toBe(8);
    expect(props['c3d.remote_variable.api_url']).toBe('https://api.example.com');
});

test('fetchVariables prefers the participant id and fires the availability callback', async () => {
    const c3d = makeC3D();
    c3d.core.setUserId = 'participant-123';

    let requestedId = null;
    c3d.remoteVariables.network = {
        networkRemoteVariablesGet: (id) => { requestedId = id; return Promise.resolve(collection); },
    };

    let notified = false;
    c3d.remoteVariables.onRemoteVariablesAvailable(() => { notified = true; });

    await expect(c3d.remoteVariables.fetchVariables()).resolves.toBe(true);
    expect(requestedId).toBe('participant-123');
    expect(notified).toBe(true);
    expect(c3d.remoteVariables.getValue('max_players', 0)).toBe(8);
});

test('fetchVariables falls back to the device id when no participant id is set', async () => {
    const c3d = makeC3D();
    let requestedId = null;
    c3d.remoteVariables.network = {
        networkRemoteVariablesGet: (id) => { requestedId = id; return Promise.resolve(collection); },
    };
    await c3d.remoteVariables.fetchVariables();
    expect(requestedId).toBe('test-device');
});

test('fetchVariables only hits the network once per session', async () => {
    const c3d = makeC3D();
    let calls = 0;
    c3d.remoteVariables.network = {
        networkRemoteVariablesGet: () => { calls += 1; return Promise.resolve(collection); },
    };
    await c3d.remoteVariables.fetchVariables();
    await c3d.remoteVariables.fetchVariables();
    expect(calls).toBe(1);
});