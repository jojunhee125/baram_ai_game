/**
 * Whether keystrokes are currently going into a text field rather than into the game.
 *
 * Every global shortcut owner asks this one function — movement keys, the chat composer, the
 * minimap toggle, the home shortcut. A second copy of the rule is how "I typed ㅗ in chat and
 * teleported" gets in: physical key codes ignore the layout and the IME, so `KeyH` and `KeyM`
 * arrive while composing Hangul exactly as they do while walking.
 */
export function isTextEntry(node: Element | null): boolean {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLElement && node.isContentEditable)
  );
}
