import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const ROOT_INTERFACE = 'org.mpris.MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const CALL_TIMEOUT_MS = 5000;

function unpack(value) {
    return value instanceof GLib.Variant ? value.deepUnpack() : value;
}

function unpackString(value) {
    const result = unpack(value);
    return typeof result === 'string' ? result.trim() : '';
}

function unpackNumber(value, fallback = 0) {
    const result = Number(unpack(value));
    return Number.isFinite(result) ? result : fallback;
}

function playbackRate(value) {
    const rate = unpackNumber(value, 1);
    return rate > 0 ? rate : 1;
}

function normalizeDesktopEntry(value) {
    return value.trim().toLowerCase().replace(/\.desktop$/, '');
}

export function stablePlayerId({desktopEntry = '', identity = '', busName = ''}) {
    const desktop = normalizeDesktopEntry(desktopEntry);
    if (desktop)
        return `desktop:${desktop}`;

    const normalizedIdentity = identity.trim().toLowerCase();
    if (normalizedIdentity)
        return `identity:${normalizedIdentity}`;

    const suffix = busName.startsWith(MPRIS_PREFIX)
        ? busName.slice(MPRIS_PREFIX.length)
        : busName;
    const stableSuffix = suffix.replace(/\.instance(?:[_-].*)?$/, '');
    return `bus:${stableSuffix.toLowerCase()}`;
}

export function parseMetadata(value) {
    const metadata = unpack(value) ?? {};
    const artists = unpack(metadata['xesam:artist']);
    const artist = Array.isArray(artists)
        ? artists.map(item => String(item).trim()).filter(Boolean).join(', ')
        : unpackString(metadata['xesam:artist']);

    return {
        trackId: unpackString(metadata['mpris:trackid']),
        title: unpackString(metadata['xesam:title']),
        artist,
        album: unpackString(metadata['xesam:album']),
        artUrl: unpackString(metadata['mpris:artUrl']),
        durationUs: Math.max(0, unpackNumber(metadata['mpris:length'])),
    };
}

function emptyMetadata() {
    return {
        trackId: '',
        title: '',
        artist: '',
        album: '',
        artUrl: '',
        durationUs: 0,
    };
}

function metadataKey(metadata) {
    return [
        metadata.trackId,
        metadata.title,
        metadata.artist,
        metadata.album,
        metadata.durationUs,
    ].join('\u0000');
}

export class MprisManager {
    constructor(onStateChanged, {onPlayersChanged = null} = {}) {
        this._onStateChanged = onStateChanged;
        this._onPlayersChanged = onPlayersChanged;
        this._connection = null;
        this._players = new Map();
        this._selectedName = null;
        this._dbusSignalId = 0;
        this._cancellable = null;
        this._running = false;
        this._activitySerial = 0;
        this._preferredPlayer = 'auto';
        this._playerListSignature = '';
    }

    start() {
        if (this._running)
            return;

        this._running = true;
        this._cancellable = new Gio.Cancellable();
        Gio.bus_get(
            Gio.BusType.SESSION,
            this._cancellable,
            (_source, result) => {
                let connection;
                try {
                    connection = Gio.bus_get_finish(result);
                } catch (error) {
                    if (this._running &&
                        !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`MPRIS Lyrics: could not open session bus: ${error.message}`);
                    return;
                }

                if (!this._running)
                    return;

                this._connection = connection;
                this._watchPlayers();
            });
    }

    destroy() {
        if (!this._running)
            return;

        this._running = false;
        this._cancellable?.cancel();

        if (this._connection && this._dbusSignalId) {
            this._connection.signal_unsubscribe(this._dbusSignalId);
            this._dbusSignalId = 0;
        }

        for (const player of this._players.values())
            this._unsubscribePlayer(player);

        this._players.clear();
        this._selectedName = null;
        this._connection = null;
        this._cancellable = null;
        this._onStateChanged = null;
        this._onPlayersChanged = null;
    }

    setPreferredPlayer(preferredPlayer) {
        const value = typeof preferredPlayer === 'string' && preferredPlayer
            ? preferredPlayer
            : 'auto';
        if (value === this._preferredPlayer)
            return;

        this._preferredPlayer = value;
        this._notifyStateChanged();
    }

