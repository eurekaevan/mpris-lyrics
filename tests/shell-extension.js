import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'mpris-lyrics@eureka';

export async function run() {
    await Scripting.sleep(1000);

    const extension = Main.extensionManager.lookup(UUID);
    if (!extension)
        throw new Error('the extension was not discovered');

    const indicator = Main.panel.statusArea[UUID];
    if (!indicator)
        throw new Error('the extension did not create its panel indicator');
    if (indicator.visible)
        throw new Error('the indicator should be hidden without an MPRIS player');

    if (!Main.extensionManager.disableExtension(UUID))
        throw new Error('the extension could not be disabled');

    await Scripting.sleep(500);
    if (Main.panel.statusArea[UUID])
        throw new Error('disable() did not destroy the panel indicator');
}

export function finish() {
    print('GNOME Shell extension lifecycle test passed');
}
