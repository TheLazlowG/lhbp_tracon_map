// Developer configuration.

// ---------------------------------------------------------------
// LABEL EDITOR MODE
//
// Flip this to true locally to edit waypoint label offsets
// directly on this map (drag labels, multiselect, arrow-key
// nudge, Ctrl/Cmd+S to export labelOffsets.json). Leave it false
// for the public-facing build -- there's no UI toggle for this on
// purpose, it's a developer switch only.
//
// When true:
//   - Waypoint labels render as draggable text markers instead of
//     static tooltips.
//   - Click to select a label, Shift/Ctrl/Cmd-click to add to the
//     selection, drag a rubber-band box on empty map to select
//     everything inside it.
//   - Arrow keys nudge every selected label by 1px (Shift+arrow
//     = 10px). Dragging any one selected label drags the whole
//     selection together, preserving relative positions.
//   - A small floating panel shows the dirty count and lets you
//     export the edited labelOffsets.json (only the fixes you
//     actually changed) or reset the current selection.
//
// Declared first, before anything else in this script, because
// the pane setup below (right after the map is created) needs to
// check it before the waypoint loop runs.
// ---------------------------------------------------------------
const EDITOR_MODE = false;

export { EDITOR_MODE };
