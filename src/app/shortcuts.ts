// Single list of keyboard shortcuts, shown in the Keyboard shortcuts dialog (SPEC §5.4: shortcuts
// must be discoverable). None of them are text-editing keys, so they never clash with typing.
export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Ctrl+O', action: 'Add files' },
  { keys: 'Ctrl+Shift+O', action: 'Add a folder' },
  { keys: 'Arrow keys, Home, End', action: 'Resize the focused pane divider' },
  { keys: 'Esc', action: 'Close the open dialog' },
];
