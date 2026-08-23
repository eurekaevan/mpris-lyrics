import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {createLyricsDocument} from '../lyrics-document.js';
import {
    OpenAITranslationProvider,
    TranslationProviderError,
} from '../translation-provider.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function response(lines) {
    return JSON.stringify({
        output: [{
            type: 'message',
            content: [{
                type: 'output_text',
                text: JSON.stringify({lines}),
            }],
        }],
    });
}

const lyrics = createLyricsDocument({
    source: 'test',
    metadata: {title: 'HTTP Test', artist: 'Fixture', language: 'en'},
    lines: [
        {text: 'Hello', startMs: 0, endMs: 1000},
        {text: 'Again', startMs: 1000, endMs: 2000},
    ],
});
const chunk = {
    index: 0,
    contextBefore: [],
    contextAfter: [],
    lines: lyrics.lines.map(line => ({id: line.lineId, text: line.text})),
};

const server = new Soup.Server();
let mode = 'success';
let requestCount = 0;
let observed = null;
server.add_handler(null, (_server, message) => {
    requestCount++;
    const body = new TextDecoder().decode(
        message.get_request_body().flatten().get_data());
    observed = {
        authorization: message.get_request_headers().get_one('Authorization'),
        userAgent: message.get_request_headers().get_one('User-Agent'),
        body: JSON.parse(body),
    };
    if (mode === 'rate-limit' && requestCount === 1) {
        message.set_status(429, null);
        message.get_response_headers().append('Retry-After', '0');
        return;
    }
    if (mode === 'authentication') {
        message.set_status(Soup.Status.UNAUTHORIZED, null);
        return;
    }
    message.set_status(Soup.Status.OK, null);
    let output;
    if (mode === 'malformed')
        output = '{bad json';
    else if (mode === 'unknown-id')
        output = response([{id: 'unknown', text: '错误'}]);
    else
        output = response(chunk.lines.map(line => ({
            id: line.id,
            text: `[zh-CN] ${line.text}`,
        })));
    message.set_response(
        'application/json',
        Soup.MemoryUse.COPY,
        new TextEncoder().encode(output));
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const endpoint = server.get_uris()[0].to_string().replace(/\/$/, '');

async function translate(provider) {
    return provider.translate(lyrics, {
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        credential: 'unit-test-token',
        chunk,
    }, null);
}

async function expectCode(callback, code, message) {
    let caught = null;
    try {
        await callback();
    } catch (error) {
        caught = error;
    }
    assert(caught instanceof TranslationProviderError && caught.code === code,
        message);
}

async function run() {
    let provider = new OpenAITranslationProvider({endpoint});
    let result = await translate(provider);
    assert(result.length === 2 && result[0].text === '[zh-CN] Hello' &&
        observed.authorization === 'Bearer unit-test-token' &&
        observed.userAgent.startsWith('MPRIS Lyrics/0.9.0') &&
        observed.body.store === false &&
        observed.body.text.format.type === 'json_schema' &&
        observed.body.text.format.strict === true &&
        !JSON.stringify(observed.body).includes('unit-test-token'),
    'the OpenAI provider should use authenticated strict structured output without putting the credential in JSON');
    provider.destroy();

    provider = new OpenAITranslationProvider({
        endpoint,
        maxResponseBytes: 64,
    });
    await expectCode(() => translate(provider), 'invalid_response',
        'an oversized translation response should be rejected');
    provider.destroy();

    mode = 'malformed';
    provider = new OpenAITranslationProvider({endpoint});
    await expectCode(() => translate(provider), 'invalid_response',
        'malformed JSON should be reported as an invalid response');
    provider.destroy();

    mode = 'unknown-id';
    provider = new OpenAITranslationProvider({endpoint});
    await expectCode(() => translate(provider), 'invalid_response',
        'unknown returned IDs should be rejected');
    provider.destroy();

    mode = 'authentication';
    provider = new OpenAITranslationProvider({endpoint});
    await expectCode(() => translate(provider), 'authentication_error',
        'bad credentials should have a distinct status');
    provider.destroy();

    mode = 'rate-limit';
    requestCount = 0;
    const started = GLib.get_monotonic_time();
    provider = new OpenAITranslationProvider({endpoint});
    result = await translate(provider);
    const elapsedMs = (GLib.get_monotonic_time() - started) / 1000;
    assert(result.length === 2 && requestCount === 2 && elapsedMs >= 900,
        'HTTP 429 should respect Retry-After and retry only after a delay');
    provider.destroy();
}

const loop = new GLib.MainLoop(null, false);
let scenarioError = null;
run().catch(error => (scenarioError = error)).finally(() => loop.quit());
loop.run();
server.disconnect();
if (scenarioError)
    throw scenarioError;

print('OpenAI translation HTTP contract, errors and 429 tests passed');
