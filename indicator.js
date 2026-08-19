import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export class LyricsIndicator {
    constructor(accessibleName) {
        this.actor = new PanelMenu.Button(0.5, accessibleName, true);
        this.actor.setSensitive(false);

        this._label = new St.Label({
            style_class: 'mpris-lyrics-label',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._label.clutter_text.set_single_line_mode(true);
        this.actor.add_child(this._label);
        this.actor.hide();
    }

    setText(text) {
        if (this._label && this._label.text !== text)
            this._label.text = text;
    }

    setVisible(visible) {
        if (!this.actor)
            return;

        if (visible) {
            this.actor.container.show();
            this.actor.show();
        } else {
            this.actor.hide();
            this.actor.container.hide();
        }
    }

    destroy() {
        this.actor?.destroy();
        this.actor = null;
        this._label = null;
    }
}
