# Writing a story over a tool map

You get a list of boxes from a map a tool made. Each box has an id, a kind, the tool's own phrase and a `file:line`. You may also get the tool's list of roads, each with a `file:line`.

Your job is to say, in plain words, what the map already shows. Nothing more. The tool checks where your lines are. It does not read your words.

## Rules

1. Write only from the tool's phrase and the cited lines. If you cannot tell, write `unsure`. A guess is worse than `unsure`.
2. Never invent a name, a function, a file or a line number. Every name you write must be in the tool's phrase or in a cited line.
3. Group the boxes into parts. Give each part a title of at most 5 words and one plain sentence. Put the parts in the order a reader should read them. Leave out what does not matter.
4. For each box you keep: a title of at most 34 characters (a question if the kind is `decision`) and one sentence of at most 260 characters. Say what the tool phrase and the cited lines say, and no more.
5. Never remove, rename or reuse an id. Every id appears once.
6. Add a road only by copying a `file:line` from the tool's road list. If the list has no such line, do not add the road.
7. A condition (`when`) belongs only on a road that leaves a decision. Copy the tool's own words for that side, or write `else` for the other side. Do not write a condition on a step, a call or an exit.
8. Do not say anything is proven, verified, checked or confirmed. That is not yours to say.

## What to send back

Words only (the short job): JSON with the box ids you were given.

```json
{ "by": "<your name>", "words": { "<box id>": { "title": "...", "plain": "..." } } }
```

A story (the longer job): the model format the map tool already uses, with `stages`, `boxes` (`id`, `stage`, `kind`, `title`, `plain`, `refs`) and `routes` (`id`, `from`, `to`, `type`, `when`, `refs`). Every box and every road cites at least one `{ "path", "symbol", "line" }` copied from the list.

## What the tool does with your answer

- `story.mjs apply` takes words only. A title over 34 characters, a sentence over 260, an empty value, a control character, an unknown id, any field other than `title` and `plain`, and every road are refused one by one. Your words go beside the tool's own phrase; the tool's phrase is never overwritten, and nothing structural moves.
- `story.mjs check` refuses a story that uses an id twice, and refuses any cited path that leaves the source folder (it is never opened). Every other box and road gets a verdict from the tool map alone:
  - a road is "joined by the tool at this line", "joined by a route", "related in the code" or "no link found". That says the two cited places are joined. It says nothing about your words;
  - a box is "in a tool box", "real code, no tool box", "partly found" or "not found";
  - the kind of a box is compared with what the tool sees at the cited lines, and a condition is compared with the side of the test the tool draws, in the few ways a program can compare words.
- Your titles, sentences and conditions are carried through marked "words, not checked", with the tool's own phrase beside them.
- Nothing you write can raise a verdict. A road that stands on a road the tool is not sure of is passed on as "related in the code".
- The flagged items come back to you as a research list: read the code, cite a line, or drop the item.
