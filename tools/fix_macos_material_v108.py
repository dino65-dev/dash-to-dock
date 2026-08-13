#!/usr/bin/env python3
from pathlib import Path

path = Path('macDockEffects.js')
text = path.read_text()
old = """        const opacity = adaptive
            ? (dark ? darkOpacity : lightOpacity)
            : fallbackOpacity;
"""
new = """        let opacity = fallbackOpacity;
        if (adaptive)
            opacity = dark ? darkOpacity : lightOpacity;
"""
count = text.count(old)
if count != 1:
    raise SystemExit(f'Expected one adaptive-opacity block, found {count}')
path.write_text(text.replace(old, new, 1))
