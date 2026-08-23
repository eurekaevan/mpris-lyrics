import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MprisManager, stablePlayerId} from '../mpris.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function player({
    name,
    identity,
    desktopEntry,
    status,
    title,
    activity,
}) {
    const now = GLib.get_monotonic_time();
    return {
        name,
        identity,
        desktopEntry,
        stableId: stablePlayerId({
            busName: name,
            identity,
            desktopEntry,
        }),
        identityReady: true,
        metadata: {
            trackId: '/policy/track',
            title,
            artist: 'Policy Artist',
            album: 'Policy Album',
            durationUs: 200_000_000,
        },
        playbackStatus: status,
        rate: 1,
        anchorPositionUs: 1_000_000,
        anchorMonotonicUs: now,
        ready: true,
        lastActivity: activity,
        propertySignalId: 0,
        seekedSignalId: 0,
    };
}

assert(stablePlayerId({
    busName: 'org.mpris.MediaPlayer2.firefox.instance_1_166',
    identity: 'Firefox',
    desktopEntry: 'Firefox.desktop',
}) === 'desktop:firefox',
'desktop entry should be preferred and normalized for persistent identity');
assert(stablePlayerId({
    busName: 'org.mpris.MediaPlayer2.firefox.instance_1_999',
}) === 'bus:firefox',
'the fallback identity should remove a temporary instance suffix');

let selected = null;
let descriptors = [];
const manager = new MprisManager(
    state => (selected = state),
    {onPlayersChanged: players => (descriptors = players)});
manager._cancellable = new Gio.Cancellable();

const firefox = player({
    name: 'org.mpris.MediaPlayer2.firefox.instance_1_166',
    identity: 'Firefox',
    desktopEntry: 'firefox',
    status: 'Paused',
    title: 'Firefox Track',
    activity: 1,
});
const vlc = player({
    name: 'org.mpris.MediaPlayer2.vlc',
    identity: 'VLC media player',
    desktopEntry: 'vlc',
    status: 'Playing',
    title: 'VLC Track',
    activity: 2,
});
manager._players.set(firefox.name, firefox);
manager._players.set(vlc.name, vlc);
manager._notifyStateChanged();
assert(selected.metadata.title === 'VLC Track',
    'Auto should prefer a playing player');

manager.setPreferredPlayer('desktop:firefox');
assert(selected.metadata.title === 'Firefox Track',
    'a present preferred player should override Auto');
assert(descriptors.some(item =>
    item.stableId === 'desktop:firefox' && item.selected),
'player descriptors should expose the effective selected player');

manager._players.delete(firefox.name);
manager._selectedName = null;
manager._notifyStateChanged();
assert(selected.metadata.title === 'VLC Track' &&
    manager._preferredPlayer === 'desktop:firefox',
'a missing preference should fall back without deleting the preference');

const reopenedFirefox = player({
    name: 'org.mpris.MediaPlayer2.firefox.instance_2_501',
    identity: 'Firefox',
    desktopEntry: 'firefox',
    status: 'Paused',
    title: 'Reopened Firefox Track',
    activity: 3,
});
manager._players.set(reopenedFirefox.name, reopenedFirefox);
manager._notifyStateChanged();
assert(selected.metadata.title === 'Reopened Firefox Track' &&
    selected.busName.endsWith('instance_2_501'),
'the preferred stable identity should survive a changed instance bus name');

manager.destroy();
print('Stable player identity, Auto, preference and fallback tests passed');
