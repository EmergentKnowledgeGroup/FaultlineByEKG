# Contributing

Issues and pull requests are welcome. The most useful report is a map that says something the code doesn't: give the box id, the file and line, and what the code really does.

- Tests: `npm install`, then `node --test test/*.test.mjs`. Tests that need the Python checker skip unless you run `faultline setup` and set `FAULTLINE_TOOLS` to the folder it prints.
- Tests use invented code only. Please don't paste real code from a private system into a fixture.
- Same commit, same bytes: if a change alters output, it should alter it the same way every run.
- A new language needs a reader that gives the flow inside each function. A type checker or compiler index for call targets is what makes its roads solid.
