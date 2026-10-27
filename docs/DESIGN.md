# Interface decisions

Cwtch should make the film and the other person feel primary. The interface uses a system font, restrained surfaces, a single rose accent, clear labels, and light/dark colors. It does not imitate a proprietary Apple component or require Apple fonts.

The design follows the principles of clear hierarchy and appropriate feedback described in [Apple's Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) and [feedback guidance](https://developer.apple.com/design/human-interface-guidelines/feedback). Accessibility is part of the implementation, following the concerns in [Apple's accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility).

- Connection and playback readiness are different states. “Connected” never promises that the players are aligned.
- Errors stay near the affected flow. An unsuccessful create request cannot display success.
- Room naming is optional and secondary to creating an invite.
- The popup can accept an invite even when the current tab is unsupported.
- Settings explain setup and local versus shared relays before advanced details.
- Help contains technical evidence; the room shows human-readable states.
- Chat delivery is explicit, and retry is offered without claiming certainty about a failed acknowledgement.
- History retention and automatic navigation are opt-in. Date-night prompts can be hidden.
- Keyboard tabs use standard arrow/Home/End behavior, Escape closes the nonmodal panel, focus is visible, statuses have live regions, and motion respects reduced-motion preferences.
- The panel remains scrollable on short viewports and follows non-video fullscreen containers. Native video fullscreen and picture-in-picture may hide the overlay; the toolbar popup remains the recovery route.

These design choices have been inspected in the local fixture, but do not substitute for a complete screen-reader, contrast, zoom, or real-site accessibility audit.