    getPlayers() {
        return [...this._players.values()]
            .filter(player => player.ready && player.identityReady)
            .map(player => this._descriptor(player))
            .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    getPositionUs() {
        const player = this._players.get(this._selectedName);
        return player ? this._positionAt(player) : 0;
    }

    _watchPlayers() {
        this._dbusSignalId = this._connection.signal_subscribe(
            DBUS_NAME,
            DBUS_INTERFACE,
            'NameOwnerChanged',
            DBUS_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _signal, parameters) => {
                const [name, oldOwner, newOwner] = parameters.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;

                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        this._connection.call(
            DBUS_NAME,
            DBUS_PATH,
            DBUS_INTERFACE,
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE,
            CALL_TIMEOUT_MS,
            this._cancellable,
            (connection, result) => {
                let names;
                try {
                    [names] = connection.call_finish(result).deepUnpack();
                } catch (error) {
                    if (this._running &&
                        !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`MPRIS Lyrics: player discovery failed: ${error.message}`);
                    return;
                }

                if (!this._running)
                    return;

                for (const name of names) {
                    if (name.startsWith(MPRIS_PREFIX))
                        this._addPlayer(name);
                }
            });
    }

    _addPlayer(name) {
        if (!this._running || this._players.has(name))
            return;

        const now = GLib.get_monotonic_time();
        const player = {
            name,
            identity: '',
            desktopEntry: '',
            stableId: stablePlayerId({busName: name}),
            identityReady: false,
            metadata: emptyMetadata(),
            playbackStatus: 'Stopped',
            rate: 1,
            anchorPositionUs: 0,
            anchorMonotonicUs: now,
            ready: false,
            lastActivity: ++this._activitySerial,
            stateVersion: 0,
            positionRequestSerial: 0,
            propertySignalId: 0,
            seekedSignalId: 0,
        };
        this._players.set(name, player);

        player.propertySignalId = this._connection.signal_subscribe(
            name,
            PROPERTIES_INTERFACE,
            'PropertiesChanged',
            MPRIS_PATH,
            PLAYER_INTERFACE,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _signal, parameters) => {
                this._onPropertiesChanged(name, parameters);
            });

        player.seekedSignalId = this._connection.signal_subscribe(
            name,
            PLAYER_INTERFACE,
            'Seeked',
            MPRIS_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _signal, parameters) => {
                this._onSeeked(name, parameters);
            });

        this._refreshPlayer(player);
        this._refreshIdentity(player);
    }

    _removePlayer(name) {
        const player = this._players.get(name);
        if (!player)
            return;

        this._unsubscribePlayer(player);
        this._players.delete(name);
        if (this._selectedName === name)
            this._selectedName = null;
        this._notifyStateChanged();
    }

    _unsubscribePlayer(player) {
        if (!this._connection)
            return;

        if (player.propertySignalId)
            this._connection.signal_unsubscribe(player.propertySignalId);
        if (player.seekedSignalId)
            this._connection.signal_unsubscribe(player.seekedSignalId);
        player.propertySignalId = 0;
        player.seekedSignalId = 0;
    }

    _refreshPlayer(player) {
        const stateVersion = player.stateVersion;
        this._connection.call(
            player.name,
            MPRIS_PATH,
            PROPERTIES_INTERFACE,
            'GetAll',
            new GLib.Variant('(s)', [PLAYER_INTERFACE]),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            CALL_TIMEOUT_MS,
            this._cancellable,
            (connection, result) => {
                let properties;
                try {
                    [properties] = connection.call_finish(result).deepUnpack();
                } catch (error) {
                    if (this._running &&
                        this._players.get(player.name) === player &&
                        player.stateVersion === stateVersion &&
                        !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`MPRIS Lyrics: ignoring ${player.name}: ${error.message}`);
                    return;
                }

                if (!this._running || this._players.get(player.name) !== player ||
                    player.stateVersion !== stateVersion)
                    return;

                this._applyAllProperties(player, properties);
            });
    }

