# uploads/

Drop the files you want a persona to upload **right here**, then reference them by
**bare filename**. For safety, `--upload` only accepts files inside this folder —
absolute paths and paths outside `uploads/` are rejected.

```bash
# attach uploads/id.png
crow example.com --persona=novice --task="upload my ID" --upload=id.png

# attach several from this folder
crow example.com --task="import data" --upload=a.csv,b.csv

# attach EVERYTHING in this folder
crow example.com --task="upload my documents" --upload
```

> This folder is found because it sits in the directory you run `crow` from. Without one
> here, `--upload` falls back to the uploads folder in your config directory. `crow init`
> creates this folder and writes a copy of these notes into it — the copy is generated
> from `UPLOADS_README` in `cli/commands.js`, so keep the two in sync if you edit this.

Notes:
- A `multiple` upload field receives all the files you pass; a single-file field takes
  the first and ignores the rest (logged in the report).
- Files only attach to upload dialogs opened by the agent's own click — a hidden file
  input sprung by the page itself is cancelled.
- This `README.md` and any dotfiles are ignored by `--upload` (the all-files form), so
  they're never attached.
- Everything in this folder except this README is gitignored — test files may hold
  PII, so they can't be committed by accident.
