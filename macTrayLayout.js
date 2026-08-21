// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

export const TRAY_GAP = 5;
export const TRAY_DIVIDER_GAP = 8;
export const TRAY_PADDING = 8;
export const TRAILING_GAP = 8;

/**
 * Canonical minimized-window tray layout.
 *
 * Native Dash allocations are used only as immutable inputs. The detached tray
 * and the trailing system section share one coordinate system, so a pre-existing
 * native gap before Trash/Show Apps is absorbed instead of being added to the
 * thumbnail width.
 */
export function computeTrayLayout({
    horizontal,
    previousRect,
    previousCenterX,
    previousCenterY,
    previewSizes,
    boundaryRect = null,
}) {
    if (!previousRect || !previewSizes?.length)
        return null;

    const previousEnd = horizontal
        ? previousRect.x + previousRect.width
        : previousRect.y + previousRect.height;
    let cursor = previousEnd + TRAY_DIVIDER_GAP + TRAY_PADDING;
    const previewRects = [];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const size of previewSizes) {
        const width = Math.max(0, size?.width ?? 0);
        const height = Math.max(0, size?.height ?? 0);
        if (!(width > 0) || !(height > 0))
            continue;

        let x;
        let y;
        if (horizontal) {
            x = cursor;
            y = previousCenterY - height / 2;
            cursor += width + TRAY_GAP;
        } else {
            x = previousCenterX - width / 2;
            y = cursor;
            cursor += height + TRAY_GAP;
        }

        const rect = {x, y, width, height};
        previewRects.push(rect);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
    }

    if (!previewRects.length)
        return null;

    const trayBounds = {minX, minY, maxX, maxY};
    let boundaryShift = 0;
    if (boundaryRect) {
        const trayEnd = horizontal ? trayBounds.maxX : trayBounds.maxY;
        const desiredBoundaryStart = trayEnd + TRAILING_GAP;
        const nativeBoundaryStart = horizontal ? boundaryRect.x : boundaryRect.y;
        boundaryShift = desiredBoundaryStart - nativeBoundaryStart;
    }

    return {previewRects, trayBounds, boundaryShift};
}

/**
 * Calculate a single fish-eye field for heterogeneous Dock items.
 *
 * `center` and `extent` are expressed on the Dock's primary axis. The caller
 * can therefore mix square app icons with rectangular window previews without
 * making either renderer understand the other's actor type.
 */
export function computeMagnificationTargets({
    items,
    pointerAxis,
    active,
    maxScale,
    radius,
}) {
    if (!items?.length)
        return [];

    const safePointer = Number.isFinite(pointerAxis) ? pointerAxis : 0;
    const safeMaxScale = Number.isFinite(maxScale)
        ? Math.max(1, maxScale)
        : 1;
    const safeRadius = Number.isFinite(radius) ? Math.max(1, radius) : 1;
    const scales = items.map(item => {
        const center = Number.isFinite(item?.center) ? item.center : 0;
        const distance = Math.abs(center - safePointer);
        let influence = 0;

        if (active && distance < safeRadius) {
            const q = Math.max(0, Math.min(1, 1 - distance / safeRadius));
            const sin = Math.sin(q * Math.PI / 2);
            influence = sin * sin;
        }

        return 1 + (safeMaxScale - 1) * influence;
    });
    const offsets = computeBalancedOffsets({
        extents: items.map(item => item?.extent),
        scales,
    });

    return scales.map((scale, index) => ({
        scale,
        offset: offsets[index],
    }));
}

/**
 * Fan scaled items out around one fixed group center.
 *
 * For every adjacent pair, the offset difference is exactly half of both
 * items' current growth. Their visual gap therefore remains equal to the base
 * layout gap at every animation frame, without maximum-size placeholder slots.
 */
export function computeBalancedOffsets({extents, scales}) {
    const count = Math.min(extents?.length ?? 0, scales?.length ?? 0);
    if (!count)
        return [];

    const growth = [];
    for (let i = 0; i < count; i++) {
        const extent = Number.isFinite(extents[i])
            ? Math.max(0, extents[i])
            : 0;
        const scale = Number.isFinite(scales[i])
            ? Math.max(1, scales[i])
            : 1;
        growth.push(extent * (scale - 1));
    }

    const totalGrowth = growth.reduce((sum, value) => sum + value, 0);
    const offsets = [];
    let leadingGrowth = 0;

    for (let i = 0; i < count; i++) {
        const trailingGrowth = totalGrowth - leadingGrowth - growth[i];
        offsets.push(0.5 * (leadingGrowth - trailingGrowth));
        leadingGrowth += growth[i];
    }

    return offsets;
}
