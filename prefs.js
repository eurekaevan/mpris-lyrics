import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {clearLyricsCache} from './storage.js';

function bindSwitch(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
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
                const generation = settings.get_int('cache-clear-generation');
                settings.set_int(
                    'cache-clear-generation',
                    generation === 2_147_483_647 ? 0 : generation + 1);
                cacheRow.subtitle = 'Lyrics cache cleared';
            } catch (error) {
                cacheRow.subtitle = `Could not clear cache: ${error.message}`;
            } finally {
                clearButton.sensitive = true;
            }
        });

        window.connect('close-request', () => {
            for (const id of signalIds)
                settings.disconnect(id);
        });
    }
}
