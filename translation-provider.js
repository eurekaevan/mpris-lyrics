import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {validateTranslationLines} from './translation-document.js';

export const OPENAI_PROVIDER_ID = 'openai';
export const OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17';
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const USER_AGENT = 'MPRIS Lyrics/0.9.0 (mpris-lyrics@eureka)';
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

Gio._promisify(Gio.InputStream.prototype,
    'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype,
    'close_async', 'close_finish');
Gio._promisify(Soup.Session.prototype,
    'send_async', 'send_finish');

class ResponseTooLargeError extends Error {}

async function readResponse(session, message, limit, cancellable) {
    const stream = await session.send_async(
        message, GLib.PRIORITY_DEFAULT, cancellable);
    try {
        if (message.status_code < 200 || message.status_code >= 300)
            return GLib.Bytes.new(new Uint8Array());

        const contentLength = message.get_response_headers()
            .get_content_length();
        if (contentLength > limit)
            throw new ResponseTooLargeError();

        const chunks = [];
        let total = 0;
        while (true) {
            const bytes = await stream.read_bytes_async(
                READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, cancellable);
            const size = bytes.get_size();
            if (size === 0)
                break;
            total += size;
            if (total > limit)
                throw new ResponseTooLargeError();
            chunks.push(bytes.get_data());
        }

        const contents = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            contents.set(chunk, offset);
            offset += chunk.length;
        }
        return GLib.Bytes.new(contents);
    } finally {
        try {
            await stream.close_async(GLib.PRIORITY_DEFAULT, null);
        } catch {
            // The request error is more useful than a stream-close error.
        }
    }
}

export class TranslationProviderError extends Error {
    constructor(code, message, retryAfterMs = null) {
        super(message);
        this.name = 'TranslationProviderError';
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
}

export function translationRetryAfterMs(value, now = Date.now()) {
    if (typeof value !== 'string' || !value.trim())
        return 5000;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.max(1000, Math.ceil(seconds * 1000));
    const date = Date.parse(value);
    if (Number.isFinite(date))
        return Math.max(1000, date - now);
    return 5000;
}

function canceledError() {
    return new TranslationProviderError('canceled', 'Translation canceled');
}

function delay(milliseconds, cancellable) {
    if (cancellable?.is_cancelled())
        return Promise.reject(canceledError());

    return new Promise((resolve, reject) => {
        let signalId = 0;
        let timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(milliseconds)),
            () => {
                timerId = 0;
                if (signalId) {
                    cancellable.disconnect(signalId);
                    signalId = 0;
                }
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        if (cancellable) {
            signalId = cancellable.connect(() => {
                if (timerId) {
                    GLib.source_remove(timerId);
                    timerId = 0;
                }
                if (signalId) {
                    cancellable.disconnect(signalId);
                    signalId = 0;
                }
                reject(canceledError());
            });
        }
    });
}

function outputText(response) {
    if (!response || !Array.isArray(response.output))
        throw new TranslationProviderError(
            'invalid_response', 'Provider response has no output');

    const parts = [];
    for (const output of response.output) {
        if (output?.type !== 'message' || !Array.isArray(output.content))
            continue;
        for (const content of output.content) {
            if (content?.type === 'refusal') {
                throw new TranslationProviderError(
                    'provider_error', 'Provider refused the translation');
            }
            if (content?.type === 'output_text' && typeof content.text === 'string')
                parts.push(content.text);
        }
    }
    if (parts.length === 0)
        throw new TranslationProviderError(
            'invalid_response', 'Provider response contains no text');
    return parts.join('');
}

function responseSchema(ids) {
    return {
        type: 'object',
        properties: {
            lines: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: {type: 'string', enum: ids},
                        text: {type: 'string'},
                    },
                    required: ['id', 'text'],
                    additionalProperties: false,
                },
            },
        },
        required: ['lines'],
        additionalProperties: false,
    };
}

function requestBody(document, options, model) {
    const input = {
        title: document.metadata?.title ?? '',
        artist: document.metadata?.artist ?? '',
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        contextBefore: options.chunk.contextBefore.map(line => line.text),
        lines: options.chunk.lines,
        contextAfter: options.chunk.contextAfter.map(line => line.text),
    };
    const ids = options.chunk.lines.map(line => line.id);
    return {
        model,
        store: false,
        reasoning: {effort: 'none'},
        instructions: [
            'Translate song lyrics into the requested target language.',
            'Use the full supplied context to preserve meaning and repeated lines.',
            'Write concise, natural lyrics. Do not censor, embellish, or explain.',
            'Never alter IDs. Return only the requested lines as structured JSON.',
            'Do not add timestamps. Preserve non-lyric semantics when present.',
        ].join(' '),
        input: JSON.stringify(input),
        text: {
            format: {
                type: 'json_schema',
                name: 'lyrics_translation',
                strict: true,
                schema: responseSchema(ids),
            },
        },
        max_output_tokens: 12_000,
    };
}

