import assert from 'node:assert/strict';

import {
    computeBalancedOffsets,
    computeMagnificationTargets,
    computeTrayLayout,
    TRAILING_GAP
} from '../macTrayLayout.js';

const EPSILON = 1e-9;

function close(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) <= EPSILON,
        `${message}: expected ${expected}, received ${actual}`);
}

function visualGap(left, right, leftScale, rightScale,
    leftOffset, rightOffset) {
    const leftEdge = left.center + leftOffset + left.extent * leftScale / 2;
    const rightEdge = right.center + rightOffset - right.extent * rightScale / 2;
    return rightEdge - leftEdge;
}

function baseGap(left, right) {
    return right.center - right.extent / 2 -
        (left.center + left.extent / 2);
}

function assertGapsPreserved(items, scales, offsets, label) {
    for (let i = 0; i < items.length - 1; i++) {
        close(
            visualGap(items[i], items[i + 1], scales[i], scales[i + 1],
                offsets[i], offsets[i + 1]),
            baseGap(items[i], items[i + 1]),
            `${label}, gap ${i}`);
    }
}

function testCanonicalTrayLayout() {
    for (const count of [1, 2, 3, 5]) {
        for (const nativeBoundaryX of [500, 550, 700]) {
            const previewSizes = Array.from({length: count}, (_, i) => ({
                width: 42 + i * 7,
                height: 32,
            }));
            const layout = computeTrayLayout({
                horizontal: true,
                previousRect: {x: 400, y: 30, width: 48, height: 48},
                previousCenterX: 424,
                previousCenterY: 54,
                previewSizes,
                boundaryRect: {
                    x: nativeBoundaryX,
                    y: 30,
                    width: 48,
                    height: 48,
                },
            });

            close(nativeBoundaryX + layout.boundaryShift,
                layout.trayBounds.maxX + TRAILING_GAP,
                `${count} previews, native boundary ${nativeBoundaryX}`);
        }
    }

    const negative = computeTrayLayout({
        horizontal: true,
        previousRect: {x: 400, y: 30, width: 48, height: 48},
        previousCenterX: 424,
        previousCenterY: 54,
        previewSizes: [{width: 42, height: 32}],
        boundaryRect: {x: 700, y: 30, width: 48, height: 48},
    });
    assert.ok(negative.boundaryShift < 0,
        'an oversized native gap must be absorbed');

    const vertical = computeTrayLayout({
        horizontal: false,
        previousRect: {x: 20, y: 300, width: 48, height: 48},
        previousCenterX: 44,
        previousCenterY: 324,
        previewSizes: [{width: 32, height: 55}, {width: 32, height: 61}],
        boundaryRect: {x: 20, y: 520, width: 48, height: 48},
    });
    close(520 + vertical.boundaryShift,
        vertical.trayBounds.maxY + TRAILING_GAP,
        'vertical boundary');
}

function testUnifiedTargetField() {
    const items = [
        {kind: 'app', center: 100, extent: 48},
        {kind: 'app', center: 153, extent: 48},
        {kind: 'thumbnail', center: 220, extent: 54},
        {kind: 'thumbnail', center: 285.5, extent: 67},
        {kind: 'trash', center: 351, extent: 48},
        {kind: 'show-apps', center: 404, extent: 48},
    ];

    const inactive = computeMagnificationTargets({
        items,
        pointerAxis: 220,
        active: false,
        maxScale: 2.25,
        radius: 360,
    });
    assert.deepEqual(inactive.map(target => target.scale),
        items.map(() => 1));
    assert.deepEqual(inactive.map(target => target.offset),
        items.map(() => 0));

    for (const maxScale of [1, 1.4, 1.85, 2.25]) {
        for (const radius of [48, 150, 360]) {
            for (const pointerAxis of items.map(item => item.center)) {
                const targets = computeMagnificationTargets({
                    items,
                    pointerAxis,
                    active: true,
                    maxScale,
                    radius,
                });
                const scales = targets.map(target => target.scale);
                const offsets = targets.map(target => target.offset);

                for (const scale of scales) {
                    assert.ok(scale >= 1 - EPSILON &&
                        scale <= maxScale + EPSILON,
                    `scale ${scale} must stay inside [1, ${maxScale}]`);
                }
                assertGapsPreserved(items, scales, offsets,
                    `target field at ${pointerAxis}/${maxScale}/${radius}`);
            }
        }
    }
}

