import GLib from 'gi://GLib';

import {TranslationCredentialStore} from '../credentials.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const provider = `integration-test-${GLib.get_monotonic_time()}`;
const dummyCredential = 'mpris-lyrics-test-value';
const store = new TranslationCredentialStore();

let scenarioError = null;
const loop = new GLib.MainLoop(null, false);

async function run() {
    try {
        await store.store(provider, dummyCredential);
        assert(await store.isConfigured(provider),
            'the credential should be reported as configured');
        assert(await store.lookup(provider) === dummyCredential,
            'the credential should round-trip through Secret Service');
    } finally {
        await store.clear(provider);
    }
    assert(!await store.isConfigured(provider),
        'the integration credential should be removed after the test');
}

run().catch(error => (scenarioError = error)).finally(() => loop.quit());
loop.run();
if (scenarioError)
    throw scenarioError;

print('GNOME Secret Service credential store/lookup/clear test passed');
