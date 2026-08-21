import assert from 'node:assert/strict';
import fs from 'node:fs';
import {URL} from 'node:url';

function read(path) {
    return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const effects = read('macDockEffects.js');
const interactions = read('macDockInteractions.js');
const thumbnails = read('macThumbnailFisheyeBase.js');
const integrity = read('macInputIntegrity.js');
const directInput = read('macDirectInputStability.js');

const frameStart = effects.indexOf('_onFrame(timeline)');
const prepare = effects.indexOf('this._prepareEffectLayout();', frameStart);
const target = effects.indexOf('this._updateTargets(pointerX, pointerY, active);',
    frameStart);
assert.ok(frameStart >= 0 && prepare > frameStart && target > prepare,
    'canonical layout must be prepared before fish-eye targets are calculated');

assert.match(effects, /computeMagnificationTargets/);
assert.match(effects, /this\._effectCenter\(item, horizontal\)/);
assert.match(effects, /layoutShift \+ item\.offset/);
assert.match(effects, /computeBalancedOffsets/);

assert.match(interactions, /renderer\._effectLayoutProvider/);
assert.match(interactions, /coupledOffsets: true/);
assert.match(interactions, /effectItem\.effectExtent/);
assert.doesNotMatch(interactions, /_shiftPaintedItem/,
    'post-paint movement must not return');
assert.doesNotMatch(interactions, /actor\.[xy] \+=/,
    'trailing actors must not be moved after target calculation');
assert.doesNotMatch(interactions, /scale_[xy]: actor\.hover/,
    'thumbnail hover must not start an independent scale animation');

assert.doesNotMatch(thumbnails, /springStep/,
    'thumbnails must not run a second spring clock');
assert.doesNotMatch(thumbnails, /computeTrailingOverlapGuard/,
    'post-paint overlap compensation must not return');
assert.doesNotMatch(thumbnails, /set_position/,
    'thumbnail scale painter must not own positions');

assert.doesNotMatch(integrity, /_withEffectiveBaseCenters/,
    'input must not feed previous-frame translations back into target centers');
assert.doesNotMatch(integrity, /_ensureTrailingSystemBoundary/,
    'input must not move Show Apps after painting');
assert.doesNotMatch(integrity, /originalUpdateTargets/,
    'input routing must not wrap the magnification solver');

assert.doesNotMatch(directInput, /_positionThumbnails\(/,
    'stable input proxies must not own visual layout');
assert.match(directInput,
    /for \(const rect of \[stableRect, transformedRect\(actor\)\]\)/,
    'thumbnail input must cover both canonical and transformed artwork');
assert.doesNotMatch(directInput, /get_double\('macos-magnification'\)/,
    'input geometry must not predict or reserve visual magnification');

console.log('macOS unified Dock architecture invariants passed');
