# notes

Personal engineering notes. Markdown in `notes/` owns the content, `public/theme.css` owns the presentation, and `public/favicon.svg` owns the logo. [inkpath](https://github.com/iamrajjoshi/inkpath) generates the static site.

```bash
pnpm install
pnpm dev
```

Saving Markdown, the stylesheet, or another public asset rebuilds the site and refreshes the preview.

Use `pnpm verify` before committing. YAML frontmatter is the catalog: `order` controls the rendered sequence, while `slug` controls the clean URL. Directory and filename prefixes organize the source tree but do not override an explicit frontmatter order.

For a private publication preflight, set `NOTES_RELEASE_DENYLIST` to newline-separated literal terms before running `pnpm verify`.

`notes/INDEX.md` is the site home, and each track uses its own `INDEX.md` as the overview. Other Markdown files are individual notes. The repository-level `README.md` is only the GitHub project description.