export class OpenAITranslationProvider {
    constructor({
        endpoint = OPENAI_RESPONSES_URL,
        model = OPENAI_MODEL,
        timeoutSeconds = 45,
        maxResponseBytes = MAX_RESPONSE_BYTES,
    } = {}) {
        this.id = OPENAI_PROVIDER_ID;
        this.displayName = 'OpenAI';
        this.model = model;
        this.requiresCredential = true;
        this._endpoint = endpoint;
        this._maxResponseBytes = Math.max(1, Math.floor(maxResponseBytes));
        this._session = new Soup.Session({
            timeout: timeoutSeconds,
            'idle-timeout': timeoutSeconds,
            'user-agent': USER_AGENT,
        });
    }

    async translate(document, options, cancellable) {
        return this._request(document, options, cancellable, 0);
    }

    async _request(document, options, cancellable, attempt) {
        if (cancellable?.is_cancelled())
            throw canceledError();

        const message = Soup.Message.new('POST', this._endpoint);
        if (!message)
            throw new TranslationProviderError(
                'provider_error', 'Translation endpoint is invalid');
        message.get_request_headers().append(
            'Authorization', `Bearer ${options.credential}`);
        const encoded = new TextEncoder().encode(JSON.stringify(
            requestBody(document, options, this.model)));
        message.set_request_body_from_bytes(
            'application/json', GLib.Bytes.new(encoded));

        let bytes;
        try {
            bytes = await readResponse(this._session, message,
                this._maxResponseBytes, cancellable);
        } catch (error) {
            if (cancellable?.is_cancelled() ||
                error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw canceledError();
            if (error instanceof ResponseTooLargeError) {
                throw new TranslationProviderError(
                    'invalid_response',
                    'Translation response exceeded the size limit');
            }
            throw new TranslationProviderError(
                'network_error', 'Translation network request failed');
        }

        const status = message.status_code;
        if (status === 429) {
            const retryAfterMs = translationRetryAfterMs(
                message.get_response_headers().get_one('Retry-After'));
            if (attempt < MAX_RATE_LIMIT_RETRIES) {
                await delay(retryAfterMs, cancellable);
                return this._request(
                    document, options, cancellable, attempt + 1);
            }
            throw new TranslationProviderError(
                'rate_limited', 'Translation provider rate limited the request',
                retryAfterMs);
        }
        if (status === 401 || status === 403) {
            throw new TranslationProviderError(
                'authentication_error', 'Translation credential was rejected');
        }
        if (status < 200 || status >= 300) {
            throw new TranslationProviderError(
                'provider_error', `Translation provider returned HTTP ${status}`);
        }

        let response;
        let translated;
        try {
            response = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            translated = JSON.parse(outputText(response));
        } catch (error) {
            if (error instanceof TranslationProviderError)
                throw error;
            throw new TranslationProviderError(
                'invalid_response', 'Translation provider returned invalid JSON');
        }

        const chunkDocument = {
            lines: options.chunk.lines.map(line => ({lineId: line.id})),
        };
        try {
            return validateTranslationLines(chunkDocument, translated);
        } catch {
            throw new TranslationProviderError(
                'invalid_response', 'Translation provider returned invalid line IDs');
        }
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}

export class MockTranslationProvider {
    constructor({id = 'mock', model = 'mock-v1', delayMs = 0} = {}) {
        this.id = id;
        this.displayName = 'Mock';
        this.model = model;
        this.requiresCredential = false;
        this.delayMs = delayMs;
        this.requestCount = 0;
    }

    async translate(_document, options, cancellable) {
        this.requestCount++;
        if (this.delayMs > 0)
            await delay(this.delayMs, cancellable);
        if (cancellable?.is_cancelled())
            throw canceledError();
        return options.chunk.lines.map(line => ({
            lineId: line.id,
            text: `[${options.targetLanguage}] ${line.text}`,
        }));
    }

    destroy() {}
}
