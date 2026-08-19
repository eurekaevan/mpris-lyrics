import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MprisManager} from '../mpris.js';

const BUS_NAME = 'org.mpris.MediaPlayer2.EventTest';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';

const rootInterfaceXml = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const playerInterfaceXml = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
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
    for (let attempt = 0; attempt < 40; attempt++) {
        if (predicate())
            return;
        await sleep(50);
    }
    throw new Error(message);
}

function metadata(title, durationUs = 180_000_000) {
    return {
        'mpris:trackid': new GLib.Variant(
            'o', '/org/mpris/MediaPlayer2/event_test'),
        'xesam:title': new GLib.Variant('s', title),
        'xesam:artist': new GLib.Variant('as', ['Event Artist']),
        'xesam:album': new GLib.Variant('s', 'Event Album'),
        'mpris:length': new GLib.Variant('x', durationUs),
    };
}

const connection = Gio.DBus.session;
let playbackStatus = 'Paused';
let currentMetadata = metadata('Initial Track');
let positionUs = 10_000_000;
let positionGets = 0;

const implementation = {
    get Identity() {
        return 'Event Test Player';
    },

    get DesktopEntry() {
        return 'event-test';
    },

    get PlaybackStatus() {
        return playbackStatus;
    },

    // Firefox reports zero while paused. The manager must still use a
    // one-timescale local clock after PlaybackStatus changes to Playing.
    get Rate() {
        return 0;
    },

    get Metadata() {
        return currentMetadata;
    },

    get Position() {
        positionGets++;
        return positionUs;
    },
};

const exportedRoot = Gio.DBusExportedObject.wrapJSObject(
    rootInterfaceXml, implementation);
const exportedPlayer = Gio.DBusExportedObject.wrapJSObject(
    playerInterfaceXml, implementation);
exportedRoot.export(connection, MPRIS_PATH);
exportedPlayer.export(connection, MPRIS_PATH);

function requestName() {
    connection.call_sync(
        DBUS_NAME,
        DBUS_PATH,
        DBUS_INTERFACE,
        'RequestName',
        new GLib.Variant('(su)', [BUS_NAME, 0]),
        new GLib.VariantType('(u)'),
        Gio.DBusCallFlags.NONE,
        1000,
        null);
}

function releaseName() {
    connection.call_sync(
        DBUS_NAME,
        DBUS_PATH,
        DBUS_INTERFACE,
        'ReleaseName',
        new GLib.Variant('(s)', [BUS_NAME]),
        new GLib.VariantType('(u)'),
        Gio.DBusCallFlags.NONE,
        1000,
        null);
}

function propertiesChanged(changed) {
    connection.emit_signal(
        null,
        MPRIS_PATH,
        PROPERTIES_INTERFACE,
        'PropertiesChanged',
        new GLib.Variant('(sa{sv}as)', [
            PLAYER_INTERFACE,
            changed,
            [],
        ]));
}

function seeked(newPositionUs) {
    positionUs = newPositionUs;
    connection.emit_signal(
        null,
        MPRIS_PATH,
        PLAYER_INTERFACE,
        'Seeked',
        new GLib.Variant('(x)', [newPositionUs]));
}

const loop = new GLib.MainLoop(null, false);
let state = null;
let callbackCount = 0;
let players = [];
let scenarioError = null;
const manager = new MprisManager(nextState => {
    state = nextState;
    callbackCount++;
}, {
    onPlayersChanged: nextPlayers => (players = nextPlayers),
});
manager.start();

async function run() {
    await sleep(100);
    requestName();
    await waitUntil(
        () => state?.metadata.title === 'Initial Track',
        'NameOwnerChanged did not discover the new player');
    assert(state.playbackStatus === 'Paused',
        'the initial paused state was not loaded');
    assert(positionGets === 1,
        'initial discovery should read Position exactly once via GetAll');
    await waitUntil(
        () => players[0]?.stableId === 'desktop:event-test',
        'the root MPRIS identity was not exposed as a stable descriptor');

    const beforeResumeGets = positionGets;
    playbackStatus = 'Playing';
    propertiesChanged({
        PlaybackStatus: new GLib.Variant('s', playbackStatus),
    });
    await waitUntil(
        () => state?.playbackStatus === 'Playing' &&
            positionGets === beforeResumeGets + 1,
        'resume did not perform one Position recalibration');

    const playingStartUs = manager.getPositionUs();
    await sleep(650);
    const playingEndUs = manager.getPositionUs();
    assert(playingEndUs - playingStartUs > 500_000,
        'the monotonic clock did not advance while playing with Rate=0');
    assert(positionGets === beforeResumeGets + 1,
        'stable playback performed unexpected Position polling');

    positionUs = Math.round(playingEndUs);
    const beforePauseGets = positionGets;
    playbackStatus = 'Paused';
    propertiesChanged({
        PlaybackStatus: new GLib.Variant('s', playbackStatus),
    });
    await waitUntil(
        () => state?.playbackStatus === 'Paused' &&
            positionGets === beforePauseGets + 1,
        'pause did not perform one Position recalibration');
    const pausedStartUs = manager.getPositionUs();
    await sleep(300);
    assert(Math.abs(manager.getPositionUs() - pausedStartUs) < 1_000,
        'the local clock did not freeze while paused');
    assert(positionGets === beforePauseGets + 1,
        'the paused state performed unexpected Position polling');

    const beforeSeekGets = positionGets;
    seeked(90_000_000);
    await waitUntil(
        () => Math.abs(manager.getPositionUs() - 90_000_000) < 1_000,
        'the forward Seeked signal did not set the anchor');
    seeked(30_000_000);
    await waitUntil(
        () => Math.abs(manager.getPositionUs() - 30_000_000) < 1_000,
        'the backward Seeked signal did not set the anchor');
    assert(positionGets === beforeSeekGets,
        'Seeked should not cause an extra Position Get');

    const beforeMetadataGets = positionGets;
    currentMetadata = metadata('Replacement Track');
    positionUs = 0;
    propertiesChanged({
        Metadata: new GLib.Variant('a{sv}', currentMetadata),
    });
    await waitUntil(
        () => state?.metadata.title === 'Replacement Track' &&
            positionGets === beforeMetadataGets + 1,
        'Metadata change did not update the track and recalibrate Position');

    releaseName();
    await waitUntil(
        () => state === null,
        'NameOwnerChanged did not remove the vanished player');

    requestName();
    await waitUntil(
        () => state?.metadata.title === 'Replacement Track',
        'NameOwnerChanged did not rediscover the returning player');
    releaseName();
    await waitUntil(
        () => state === null,
        'the returning player was not removed cleanly');

    manager.destroy();
    const callbacksAfterDestroy = callbackCount;
    requestName();
    await sleep(200);
    assert(callbackCount === callbacksAfterDestroy,
        'destroy() left a NameOwnerChanged subscription active');
    releaseName();
}

run()
    .catch(error => (scenarioError = error))
    .finally(() => loop.quit());
loop.run();

manager.destroy();
try {
    releaseName();
} catch {
    // The name may already have been released by the successful scenario.
}
exportedRoot.unexport();
exportedPlayer.unexport();

if (scenarioError)
    throw scenarioError;

print('MPRIS event, monotonic clock, no-polling and cleanup tests passed');
