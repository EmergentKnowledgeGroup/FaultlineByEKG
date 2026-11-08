# The look test

The look is the product. Metrics are necessary and never sufficient: a hard gate can pass on a picture that is still wrong. Run `faultline look --page` (PNGs of the built page in `dist/shots/`) or `faultline look <chart>` (one chart from its saved layout, in `dist/png/`), open the PNGs yourself, and go through this. You do not fix a tool map's picture: if it is bad, report it.

## A tool-map page

- The page opens on the Reader: what the code is (quoted from its own words with their source, or a plain "none found"), what was read, what was not read, what is open.
- Every chart says "READ BY A PROGRAM". Nothing says an agent wrote it.
- Stages are listed largest first (by functions), and nothing says they run in that order.
- A box the tool is not sure of is dashed with a "?", and its Details panel says "Not confident" and why.
- The top bar names "How it fails" and "Where it can break" with counts. There is no whole-system map and no Regions list of a whole: the poster lists stages, and a click on a stage lists its functions.
- On a phone-sized window the poster is a plain list of stages, and a tap on a stage lists its functions.
- Box names are 11 px or more at the default view on a 1920 x 1080 window.

## Whole-system map (a map written by hand)

- Could you follow the main path with your eye? It should wrap in rows like a snake, wider than tall (aspect 1.3 to 2.2).
- Stage blocks are numbered and tinted, each in its own hue, and read as coloured districts in story order. Each carries a pill (number and name, 13 px or more) at its top-left; no name covers a box at any zoom where a box is readable.
- Hover a stage in the Regions list: its block lights up. Nothing covers the boxes.
- Failure, safety and operations stages are as present as the happy path.

## Any chart

- Pick three arrows and follow each from tail to head without losing it.
- Nothing runs through a box or under a label. No shared tracks. No diagonals.
- Return routes run around the outside, not through the middle. Endings sit at edges or corners.
- A box's text stays inside the box. Route labels are conditions in a few words, not sentences.
- Decisions look like decisions, with a labelled arrow out for each exit.

## Content, which the pictures make obvious

- Is there a stage with boxes and almost no arrows between them? Usually its roads run through other stages. Check that the hand-offs show on the chart and that the stage isn't really two things.
- A box with six or seven arrows on one side is a hub. Is it really one thing, or should it be split?
- Is the main path mostly `step` boxes? You have drawn a pipeline diagram instead of a picture of what the code does. Go back for the decisions.
- Does every loop you named show a dashed return route?

## If a picture is bad

Fix the model first: a split box, a clearer stage, a better main path. Try another seed (`faultline place <chart> --force --seed 2`). If it still fails, report it and keep the draft label. Do not hand-edit coordinates unless a person has asked you to; hand-written `layout/<chart>.json` files without the tool's stamp are never replaced, so they go stale silently.

## Put a stranger in front of it

Give a fresh reader, with no memory of the work and no access to the code, the page and these tasks. Score each 0 to 2. Fix what they could not do.

1. What does this code do, and where does a request start?
2. Trace one request from start to a successful end by eye. Name the boxes.
3. Find a decision. Name its exits and the condition on each.
4. Find every way it can fail or refuse. Which of them does a person see?
5. Find a loop. What limits it?
6. Pick a safety or failure stage. Where does the main flow enter it and leave it?
7. Pick a chart. Where did this flow come from, and where does it go next?
8. Find the whole code on one page. Light up one stage, then one loop. (On a tool map: find the poster, and list the functions of one stage.)
9. Name five of the code's own terms you learned from the map.
10. Pick a box and find exactly where it lives in the code.
11. What is switched off by default?
12. Where would you look first if this code got stuck? Why?

A reader who answers from the side panel because the picture gave them nothing is telling you something. Ask how they found each answer.