function testEverySpringFramePreservesGaps() {
    const items = [
        {center: 100, extent: 48},
        {center: 165, extent: 52},
        {center: 229.5, extent: 67},
        {center: 292, extent: 48},
    ];
    const frames = [
        [1, 1, 1, 1],
        [1.03, 1.22, 1.61, 1.09],
        [1.25, 1.85, 2.25, 1.42],
        [1.01, 1.08, 1.12, 1.04],
    ];

    for (const scales of frames) {
        const offsets = computeBalancedOffsets({
            extents: items.map(item => item.extent),
            scales,
        });
        assertGapsPreserved(items, scales, offsets,
            `integrated scales ${scales.join(',')}`);

        const growth = items.reduce((sum, item, i) =>
            sum + item.extent * (scales[i] - 1), 0);
        close(offsets[0],
            -0.5 * (growth - items[0].extent * (scales[0] - 1)),
            'leading fan-out');
        close(offsets.at(-1),
            0.5 * (growth - items.at(-1).extent * (scales.at(-1) - 1)),
            'trailing fan-out');
    }
}

function testShiftedBoundaryUsesItsVisibleCenter() {
    const items = [
        {kind: 'thumbnail', center: 200, extent: 60},
        // Native Trash used to be at 200. The tray's canonical layout moved
        // its stable influence center to 320 before target calculation.
        {kind: 'trash', center: 320, extent: 48},
    ];
    const targets = computeMagnificationTargets({
        items,
        pointerAxis: 200,
        active: true,
        maxScale: 1.85,
        radius: 80,
    });

    close(targets[0].scale, 1.85, 'preview peak scale');
    close(targets[1].scale, 1, 'shifted Trash must not magnify at old center');
    assertGapsPreserved(items,
        targets.map(target => target.scale),
        targets.map(target => target.offset),
        'shifted boundary regression');
}

function testDeterministicStressMatrix() {
    let seed = 0x5eed128;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };

    for (let scenario = 0; scenario < 500; scenario++) {
        const count = 1 + Math.floor(random() * 12);
        const items = [];
        let trailingEdge = 0;
        for (let i = 0; i < count; i++) {
            const extent = 20 + random() * 72;
            const gap = i ? random() * 24 : 0;
            const center = trailingEdge + gap + extent / 2;
            items.push({center, extent});
            trailingEdge = center + extent / 2;
        }

        const scales = items.map(() => 1 + random() * 1.25);
        const offsets = computeBalancedOffsets({
            extents: items.map(item => item.extent),
            scales,
        });
        assertGapsPreserved(items, scales, offsets,
            `stress current-scale scenario ${scenario}`);

        const baseLeft = items[0].center - items[0].extent / 2;
        const baseRight = items.at(-1).center + items.at(-1).extent / 2;
        const visualLeft = items[0].center + offsets[0] -
            items[0].extent * scales[0] / 2;
        const visualRight = items.at(-1).center + offsets.at(-1) +
            items.at(-1).extent * scales.at(-1) / 2;
        close((visualLeft + visualRight) / 2,
            (baseLeft + baseRight) / 2,
            `stress fixed envelope center ${scenario}`);

        const pointerAxis = items[Math.floor(random() * count)].center;
        const maxScale = 1 + random() * 1.25;
        const radius = 48 + random() * 312;
        const targets = computeMagnificationTargets({
            items,
            pointerAxis,
            active: true,
            maxScale,
            radius,
        });
        assertGapsPreserved(items,
            targets.map(target => target.scale),
            targets.map(target => target.offset),
            `stress target scenario ${scenario}`);
    }
}

testCanonicalTrayLayout();
testUnifiedTargetField();
testEverySpringFramePreservesGaps();
testShiftedBoundaryUsesItsVisibleCenter();
testDeterministicStressMatrix();

console.log('macOS unified Dock geometry invariants passed');