    _refreshIdentity(player) {
        this._connection.call(
            player.name,
            MPRIS_PATH,
            PROPERTIES_INTERFACE,
            'GetAll',
            new GLib.Variant('(s)', [ROOT_INTERFACE]),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            CALL_TIMEOUT_MS,
            this._cancellable,
            (connection, result) => {
                let properties;
                try {
                    [properties] = connection.call_finish(result).deepUnpack();
                } catch (error) {
                    if (this._running &&
                        this._players.get(player.name) === player &&
                        !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`MPRIS Lyrics: player identity unavailable for ${player.name}: ${error.message}`);
                    if (this._running && this._players.get(player.name) === player) {
                        player.identityReady = true;
                        this._notifyStateChanged();
                    }
                    return;
                }

                if (!this._running || this._players.get(player.name) !== player)
                    return;

                player.identity = unpackString(properties.Identity);
                player.desktopEntry = unpackString(properties.DesktopEntry);
                player.stableId = stablePlayerId({
                    identity: player.identity,
                    desktopEntry: player.desktopEntry,
                    busName: player.name,
                });
                player.identityReady = true;
                this._notifyStateChanged();
            });
    }

    _applyAllProperties(player, properties) {
        const now = GLib.get_monotonic_time();
        player.positionRequestSerial++;
        player.playbackStatus = unpackString(properties.PlaybackStatus) || 'Stopped';
        player.rate = playbackRate(properties.Rate);
        player.metadata = parseMetadata(properties.Metadata);
        player.anchorPositionUs = Math.max(0, unpackNumber(properties.Position));
        player.anchorMonotonicUs = now;
        player.ready = true;
        player.lastActivity = ++this._activitySerial;
        this._notifyStateChanged();

        if (!Object.hasOwn(properties, 'Position'))
            this._queryPosition(player);
    }

    _onPropertiesChanged(name, parameters) {
        const player = this._players.get(name);
        if (!player)
            return;

        const [changedInterface, changed, invalidated] = parameters.deepUnpack();
        if (changedInterface !== PLAYER_INTERFACE)
            return;

        player.stateVersion++;
        player.positionRequestSerial++;
        const now = GLib.get_monotonic_time();
        const oldPosition = this._positionAt(player, now);
        let shouldQueryPosition = false;
        let significantChange = false;

        if (Object.hasOwn(changed, 'Metadata')) {
            const oldKey = metadataKey(player.metadata);
            player.metadata = parseMetadata(changed.Metadata);
            if (metadataKey(player.metadata) !== oldKey) {
                player.anchorPositionUs = 0;
                player.anchorMonotonicUs = now;
                significantChange = true;
                shouldQueryPosition = true;
            }
        }

        if (Object.hasOwn(changed, 'PlaybackStatus')) {
            player.anchorPositionUs = oldPosition;
            player.anchorMonotonicUs = now;
            player.playbackStatus = unpackString(changed.PlaybackStatus) || 'Stopped';
            shouldQueryPosition = true;
            significantChange = true;
        }

        if (Object.hasOwn(changed, 'Rate')) {
            player.anchorPositionUs = oldPosition;
            player.anchorMonotonicUs = now;
            player.rate = playbackRate(changed.Rate);
            shouldQueryPosition = true;
        }

        if (Object.hasOwn(changed, 'Position')) {
            player.anchorPositionUs = Math.max(0, unpackNumber(changed.Position));
            player.anchorMonotonicUs = now;
            shouldQueryPosition = false;
        }

        const relevantInvalidation = invalidated.some(property =>
            ['Metadata', 'PlaybackStatus', 'Rate', 'Position'].includes(property));
        if (relevantInvalidation) {
            this._refreshPlayer(player);
            return;
        }

        player.ready = true;
        if (significantChange)
            player.lastActivity = ++this._activitySerial;
        this._notifyStateChanged();

        if (shouldQueryPosition)
            this._queryPosition(player);
    }

    _onSeeked(name, parameters) {
        const player = this._players.get(name);
        if (!player)
            return;

        const [positionUs] = parameters.deepUnpack();
        player.stateVersion++;
        player.positionRequestSerial++;
        player.anchorPositionUs = Math.max(0, Number(positionUs));
        player.anchorMonotonicUs = GLib.get_monotonic_time();
        player.lastActivity = ++this._activitySerial;
        this._notifyStateChanged();
    }

