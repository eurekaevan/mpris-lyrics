import Gio from 'gi://Gio';

import {TranslationCredentialStore} from './credentials.js';
import {TranslationDiskCache} from './translation-cache.js';
import {buildTranslationChunks} from './translation-batching.js';
import {
    createTranslationDocument,
    languagesEquivalent,
    sourceLyricsHash,
    validateTranslationLines,
} from './translation-document.js';
import {
    OpenAITranslationProvider,
    TranslationProviderError,
} from './translation-provider.js';

export const TranslationStatus = Object.freeze({
    IDLE: 'idle',
    LOADING: 'loading',
    AVAILABLE: 'available',
    NOT_CONFIGURED: 'not_configured',
    PROVIDER_UNAVAILABLE: 'provider_unavailable',
    NETWORK_ERROR: 'network_error',
    PROVIDER_ERROR: 'provider_error',
    AUTHENTICATION_ERROR: 'authentication_error',
    RATE_LIMITED: 'rate_limited',
    INVALID_RESPONSE: 'invalid_response',
    CANCELED: 'canceled',
    SAME_LANGUAGE: 'same_language',
    SKIPPED: 'skipped',
});

export class TranslationService {
    constructor({
        providers = [new OpenAITranslationProvider()],
        credentialStore = new TranslationCredentialStore(),
        cache = new TranslationDiskCache(),
        batchingOptions = {},
    } = {}) {
        this._providers = new Map(providers.map(provider =>
            [provider.id, provider]));
        this._credentialStore = credentialStore;
        this._cache = cache;
        this._batchingOptions = batchingOptions;
        this._inFlight = new Map();
        this._destroyed = false;
    }

    translate(document, {
        trackKey,
        targetLanguage,
        providerId,
        forceRefresh = false,
        allowNetwork = true,
        onStatus = null,
    }) {
        const provider = this._providers.get(providerId);
        const lyricsHash = sourceLyricsHash(document);
        const requestKey = [
            trackKey,
            lyricsHash,
            targetLanguage,
            providerId,
            provider?.model ?? '',
            allowNetwork ? 'network' : 'cache-only',
        ].join('\u0000');
        const existing = this._inFlight.get(requestKey);
        if (existing)
            return existing.promise;

        const cancellable = new Gio.Cancellable();
        const promise = this._translate(document, {
            trackKey,
            targetLanguage,
            provider,
            providerId,
            lyricsHash,
            forceRefresh,
            allowNetwork,
            onStatus,
            cancellable,
        }).finally(() => {
            const current = this._inFlight.get(requestKey);
            if (current?.promise === promise)
                this._inFlight.delete(requestKey);
        });
        this._inFlight.set(requestKey, {promise, cancellable});
        return promise;
    }

    async _translate(document, options) {
        const notify = status => {
            options.onStatus?.(status);
            return status;
        };
        if (this._destroyed || options.cancellable.is_cancelled())
            return notify({status: TranslationStatus.CANCELED});
        if (!document || document.instrumental || !options.lyricsHash ||
            !document.lines.some(line => line.text.trim()))
            return notify({status: TranslationStatus.SKIPPED});
        if (typeof options.targetLanguage !== 'string' ||
            !options.targetLanguage.trim())
            return notify({status: TranslationStatus.PROVIDER_ERROR});
        if (!options.provider)
            return notify({status: TranslationStatus.PROVIDER_UNAVAILABLE});

        const sourceLanguage = document.metadata?.language ?? 'unknown';
        if (languagesEquivalent(sourceLanguage, options.targetLanguage))
            return notify({status: TranslationStatus.SAME_LANGUAGE});

        const cacheOptions = {
            sourceLyricsHash: options.lyricsHash,
            targetLanguage: options.targetLanguage,
            provider: options.provider.id,
            model: options.provider.model,
        };
        if (!options.forceRefresh) {
            const cached = await this._cache.get(
                cacheOptions, options.trackKey, options.cancellable);
            if (cached.hit) {
                return notify({
                    status: TranslationStatus.AVAILABLE,
                    document: cached.document,
                    fromCache: true,
                });
            }
        }
        if (options.cancellable.is_cancelled())
            return notify({status: TranslationStatus.CANCELED});
        if (!options.allowNetwork)
            return notify({status: TranslationStatus.IDLE});

        notify({status: TranslationStatus.LOADING});
        let credential = null;
        try {
            if (options.provider.requiresCredential) {
                credential = await this._credentialStore.lookup(
                    options.provider.id, options.cancellable);
                if (!credential)
                    return notify({status: TranslationStatus.NOT_CONFIGURED});
            }

            const chunks = buildTranslationChunks(
                document, this._batchingOptions);
            const translatedLines = [];
            for (const chunk of chunks) {
                if (options.cancellable.is_cancelled())
                    return notify({status: TranslationStatus.CANCELED});
                const lines = await options.provider.translate(document, {
                    sourceLanguage,
                    targetLanguage: options.targetLanguage,
                    credential,
                    chunk,
                }, options.cancellable);
                let validated;
                try {
                    if (!Array.isArray(lines))
                        throw new Error('Provider lines must be an array');
                    validated = validateTranslationLines(
                        {lines: chunk.lines.map(line => ({lineId: line.id}))},
                        {lines: lines.map(line => ({
                            id: line?.lineId,
                            text: line?.text,
                        }))});
                } catch {
                    throw new TranslationProviderError(
                        'invalid_response',
                        'Translation provider returned invalid line IDs');
                }
                translatedLines.push(...validated);
            }
            if (translatedLines.length === 0)
                return notify({status: TranslationStatus.INVALID_RESPONSE});

            const translation = createTranslationDocument({
                trackKey: options.trackKey,
                sourceLyricsHash: options.lyricsHash,
                sourceLanguage,
                targetLanguage: options.targetLanguage,
                provider: options.provider.id,
                model: options.provider.model,
                lines: translatedLines,
            });
            try {
                await this._cache.put(translation);
            } catch {
                console.warn('MPRIS Lyrics: could not save translation cache');
            }
            return notify({
                status: TranslationStatus.AVAILABLE,
                document: translation,
                fromCache: false,
            });
        } catch (error) {
            if (options.cancellable.is_cancelled() ||
                error instanceof TranslationProviderError &&
                error.code === 'canceled')
                return notify({status: TranslationStatus.CANCELED});
            const known = new Set(Object.values(TranslationStatus));
            const status = error instanceof TranslationProviderError &&
                known.has(error.code)
                ? error.code
                : TranslationStatus.PROVIDER_ERROR;
            return notify({status});
        } finally {
            credential = null;
        }
    }

    cancelAll() {
        for (const {cancellable} of this._inFlight.values())
            cancellable.cancel();
    }

    async clearCache() {
        this.cancelAll();
        await this._cache.clear();
    }

    destroy() {
        this._destroyed = true;
        this.cancelAll();
        for (const provider of this._providers.values())
            provider.destroy?.();
        this._providers.clear();
    }
}
