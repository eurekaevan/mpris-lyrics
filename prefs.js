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
        const _ = this.gettext.bind(this);
        const ngettext = this.ngettext.bind(this);
        const settings = this.getSettings();
        const signalIds = [];
        const cancellable = new Gio.Cancellable();
        window.search_enabled = true;

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const panelGroup = new Adw.PreferencesGroup({title: _('Panel')});
        page.add(panelGroup);
        panelGroup.add(bindSwitch(
            settings, 'show-icon', _('Show music note icon')));
        const panelPositionRow = comboRow(
            settings,
            'panel-position',
            _('Panel position'),
            [
                {value: 'left', label: _('Left')},
                {value: 'right', label: _('Right')},
                {value: 'center', label: _('Center')},
                {value: 'far-left', label: _('Far left')},
                {value: 'far-right', label: _('Far right')},
            ]);
        panelPositionRow.subtitle =
            _('Left and Right stay near the center; Far positions use the outer edge');
        panelGroup.add(panelPositionRow);

        const widthRow = new Adw.SpinRow({
            title: _('Maximum panel width'),
            subtitle: _('Maximum width of lyrics in the top bar'),
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
            _('Hide lyrics when paused'),
            _('Keep the popup state while hiding the panel item')));

        const lyricsGroup = new Adw.PreferencesGroup({title: _('Lyrics')});
        page.add(lyricsGroup);
        lyricsGroup.add(bindSwitch(
            settings,
            'fallback-track-info',
            _('Show title when lyrics are unavailable')));
        lyricsGroup.add(bindSwitch(
            settings,
            'word-sync-enabled',
            _('Word-synced highlighting'),
            _('Highlight the current word when timing is available')));

        const globalOffsetRow = new Adw.SpinRow({
            title: _('Global lyrics offset'),
            subtitle: _('Added to each track-specific offset'),
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
            title: _('Translation'),
            description: _('Translations are aligned by lyric line and never change original timing.'),
        });
        page.add(translationGroup);
        translationGroup.add(bindSwitch(
            settings,
            'translation-enabled',
            _('Enable translation'),
            _('Original lyrics remain available if translation fails')));
        translationGroup.add(bindSwitch(
            settings,
            'auto-translate',
            _('Translate automatically'),
            _('Use a cached translation first; otherwise contact the provider')));

        const targetLanguageRow = new Adw.EntryRow({
            title: _('Target language'),
            text: settings.get_string('translation-target-language'),
        });
        targetLanguageRow.add_suffix(new Gtk.Label({
            label: _('e.g. zh-CN, en, ja'),
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
            _('Popup display'),
            [
                {value: 'bilingual', label: _('Original + Translation')},
                {value: 'original', label: _('Original only')},
                {value: 'translated', label: _('Translation only')},
            ]));
        translationGroup.add(comboRow(
            settings,
            'panel-lyrics-language',
            _('Panel lyrics'),
            [
                {value: 'original', label: _('Original')},
                {value: 'translated', label: _('Translation')},
            ]));
        const providerRow = comboRow(
            settings,
            'translation-provider',
            _('Provider'),
            [{value: 'openai', label: 'OpenAI'}]);
        translationGroup.add(providerRow);

        const credentialStore = new TranslationCredentialStore();
        const credentialRow = new Adw.ActionRow({
            title: _('Translation API key'),
            subtitle: _('Checking Secret Service…'),
        });
        const configureCredentialButton = new Gtk.Button({
            label: _('Configure'),
            valign: Gtk.Align.CENTER,
        });
        credentialRow.add_suffix(configureCredentialButton);
        translationGroup.add(credentialRow);

        const refreshCredentialStatus = async () => {
            try {
                const configured = await credentialStore.isConfigured(
                    settings.get_string('translation-provider'), cancellable);
                if (cancellable.is_cancelled())
                    return false;
                credentialRow.subtitle = configured
                    ? _('Configured in GNOME Secret Service')
                    : _('Not configured');
                return configured;
            } catch {
                if (!cancellable.is_cancelled())
                    credentialRow.subtitle = _('Secret Service unavailable');
                return false;
            }
        };
        refreshCredentialStatus();
        configureCredentialButton.connect('clicked', async () => {
            configureCredentialButton.sensitive = false;
            try {
                const configured = await refreshCredentialStatus();
                const entry = new Adw.PasswordEntryRow({
                    title: _('API key'),
                    text: '',
                });
                const dialog = new Adw.AlertDialog({
                    heading: _('Translation credential'),
                    body: configured
                        ? _('Enter a new key to replace the saved credential.')
                        : _('The key will be stored in GNOME Secret Service.'),
                    extra_child: entry,
                    close_response: 'cancel',
                    default_response: 'save',
                });
                dialog.add_response('cancel', _('Cancel'));
                if (configured) {
                    dialog.add_response('remove', _('Remove'));
                    dialog.set_response_appearance(
                        'remove', Adw.ResponseAppearance.DESTRUCTIVE);
                }
                dialog.add_response('save', _('Save'));
                dialog.set_response_appearance(
                    'save', Adw.ResponseAppearance.SUGGESTED);
                dialog.choose(window, null, async (_dialog, result) => {
                    try {
                        const response = dialog.choose_finish(result);
                        const provider = settings.get_string(
                            'translation-provider');
                        if (response === 'save')
                            await credentialStore.store(
                                provider, entry.text, cancellable);
                        else if (response === 'remove')
                            await credentialStore.clear(provider, cancellable);
                        else
                            return;
                        bumpGeneration(
                            settings, 'translation-credential-generation');
                        await refreshCredentialStatus();
                    } catch {
                        if (!cancellable.is_cancelled()) {
                            credentialRow.subtitle = _(
                                'Could not update credential in Secret Service');
                        }
                    } finally {
                        if (!cancellable.is_cancelled()) {
                            entry.text = '';
                            configureCredentialButton.sensitive = true;
                        }
                    }
                });
            } catch {
                if (!cancellable.is_cancelled()) {
                    credentialRow.subtitle = _(
                        'Could not open credential configuration');
                    configureCredentialButton.sensitive = true;
                }
            }
        });

        const playerGroup = new Adw.PreferencesGroup({
            title: _('Player'),
            description: _('Choose among currently available players from the extension popup.'),
        });
        page.add(playerGroup);
        const preferredPlayerRow = new Adw.ActionRow({
            title: _('Preferred player'),
            subtitle: settings.get_string('preferred-player') === 'auto'
                ? _('Auto')
                : settings.get_string('preferred-player'),
        });
        playerGroup.add(preferredPlayerRow);
        signalIds.push(settings.connect('changed::preferred-player', () => {
            const preferred = settings.get_string('preferred-player');
            preferredPlayerRow.subtitle = preferred === 'auto'
                ? _('Auto')
                : preferred;
        }));

        const storageGroup = new Adw.PreferencesGroup({
            title: _('Storage'),
            description: _('Cached lyrics are stored locally and expire automatically.'),
        });
        page.add(storageGroup);
        const cacheRow = new Adw.ActionRow({
            title: _('Lyrics cache'),
            subtitle: _('Positive results: 30 days; unavailable lyrics: 24 hours'),
        });
        const clearButton = new Gtk.Button({
            label: _('Clear Lyrics Cache'),
            valign: Gtk.Align.CENTER,
        });
        clearButton.add_css_class('destructive-action');
        cacheRow.add_suffix(clearButton);
        storageGroup.add(cacheRow);
        clearButton.connect('clicked', async () => {
            clearButton.sensitive = false;
            try {
                await clearLyricsCache(undefined, cancellable);
                if (cancellable.is_cancelled())
                    return;
                bumpGeneration(settings, 'cache-clear-generation');
                cacheRow.subtitle = _('Lyrics cache cleared');
            } catch (error) {
                if (!cancellable.is_cancelled()) {
                    cacheRow.subtitle = _('Could not clear cache: %s')
                        .format(error.message);
                }
            } finally {
                if (!cancellable.is_cancelled())
                    clearButton.sensitive = true;
            }
        });

        const translationCacheRow = new Adw.ActionRow({
            title: _('Translation cache'),
            subtitle: _('Checking cached translations…'),
        });
        const clearTranslationButton = new Gtk.Button({
            label: _('Clear Translation Cache'),
            valign: Gtk.Align.CENTER,
        });
        clearTranslationButton.add_css_class('destructive-action');
        translationCacheRow.add_suffix(clearTranslationButton);
        storageGroup.add(translationCacheRow);
        const updateTranslationCacheCount = async () => {
            try {
                const count = await countTranslationCache(undefined, cancellable);
                if (cancellable.is_cancelled())
                    return;
                translationCacheRow.subtitle = ngettext(
                    '%d cached song', '%d cached songs', count).format(count);
            } catch {
                if (!cancellable.is_cancelled())
                    translationCacheRow.subtitle = _('Could not inspect cache');
            }
        };
        updateTranslationCacheCount();
        clearTranslationButton.connect('clicked', async () => {
            clearTranslationButton.sensitive = false;
            try {
                await clearTranslationCache(undefined, cancellable);
                if (cancellable.is_cancelled())
                    return;
                bumpGeneration(
                    settings, 'translation-cache-clear-generation');
                translationCacheRow.subtitle = _('Translation cache cleared');
            } catch {
                if (!cancellable.is_cancelled()) {
                    translationCacheRow.subtitle = _(
                        'Could not clear translation cache');
                }
            } finally {
                if (!cancellable.is_cancelled())
                    clearTranslationButton.sensitive = true;
            }
        });

        window.connect('close-request', () => {
            cancellable.cancel();
            for (const id of signalIds)
                settings.disconnect(id);
            return false;
        });
    }
}
