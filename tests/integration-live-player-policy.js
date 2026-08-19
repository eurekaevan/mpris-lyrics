import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MprisManager} from '../mpris.js';

const FIRST_BUS_NAME = 'org.mpris.MediaPlayer2.MprisLyricsPolicyTest.instance_1';
const SECOND_BUS_NAME = 'org.mpris.MediaPlayer2.MprisLyricsPolicyTest.instance_2_777';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

const rootXml = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;
const playerXml = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <signal name="Seeked"><arg name="Position" type="x"/></signal>
  </interface>
</node>`;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function sleep(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function waitUntil(predicate, message) {
    for (let attempt = 0; attempt < 80; attempt++) {
        if (predicate())
            return;
        await sleep(50);
    }
    throw new Error(message);
}

const metadata = {
    'mpris:trackid': new GLib.Variant('o', '/mpris/lyrics/policy/test'),
    'xesam:title': new GLib.Variant('s', 'Policy Test Track'),
    'xesam:artist': new GLib.Variant('as', ['MPRIS Lyrics']),
    'xesam:album': new GLib.Variant('s', 'Phase 3'),
    'mpris:length': new GLib.Variant('x', 180_000_000),
};
const implementation = {
    get Identity() {
        return 'MPRIS Lyrics Policy Test';
    },
    get DesktopEntry() {
        return 'mpris-lyrics-policy-test';
    },
    get PlaybackStatus() {
        return 'Playing';
    },
    get Rate() {
        return 1;
    },
    get Metadata() {
        return metadata;
    },
    get Position() {
        return 10_000_000;
    },
};

const connection = Gio.DBus.session;
const rootObject = Gio.DBusExportedObject.wrapJSObject(rootXml, implementation);
const playerObject = Gio.DBusExportedObject.wrapJSObject(playerXml, implementation);
rootObject.export(connection, MPRIS_PATH);
playerObject.export(connection, MPRIS_PATH);

function requestName(name) {
    connection.call_sync(
        DBUS_NAME,
        DBUS_PATH,
        DBUS_INTERFACE,
        'RequestName',
        new GLib.Variant('(su)', [name, 0]),
        new GLib.VariantType('(u)'),
        Gio.DBusCallFlags.NONE,
        1000,
        null);
}

function releaseName(name) {
    connection.call_sync(
        DBUS_NAME,
        DBUS_PATH,
        DBUS_INTERFACE,
        'ReleaseName',
        new GLib.Variant('(s)', [name]),
        new GLib.VariantType('(u)'),
        Gio.DBusCallFlags.NONE,
        1000,
        null);
}

const loop = new GLib.MainLoop(null, false);
let state = null;
let players = [];
let scenarioError = null;
const manager = new MprisManager(
    nextState => (state = nextState),
    {onPlayersChanged: nextPlayers => (players = nextPlayers)});
manager.start();

async function run() {
    await waitUntil(
        () => players.some(player => player.stableId === 'desktop:firefox'),
        'a live Firefox MPRIS player is required for this policy test');

    requestName(FIRST_BUS_NAME);
    await waitUntil(
        () => state?.player.stableId === 'desktop:mpris-lyrics-policy-test',
        'Auto did not select the newly active second MPRIS player');

    manager.setPreferredPlayer('desktop:firefox');
    await waitUntil(
        () => state?.player.stableId === 'desktop:firefox',
        'the Firefox preference did not override Auto');

    manager.setPreferredPlayer('desktop:mpris-lyrics-policy-test');
    await waitUntil(
        () => state?.busName === FIRST_BUS_NAME,
        'the second stable player preference was not applied');

    releaseName(FIRST_BUS_NAME);
    await waitUntil(
        () => state?.player.stableId === 'desktop:firefox',
        'a vanished preferred player did not fall back to Firefox');
    assert(manager._preferredPlayer === 'desktop:mpris-lyrics-policy-test',
        'fallback must not erase the user preference');

    requestName(SECOND_BUS_NAME);
    await waitUntil(
        () => state?.busName === SECOND_BUS_NAME,
        'the preferred player did not return under a changed instance bus name');

    manager.setPreferredPlayer('auto');
    await waitUntil(
        () => state?.busName === SECOND_BUS_NAME,
        'Auto did not select the latest playing player');
    releaseName(SECOND_BUS_NAME);
}

run()
    .catch(error => (scenarioError = error))
    .finally(() => loop.quit());
loop.run();

manager.destroy();
try {
    releaseName(FIRST_BUS_NAME);
    releaseName(SECOND_BUS_NAME);
} catch {
    // The successful path already released both names.
}
rootObject.unexport();
playerObject.unexport();

if (scenarioError)
    throw scenarioError;

print('Live Firefox plus second-player preference and fallback tests passed');
