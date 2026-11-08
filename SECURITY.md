# Security

## What Faultline reads and writes

- It reads the source folder you give it with `--source`, as text. It never runs your code.
- For the purpose line it also reads the README, the package files and the docs folder inside that folder.
- It writes only into the `.faultline` folder, or the folder you give with `--project`.
- After install it uses no network. The one exception is `setup`, which downloads one file and checks its hash.

## It stays inside the source folder

A link that leads outside the source folder is skipped. A path in a map, an answers file or a story file that leaves the folder is refused. The refusal gives a one-line reason and never prints text from the file.

Version 0.1.0 did not check all of these. It could copy text from a file outside the source folder into its output (a read leak; it never ran anything). Version 0.1.1 checks them. If you have 0.1.0, update.

## A `.faultline` folder from someone else is untrusted input

A repo you clone can ship its own `.faultline` folder, and its files can say anything: paths, a source folder, digests. Do not review, build on or trust it. Delete it and run `faultline map` yourself, or map into a new folder with `--project`. Faultline refuses a project folder that holds links, since its writes would go through them.

The check `review` and `story check` make before they run is a drift check, not a tamper check. It compares the files the map read with a digest stored in the map folder. It notices a changed file. It does not notice a file added since, and a digest kept beside the thing it checks cannot show that a folder someone else gave you is honest.

## Other limits

- `status` says the page matches the stored map. It does not look at the code. Run `faultline map` again after the code changes.
- The page and the text view name the git commit that HEAD pointed at when the files were read. The files are read as they lie, so edits not yet committed are in the map and are not in that commit.

## Report a problem

Open an issue at <https://github.com/EmergentKnowledgeGroup/FaultlineByEKG/issues>. There is no email address for reports.

- Say what you ran and what you saw. Use made-up files with made-up text to show it. Do not paste real secrets or private code.
- If you think the steps should not be public yet, open an issue that says only which part is affected and that you have a security report, and leave the steps out. We will answer there.

Only the latest release is fixed.
