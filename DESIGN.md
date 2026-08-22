# Threadline design system

## Direction

Threadline is a desktop IDE for dense, long-running AI work. The interface uses stable spatial regions, compact controls, visible provenance, and restrained status accents. It avoids chat-first layouts, decorative avatars, gradients, and ornamental motion.

## Typography

- UI: Inter, 400–700
- Artifact content: Source Serif 4, 400–600
- Monospace identifiers: system monospace stack
- Dense desktop UI labels: 7–12px with high contrast and short line lengths
- Artifact body copy: 11.5–14px in narrow columns
- Artifact headings: 17–34px

The compact UI scale is intentional for this desktop-only prototype. Important controls use shape, borders, text labels, and persistent placement rather than relying on size or color alone.

## Color

- Canvas: `#F6F5F1`
- Panel: `#FBFAF7`
- Surface: `#FFFFFF`
- Ink: `#1E2422`
- Muted ink: `#68706C`
- Moss action: `#42655A`
- Blue branch: `#5C78A1`
- Orange branch: `#B86C3D`
- Amber attention: `#AD7628`

Color is never the only status signal. Every status also has text, an icon, or a shape.

## Geometry

- Cards and controls use 3–10px radii.
- Borders provide most grouping; shadows are reserved for floating overlays.
- The primary shell is a four-region CSS grid with a fixed operations tray.
- Artifact text columns remain narrow enough for scanning.

## Interaction

- All native controls have visible focus rings.
- Hover improves affordance but is never required for discovery.
- Motion is short and functional, with a reduced-motion override.
- Material actions surface a preview and produce a reversible checkpoint.
