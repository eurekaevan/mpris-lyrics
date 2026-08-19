import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {programArgs} from 'system';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function descendants(widget) {
    const result = [];
    for (let child = widget.get_first_child(); child;
        child = child.get_next_sibling()) {
        result.push(child, ...descendants(child));
    }
    return result;
}

imports.package.init({
    name: 'gnome-shell',
    prefix: '/usr',
    libdir: '/usr/lib64',
});
const extensionsResource = Gio.Resource.load(
    '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
Gio.resources_register(extensionsResource);

const extensionPath = programArgs[0] ?? GLib.build_filenamev([
    GLib.get_user_data_dir(),
    'gnome-shell',
    'extensions',
    'mpris-lyrics@eureka',
]);
const metadataPath = GLib.build_filenamev([extensionPath, 'metadata.json']);
const [ok, metadataContents] = GLib.file_get_contents(metadataPath);
assert(ok, 'the installed extension metadata could not be read');
const metadata = JSON.parse(new TextDecoder().decode(metadataContents));
const directory = Gio.File.new_for_path(extensionPath);

const application = new Adw.Application({
    application_id: 'org.gnome.Shell.Extensions.MprisLyricsPrefsTest',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
let scenarioError = null;

application.connect('activate', async app => {
    app.hold();
    try {
        const module = await import(directory.get_child('prefs.js').get_uri());
        const preferences = new module.default({
            ...metadata,
            dir: directory,
            path: extensionPath,
        });
        const window = new Adw.PreferencesWindow({
            application: app,
            title: metadata.name,
        });
        await preferences.fillPreferencesWindow(window);
        window.present();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 750, () => {
            try {
                assert(window.get_visible_page(),
                    'the preferences window did not provide a visible page');
                const widgets = descendants(window);
                assert(widgets.filter(widget => widget instanceof Adw.SwitchRow)
                    .length === 4,
                'preferences should contain four boolean SwitchRows');
                assert(widgets.filter(widget => widget instanceof Adw.SpinRow)
                    .length === 2,
                'preferences should contain width and global-offset SpinRows');
                print('GTK4/Libadwaita preferences window test passed');
                window.close();
                app.release();
                app.quit();
            } catch (error) {
                scenarioError = error;
                logError(error);
                app.release();
                app.quit();
            }
            return GLib.SOURCE_REMOVE;
        });
    } catch (error) {
        scenarioError = error;
        logError(error);
        app.release();
        app.quit();
    }
});

const status = application.run([]);
Gio.resources_unregister(extensionsResource);
if (scenarioError)
    throw scenarioError;
if (status !== 0)
    throw new Error(`preferences application exited with status ${status}`);
