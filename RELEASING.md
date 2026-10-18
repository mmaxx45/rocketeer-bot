# Releasing

1. Confirm everything that belongs in the release is merged into `main`, and
   that the `Unreleased` section of CHANGELOG.md describes it in user terms.
2. Pick the version by semantic versioning: a new feature is a minor bump, a
   bugfix-only release is a patch bump, a breaking change to configuration,
   commands or the database schema is a major bump.
3. Date the changelog section: rename `## [Unreleased]` to
   `## [X.Y.Z] - YYYY-MM-DD`, and add a fresh empty `## [Unreleased]` above it.
4. Set the same version in `package.json`.
5. Commit on `main`: `Release vX.Y.Z`.
6. Tag and push:

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main --tags
   ```

7. Publish a GitHub Release for that tag, with the version's changelog section
   as the body:

   ```sh
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file RELEASE_NOTES.md
   ```

   or paste the section into the web UI.
8. Deploy, then check the startup log: it prints the schema version it
   migrated to, and any `Upgrade notes` from the release should match it.
