# /// script
# requires-python = ">=3.10"
# dependencies = ["svgelements==1.9.6"]
# ///
"""Flatten a third-party SVG into the shape svgRig expects.

svgRig reads geometry with regexes: it wants <path> elements with absolute
coordinates, no transforms, and a literal fill="" attribute. Most downloaded
art (Inkscape, Illustrator, DiceBear) uses nested transforms, relative path
commands, <circle>/<ellipse> eyes and fills in style="" or CSS classes. This
rewrites every visible shape as one absolute <path> with fill/stroke
attributes, arcs converted to cubics, in paint order, cropped to the
drawing and fitted into a 2432x2432 viewBox like the bundled characters.

    uv run --script agent/tools/flatten_svg.py <in.svg> <out.svg>

Gradients and patterns become their first stop colour (flat art only).
A background shape covering the canvas is dropped, as are clip paths,
masks and filters. Stroke-only shapes get a
data-fill="<stroke colour>" hint so the rig's dark-fill test can see them.
"""

import sys

from svgelements import SVG, Color, Matrix, Path, Shape, Use


def color(c, gradients) -> str:
    if c is None:
        return "none"
    if isinstance(c, Color):
        if c.value is None or c.alpha == 0:
            return "none"
        return c.hexrgb
    return "none"


SIZE = 2432  # the square viewBox the app's characters use (normalizeViewBox)


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    svg = SVG.parse(src, reify=True)
    shapes = []
    for el in svg.elements():
        if not isinstance(el, Shape) or isinstance(el, Use):
            continue
        if el.values.get("visibility") == "hidden" or el.values.get("display") == "none":
            continue
        fill = color(el.fill, None)
        stroke = color(el.stroke, None)
        if fill == "none" and stroke == "none":
            continue
        p = Path(el)
        p.reify()
        if len(p) == 0 or p.bbox() is None:
            continue
        # Drop a background shape covering the original canvas.
        bx0, by0, bx1, by1 = p.bbox()
        if svg.width and svg.height and bx1 - bx0 >= 0.95 * svg.width and by1 - by0 >= 0.95 * svg.height:
            continue
        sw = (el.implicit_stroke_width or 1) if stroke != "none" else 0
        shapes.append((p, fill, stroke, sw, el.values.get("opacity")))

    # Crop to the drawing and fit it into a centred SIZE x SIZE square, so
    # svgRig's size thresholds (fractions of the viewBox) see the figure at
    # the same scale as the bundled characters, and normalizeViewBox is a
    # no-op (it wraps content in a transform, which the regex rig can't see).
    boxes = [p.bbox() for p, *_ in shapes]
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    pad = 0.02 * max(x1 - x0, y1 - y0)
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    k = SIZE / max(x1 - x0, y1 - y0)
    tx = (SIZE - (x1 - x0) * k) / 2 - x0 * k
    ty = (SIZE - (y1 - y0) * k) / 2 - y0 * k
    fit = Matrix(f"translate({tx},{ty}) scale({k})")

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" width="1024" height="1024">']
    for p, fill, stroke, sw, op in shapes:
        p = p * fit
        p.reify()
        p.approximate_arcs_with_cubics()
        attrs = [f'd="{p.d(relative=False)}"']
        if fill == "none":
            # svgRig matches /\bfill="/, which also matches data-fill. Give
            # stroke-only shapes (line-art smiles, eye outlines) their stroke
            # colour as a hint the rig can see, without changing rendering.
            attrs.append(f'data-fill="{stroke}"')
        attrs.append(f'fill="{fill}"')
        if stroke != "none":
            attrs += [
                f'stroke="{stroke}"',
                f'stroke-width="{sw * k:.3g}"',
                'stroke-linecap="round"',
                'stroke-linejoin="round"',
            ]
        if op not in (None, "1", 1, 1.0):
            attrs.append(f'opacity="{op}"')
        out.append(f"<path {' '.join(attrs)}/>")
    out.append("</svg>")
    with open(dst, "w") as f:
        f.write("\n".join(out))
    print(f"{src}: {len(shapes)} paths -> {dst}")


if __name__ == "__main__":
    main()
