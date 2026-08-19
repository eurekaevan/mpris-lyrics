import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {TranslationCredentialStore} from './credentials.js';
import {clearLyricsCache} from './storage.js';
import {
    clearTranslationCache,
    countTranslationCache,
} from './translation-cache.js';

function bindSwitch(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function bumpGeneration(settings, key) {
    const generation = settings.get_int(key);
    settings.set_int(key, generation === 2_147_483_647
        ? 0
        : generation + 1);
}

function comboRow(settings, key, title, choices) {
    const values = choices.map(choice => choice.value);
    const selected = Math.max(0, values.indexOf(settings.get_string(key)));
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(choices.map(choice => choice.label)),
        selected,
    });
    row.connect('notify::selected', () => {
        const value = values[row.selected] ?? values[0];
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    return row;
}

export default class MprisLyricsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const signalIds = [];
        window.search_enabled = true;

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const panelGroup = new Adw.PreferencesGroup({title: 'Panel'});
        page.add(panelGroup);
        panelGroup.add(bindSwitch(
            settings, 'show-icon', 'Show music note icon'));

        const widthRow = new Adw.SpinRow({
            title: 'Maximum panel width',
            subtitle: 'Maximum width of lyrics in the top bar',
            adjustment: new Gtk.Adjustment({
                lower: 150,
                upper: 1000,
                step_increment: 10,
                page_increment: 50,
                value: settings.get_int('max-panel-width'),
            }),
            digits: 0,
        });
        panelGroup.add(widthRow);
        widthRow.connect('notify::value', () => {
            settings.set_int('max-panel-width', Math.round(widthRow.value));
        });
        signalIds.push(settings.connect('changed::max-panel-width', () => {
            const value = settings.get_int('max-panel-width');
            if (widthRow.value !== value)
                widthRow.value = value;
        }));

        panelGroup.add(bindSwitch(
            settings,
            'hide-when-paused',
            'Hide lyrics when paused',
            'Keep the popup state while hiding the panel item'));

        const lyricsGroup = new Adw.PreferencesGroup({title: 'Lyrics'});
        page.add(lyricsGroup);
        lyricsGroup.add(bindSwitch(
            settings,
            'fallback-track-info',
            'Show title when lyrics are unavailable'));
        lyricsGroup.add(bindSwitch(
            settings,
            'word-sync-enabled',
            'Word-synced highlighting',
            'Highlight the current word when timing is available'));

        const globalOffsetRow = new Adw.SpinRow({
            title: 'Global lyrics offset',
            subtitle: 'Added to each track-specific offset',
            adjustment: new Gtk.Adjustment({
                lower: -10,
                upper: 10,
                step_increment: 0.5,
                page_increment: 1,
                value: settings.get_int('global-offset-ms') / 1000,
            }),
            digits: 1,
        });
        lyricsGroup.add(globalOffsetRow);
        globalOffsetRow.connect('notify::value', () => {
            settings.set_int(
                'global-offset-ms', Math.round(globalOffsetRow.value * 1000));
        });
        signalIds.push(settings.connect('changed::global-offset-ms', () => {
            const value = settings.get_int('global-offset-ms') / 1000;
            if (globalOffsetRow.value !== value)
                globalOffsetRow.value = value;
        }));

        const translationGroup = new Adw.PreferencesGroup({
            title: 'Translation',
            description: 'Translations are aligned by lyric line and never change original timing.',
        });
        page.add(translationGroup);
        translationGroup.add(bindSwitch(
            settings,
            'translation-enabled',
            'Enable translation',
            'Original lyrics remain available if translation fails'));
        translationGroup.add(bindSwitch(
            settings,
            'auto-translate',
            'Translate automatically',
            'Use a cached translation first; otherwise contact the provider'));

        const targetLanguageRow = new Adw.EntryRow({
            title: 'Target language',
            text: settings.get_string('translation-target-language'),
        });
        targetLanguageRow.add_suffix(new Gtk.Label({
            label: 'e.g. zh-CN, en, ja',
            css_classes: ['dim-label'],
        }));
        settings.bind(
            'translation-target-language',
            targetLanguageRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT);
        translationGroup.add(targetLanguageRow);

        translationGroup.add(comboRow(
            settings,
            'translation-display-mode',
            'Popup display',
            [
                {value: 'bilingual', label: 'Original + Translation'},
                {value: 'original', label: 'Original only'},
                {value: 'translated', label: 'Translation only'},
            ]));
        translationGroup.add(comboRow(
            settings,
            'panel-lyrics-language',
            'Panel lyrics',
            [
                {value: 'original', label: 'Original'},
                {value: 'translated', label: 'Translation'},
            ]));
        const providerRow = comboRow(
            settings,
            'translation-provider',
            'Provider',
            [{value: 'openai', label: 'OpenAI'}]);
        translationGroup.add(providerRow);

        const credentialStore = new TranslationCredentialStore();
        const credentialRow = new Adw.ActionRow({
            title: 'Translation API key',
            subtitle: 'Checking Secret Service…',
        });
        const configureCredentialButton = new Gtk.Button({
            label: 'Configure',
            valign: Gtk.Align.CENTER,
        });
        credentialRow.add_suffix(configureCredentialButton);
        translationGroup.add(credentialRow);

        const refreshCredentialStatus = async () => {
            try {
                const configured = await credentialStore.isConfigured(
                    settings.get_string('translation-provider'));
                credentialRow.subtitle = configured
                    ? 'Configured in GNOME Secret Service'
                    : 'Not configured';
                return configured;
            } catch {
                credentialRow.subtitle = 'Secret Service unavailable';
                return false;
            }
        };
        refreshCredentialStatus();
        configureCredentialButton.connect('clicked', async () => {
            configureCredentialButton.sensitive = false;
            try {
                const configured = await refreshCredentialStatus();
                const entry = new Adw.PasswordEntryRow({
                    title: 'API key',
                    text: '',
                });
                const dialog = new Adw.AlertDialog({
                    heading: 'Translation credential',
                    body: configured
                        ? 'Enter a new key to replace the saved credential.'
                        : 'The key will be stored in GNOME Secret Service.',
                    extra_child: entry,
                    close_response: 'cancel',
                    default_response: 'save',
                });
                dialog.add_response('cancel', 'Cancel');
                if (configured) {
                    dialog.add_response('remove', 'Remove');
                    dialog.set_response_appearance(
                        'remove', Adw.ResponseAppearance.DESTRUCTIVE);
                }
                dialog.add_response('save', 'Save');
                dialog.set_response_appearance(
                    'save', Adw.ResponseAppearance.SUGGESTED);
                dialog.choose(window, null, async (_dialog, result) => {
                    try {
                        const response = dialog.choose_finish(result);
                        const provider = settings.get_string(
                            'translation-provider');
                        if (response === 'save')
                            await credentialStore.store(provider, entry.text);
                        else if (response === 'remove')
                            await credentialStore.clear(provider);
                        else
                            return;
                        bumpGeneration(
                            settings, 'translation-credential-generation');
                        await refreshCredentialStatus();
                    } catch {
                        credentialRow.subtitle =
                            'Could not update credential in Secret Service';
                    } finally {
                        entry.text = '';
                        configureCredentialButton.sensitive = true;
                    }
                });
            } catch {
                credentialRow.subtitle =
                    'Could not open credential configuration';
                configureCredentialButton.sensitive = true;
            }
        });

        const playerGroup = new Adw.PreferencesGroup({
            title: 'Player',
            description: 'Choose among currently available players from the extension popup.',
        });
        page.add(playerGroup);
        const preferredPlayerRow = new Adw.ActionRow({
            title: 'Preferred player',
            subtitle: settings.get_string('preferred-player') === 'auto'
                ? 'Auto'
                : settings.get_string('preferred-player'),
        });
        playerGroup.add(preferredPlayerRow);
        signalIds.push(settings.connect('changed::preferred-player', () => {
            const preferred = settings.get_string('preferred-player');
            preferredPlayerRow.subtitle = preferred === 'auto'
                ? 'Auto'
                : preferred;
        }));

        const storageGroup = new Adw.PreferencesGroup({
            title: 'Storage',
            description: 'Cached lyrics are stored locally and expire automatically.',
        });
        page.add(storageGroup);
        const cacheRow = new Adw.ActionRow({
            title: 'Lyrics cache',
            subtitle: 'Positive results: 30 days; unavailable lyrics: 24 hours',
        });
        const clearButton = new Gtk.Button({
            label: 'Clear Lyrics Cache',
            valign: Gtk.Align.CENTER,
        });
        clearButton.add_css_class('destructive-action');
        cacheRow.add_suffix(clearButton);
        storageGroup.add(cacheRow);
        clearButton.connect('clicked', async () => {
            clearButton.sensitive = false;
            try {
                await clearLyricsCache();
                bumpGeneration(settings, 'cache-clear-generation');
                cacheRow.subtitle = 'Lyrics cache cleared';
            } catch (error) {
                cacheRow.subtitle = `Could not clear cache: ${error.message}`;
            } finally {
                clearButton.sensitive = true;
            }
        });

        const translationCacheRow = new Adw.ActionRow({
            title: 'Translation cache',
            subtitle: 'Checking cached translations…',
        });
        const clearTranslationButton = new Gtk.Button({
            label: 'Clear Translation Cache',
            valign: Gtk.Align.CENTER,
        });
        clearTranslationButton.add_css_class('destructive-action');
        translationCacheRow.add_suffix(clearTranslationButton);
        storageGroup.add(translationCacheRow);
        const updateTranslationCacheCount = async () => {
            try {
                const count = await countTranslationCache();
                translationCacheRow.subtitle =
                    `${count} cached ${count === 1 ? 'song' : 'songs'}`;
            } catch {
                translationCacheRow.subtitle = 'Could not inspect cache';
            }
        };
        updateTranslationCacheCount();
        clearTranslationButton.connect('clicked', async () => {
            clearTranslationButton.sensitive = false;
            try {
                await clearTranslationCache();
                bumpGeneration(
                    settings, 'translation-cache-clear-generation');
                translationCacheRow.subtitle = 'Translation cache cleared';
            } catch {
                translationCacheRow.subtitle =
                    'Could not clear translation cache';
            } finally {
                clearTranslationButton.sensitive = true;
            }
        });

        window.connect('close-request', () => {
            for (const id of signalIds)
                settings.disconnect(id);
        });
    }
}
