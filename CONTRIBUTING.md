# Contributing

Issues and pull requests are welcome. The most useful report is a map that says something the code doesn't: give the box id, the file and line, and what the code really does.

- Tests: `npm install`, then `node --test test/*.test.mjs`. Tests that need the Python checker skip unless you run `faultline setup` and set `FAULTLINE_TOOLS` to the folder it prints.
- Tests use invented code only. Please don't paste real code from a private system into a fixture.
- Same commit, same bytes: if a change alters output, it should alter it the same way every run.
- Code that reads the user's files goes through `RootedSource` (`src/story/source.mjs`), so a link or a `..` cannot lead outside the source folder. Don't join a path from a map, answers or story file onto the source folder and read it.
- A new language needs a reader that gives the flow inside each function. A type checker or compiler index for call targets is what makes its roads solid.
