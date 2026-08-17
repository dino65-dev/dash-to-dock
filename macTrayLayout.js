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

/** Return the minimum positive trailing shift required to remove a visual overlap. */
export function computeTrailingOverlapGuard({
    horizontal,
    previewRect,
    boundaryRect,
    minGap = 6,
}) {
    if (!previewRect || !boundaryRect)
        return 0;

    const previewEnd = horizontal
        ? previewRect.x + previewRect.width
        : previewRect.y + previewRect.height;
    const boundaryStart = horizontal ? boundaryRect.x : boundaryRect.y;
    const guard = previewEnd + Math.max(0, minGap) - boundaryStart;
    return Number.isFinite(guard) ? Math.max(0, guard) : 0;
}