    _queryPosition(player) {
        const requestSerial = ++player.positionRequestSerial;
        this._connection.call(
            player.name,
            MPRIS_PATH,
            PROPERTIES_INTERFACE,
            'Get',
            new GLib.Variant('(ss)', [PLAYER_INTERFACE, 'Position']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            CALL_TIMEOUT_MS,
            this._cancellable,
            (connection, result) => {
                let position;
                try {
                    [position] = connection.call_finish(result).deepUnpack();
                } catch (error) {
                    if (this._running &&
                        this._players.get(player.name) === player &&
                        player.positionRequestSerial === requestSerial &&
                        !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`MPRIS Lyrics: position query failed for ${player.name}: ${error.message}`);
                    return;
                }

                if (!this._running || this._players.get(player.name) !== player ||
                    player.positionRequestSerial !== requestSerial)
                    return;

                player.anchorPositionUs = Math.max(0, unpackNumber(position));
                player.anchorMonotonicUs = GLib.get_monotonic_time();
                this._notifyStateChanged();
            });
    }

    getDelayUntilPositionUs(targetPositionUs) {
        const player = this._players.get(this._selectedName);
        if (!player || player.playbackStatus !== 'Playing')
            return null;

        const remainingUs = targetPositionUs - this._positionAt(player);
        return Math.max(0, remainingUs / player.rate / 1000);
    }

    _positionAt(player, now = GLib.get_monotonic_time()) {
        let positionUs = player.anchorPositionUs;
        if (player.playbackStatus === 'Playing') {
            const elapsedUs = Math.max(0, now - player.anchorMonotonicUs);
            positionUs += elapsedUs * player.rate;
        }

        const durationUs = player.metadata.durationUs;
        if (durationUs > 0)
            positionUs = Math.min(positionUs, durationUs);
        return Math.max(0, positionUs);
    }

    _choosePlayer() {
        const candidates = [...this._players.values()]
            .filter(player => player.ready && player.metadata.title);
        if (candidates.length === 0)
            return null;

        if (this._preferredPlayer !== 'auto') {
            const preferred = candidates.filter(player =>
                player.stableId === this._preferredPlayer);
            if (preferred.length > 0)
                return this._chooseAutomatic(preferred);
        }

        return this._chooseAutomatic(candidates);
    }

    _chooseAutomatic(candidates) {

        const playing = candidates.filter(player =>
            player.playbackStatus === 'Playing');
        if (playing.length > 0)
            return playing.sort((a, b) => b.lastActivity - a.lastActivity)[0];

        const selected = candidates.find(player => player.name === this._selectedName);
        if (selected)
            return selected;

        const paused = candidates.filter(player =>
            player.playbackStatus === 'Paused');
        const pool = paused.length > 0 ? paused : candidates;
        return pool.sort((a, b) => b.lastActivity - a.lastActivity)[0];
    }

    _descriptor(player) {
        const fallback = player.name.slice(MPRIS_PREFIX.length)
            .replace(/\.instance(?:[_-].*)?$/, '');
        return {
            busName: player.name,
            identity: player.identity,
            desktopEntry: player.desktopEntry,
            stableId: player.stableId,
            displayName: player.identity || player.desktopEntry || fallback,
            playbackStatus: player.playbackStatus,
            selected: player.name === this._selectedName,
        };
    }

    _notifyPlayersChanged() {
        if (!this._onPlayersChanged)
            return;

        const descriptors = this.getPlayers();
        const signature = JSON.stringify(descriptors);
        if (signature === this._playerListSignature)
            return;

        this._playerListSignature = signature;
        this._onPlayersChanged(descriptors);
    }

    _notifyStateChanged() {
        if (!this._running || !this._onStateChanged)
            return;

        const selected = this._choosePlayer();
        this._selectedName = selected?.name ?? null;
        this._notifyPlayersChanged();

        if (!selected) {
            this._onStateChanged(null);
            return;
        }

        this._onStateChanged({
            busName: selected.name,
            playbackStatus: selected.playbackStatus,
            positionUs: this._positionAt(selected),
            player: this._descriptor(selected),
            metadata: {...selected.metadata},
        });
    }
}
