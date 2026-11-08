# Domesday design doctrine

The product is named after the 1086 survey: commissioners went room by room, asked the same
questions everywhere, and wrote the answers into a register. The interface should feel like a
well-set register that a careful person keeps, not like a technology demo.

## The idea

**The register.** Paper and ink, ruled lines, entries with numbers, and one red: the rubric,
the red ink scribes used for headings and that Domesday uses for a person's approval. Everything
else comes from the records themselves: the room photographs, the counts, the book values.

## References (all from Awwwards)

| Reference | Award | What we take |
|---|---|---|
| [Xiloteca Trevigiana](https://www.awwwards.com/sites/xiloteca-trevigiana) | Honorable Mention, 3 Oct 2026 | The collection is the picture: a tight grid of real specimens. Our rooms are shown as a contact sheet of their own frames. |
| [From the Grid to the Page](https://www.awwwards.com/sites/the-grid-to-the-page) | Nominee, 13 Aug 2026 | Figures as readouts on dotted leaders, numbered sections, no decoration. Our walk summary is a ledger. |
| [The Shape of Intelligence](https://www.awwwards.com/sites/the-shape-of-intelligence) | Honorable Mention, 26 Sep 2026 | Big type on a pale ground with one accent. Our page titles are large serif on paper; the accent is the rubric. |
| [Welcome back / Create your workspace](https://www.awwwards.com/inspiration/welcome-back-create-your-workspace-plumeform) (Plumeform) | Awwwards Elements | One plain form, one button, help in a sentence. Our access code screen. |
| [Request Access](https://www.awwwards.com/inspiration/request-access-plnty-app) (Plnty) | Awwwards Elements | Split screen: statement on one side, the form on the other. |
| [Login Failed Animation](https://www.awwwards.com/inspiration/login-failed-animation-yo-glazy) (Yo Glazy) | Awwwards Elements | A wrong code gets a short shake and a plain sentence. |

## Colour

Tokens only (`packages/tokens`). Paper `--surface`, raised paper `--surface-raised`, ink `--text`.
The rubric `--rubric` is the only accent and is used for: approval strokes, the current step, and
section rules on the record. Status colours (not seen, moved, new, worse, better, unsafe, not
filmed) appear only where they mean that status.

## Type

Newsreader for titles and the assistant's answers (it reads like a written record). Atkinson
Hyperlegible Next for interface text. Atkinson Hyperlegible Mono only for register numbers, line
numbers, codes and figures in tables. Sentence case everywhere except table and field labels.

## Layout

Sections are separated by ink rules, not boxes. Two columns on wide screens, one on phones.
Figures sit on dotted leaders.

## The two signature pieces

- **The wall** (overview): every asset on record as a crop of its own evidence photograph, in
  walking order, with each room's number set in rubric serif. Colour means seen on this walk;
  black and white means seen on the last walk and not yet on this one. The wall fills in colour
  as the walk goes on, so progress is visible before any figure is read.
- **The scale model** (sign-in): Room 204 as an architect's white model with fine ink edges and
  its five register lines numbered above the pieces. Hovering a line lights the piece in rubric,
  and the other way round. It settles once when it appears and then moves only with the
  pointer. It is loaded only on that screen.

## The assistant

Domesday AI is labelled by name, and its answers are set as a transcript: Q. and A., the way the
survey recorded sworn answers. No orb, no glow, no gradient. What the page works out by itself
(what needs attention) is never presented as the assistant's.

## Components

- Buttons: ink fill, paper text, 2px radius, 44px or taller. Secondary actions are underlined text.
- Fields: label above, white input, rule border, 2px radius, error in a sentence below.
- Ledger rows: label, dotted leader, figure.
- Contact sheet: frames in a tight grid, number and name underneath, state in words.

## Banned

Glowing orbs, gradients, glass, grain, neon, lime, purple, pill badges, chips, eyebrow tags,
uppercase mono kickers, the italic accent word, three equal columns, bento grids, drop shadows,
looping animation (a spinner only while something is actually loading; the model settles once), shimmer text, blinking
carets, dark hero bands with grid textures, "elevate / seamless / unleash / next-gen".
